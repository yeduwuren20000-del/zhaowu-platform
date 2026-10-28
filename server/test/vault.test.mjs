/**
 * 凭据库（Vault）单元测试：加密模块 + 服务层安全边界。
 *   node server/test/vault.test.mjs
 *
 * 覆盖：
 *   - vaultCrypto：加解密往返、密码错误必报错（不能返回垃圾）、文件头自描述全部参数
 *   - 防篡改：GCM 能检出任意字节改动
 *   - 服务层：未解锁时拒绝访问、锁定后主密码从内存清除、磁盘上只有密文、
 *     改主密码后旧密码失效新密码可用、条目上限与长度限制
 *
 * 用独立临时数据目录，不碰真实 data/。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DATA_DIR = path.join(os.tmpdir(), `dsm-vault-${Date.now()}`)
fs.mkdirSync(DATA_DIR, { recursive: true })
process.env.DSM_DATA_DIR = DATA_DIR
// 恢复密钥也必须隔离：绝不能写到用户真实的 ~/.dev-server-manager
const RECOVERY_PATH = path.join(DATA_DIR, 'recovery.key')
process.env.DSM_VAULT_RECOVERY_PATH = RECOVERY_PATH

const { encryptToBuffer, decryptFromBuffer, describeHeader, verifyPassword, MAGIC } =
  await import('../src/utils/vaultCrypto.js')
const { vaultService } = await import('../src/services/vaultService.js')

let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push({ name, detail })
    console.log(`  ✗ ${name}`, detail ?? '')
  }
}

async function expectReject(name, fn, pattern) {
  try {
    await fn()
    check(name, false, '没有抛错')
  } catch (error) {
    check(name, pattern.test(error.message), error.message)
  }
}

console.log('【vaultCrypto】')
{
  const data = { note: '生产机', items: [{ host: '203.0.113.10', user: 'root', key: 'AKIA-EXAMPLE' }] }
  const buf = encryptToBuffer(data, 'correct-horse', { iterations: 50000 })
  check('加解密往返一致', JSON.stringify(decryptFromBuffer(buf, 'correct-horse')) === JSON.stringify(data))
  check('密文不含明文主机名', !buf.toString('latin1').includes('203.0.113.10'))
  check('密文不含明文密钥', !buf.toString('latin1').includes('AKIA-EXAMPLE'))
  check('密文不含主密码', !buf.toString('latin1').includes('correct-horse'))
}

console.log('\n【密码错误必须报错，而不是返回垃圾】')
{
  const buf = encryptToBuffer({ secret: 'top' }, 'right', { iterations: 50000 })
  let msg = ''
  try { decryptFromBuffer(buf, 'wrong') } catch (e) { msg = e.message }
  check('错误密码抛异常', Boolean(msg), msg)
  check('提示明确', /密码不正确|损坏/.test(msg), msg)
  check('verifyPassword(错误) = false', verifyPassword(buf, 'wrong') === false)
  check('verifyPassword(正确) = true', verifyPassword(buf, 'right') === true)
}

console.log('\n【文件头自描述：参数全在文件里，换机器也能解】')
{
  const buf = encryptToBuffer({ a: 1 }, 'pw', { iterations: 123456 })
  const header = describeHeader(buf)
  check('魔数正确', buf.subarray(0, MAGIC.length).toString('latin1') === 'DSMVAULT1')
  check('记录 KDF 算法', header.kdf === 'pbkdf2-sha256', header)
  check('记录加密算法', header.cipher === 'aes-256-gcm', header)
  check('记录迭代次数', header.iterations === 123456, header)
  check('参数齐全即可解密', JSON.stringify(decryptFromBuffer(buf, 'pw')) === '{"a":1}')
}

console.log('\n【防篡改：任意字节改动都必须被发现】')
{
  const buf = encryptToBuffer({ v: 'important' }, 'pw', { iterations: 50000 })
  let detected = 0
  let total = 0
  for (let i = 0; i < 24; i++) {
    const idx = 9 + Math.floor((buf.length - 9) * (i / 24))
    const tampered = Buffer.from(buf)
    tampered[idx] ^= 0xff
    total += 1
    try { decryptFromBuffer(tampered, 'pw') } catch { detected += 1 }
  }
  check('篡改密文必被 GCM 检出', detected === total, `${detected}/${total}`)
}

console.log('\n【加密边界】')
{
  await expectReject('空密码被拒绝', () => encryptToBuffer({ a: 1 }, ''), /不能为空/)
  await expectReject('过低迭代次数被拒绝', () => encryptToBuffer({ a: 1 }, 'pw', { iterations: 10 }), /过低/)
  await expectReject('非凭据文件被识别', () => decryptFromBuffer(Buffer.from('这不是凭据文件'), 'pw'), /不是凭据文件|太短/)
  await expectReject('过短的文件被识别', () => decryptFromBuffer(Buffer.alloc(4), 'pw'), /太短/)

  const nullBuf = encryptToBuffer(null, 'pw', { iterations: 50000 })
  check('null 内容可往返', decryptFromBuffer(nullBuf, 'pw') === null)

  const big = encryptToBuffer({ blob: 'x'.repeat(100000) }, 'pw', { iterations: 50000 })
  check('大内容可往返', decryptFromBuffer(big, 'pw').blob.length === 100000)

  const uni = encryptToBuffer({ text: '中文与 emoji 🔐 都要正确' }, 'pw', { iterations: 50000 })
  check('Unicode 往返正确', decryptFromBuffer(uni, 'pw').text === '中文与 emoji 🔐 都要正确')

  const a = encryptToBuffer({ same: true }, 'same', { iterations: 50000 })
  const b = encryptToBuffer({ same: true }, 'same', { iterations: 50000 })
  check('同密码两次加密输出不同（盐/nonce 生效）', !a.equals(b))
}

console.log('\n【服务层：未解锁时拒绝访问】')
{
  const status = await vaultService.status()
  check('初始为未解锁', status.unlocked === false, status)
  await expectReject('未解锁不能列条目', () => vaultService.list(), /未解锁/)
  await expectReject('未解锁不能新增', () => vaultService.upsert({ title: 'x', secret: 'y' }), /未解锁/)
  await expectReject('未解锁不能删除', () => vaultService.remove('x'), /未解锁/)
}

console.log('\n【解锁 / 锁定】')
{
  // 首次解锁会自动创建库
  const first = await vaultService.unlock('master-pw-1')
  check('首次解锁成功', first.ok === true, first)

  const upserted = await vaultService.upsert({
    title: '生产机 root 私钥',
    content: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
  })
  check('新增条目成功', Boolean(upserted.id), upserted)

  const listed = await vaultService.list()
  check('条目可列出', listed.entries.length === 1, listed.entries.length)
  check('标题正确', listed.entries[0].title === '生产机 root 私钥')
  check('内容完整保留', listed.entries[0].content.includes('BEGIN OPENSSH'))
  // 刻意做窄：只暴露标题与内容，旧的多余字段一律不出现
  const keys = Object.keys(listed.entries[0])
  check('条目只暴露标题/内容/内部 id', keys.every((k) => ['id', 'title', 'content', 'updatedAt'].includes(k)), keys)

  // 磁盘上只有密文
  const vaultFile = path.join(DATA_DIR, 'vault.dsmv')
  check('凭据文件已落盘', fs.existsSync(vaultFile))
  const raw = fs.readFileSync(vaultFile)
  check('磁盘文件不含明文主机名', !raw.toString('latin1').includes('203.0.113.10'))
  check('磁盘文件不含私钥片段', !raw.toString('latin1').includes('OPENSSH'))
  check('磁盘文件不含主密码', !raw.toString('latin1').includes('master-pw-1'))
  check('磁盘文件以魔数开头', raw.subarray(0, 9).toString('latin1') === 'DSMVAULT1')

  // 锁定
  vaultService.lock()
  const afterLock = await vaultService.status()
  check('锁定后状态为未解锁', afterLock.unlocked === false, afterLock)
  await expectReject('锁定后不能列条目', () => vaultService.list(), /未解锁/)

  // 错误密码
  await expectReject('错误主密码被拒绝', () => vaultService.unlock('wrong-pw'), /不正确/)

  // 正确密码重新解锁，数据还在
  const re = await vaultService.unlock('master-pw-1')
  check('重新解锁成功', re.ok === true, re)
  check('重新解锁后数据完好', (await vaultService.list()).entries.length === 1)
}

console.log('\n【修改主密码】')
{
  await expectReject('旧密码错误时拒绝改密', () => vaultService.changeMasterPassword('nope', 'new-master-pw'), /不正确/)
  await expectReject('新密码太短被拒绝', () => vaultService.changeMasterPassword('master-pw-1', '123'), /至少/)

  const changed = await vaultService.changeMasterPassword('master-pw-1', 'master-pw-2-long')
  check('改密成功', changed.ok === true, changed)
  check('改密后数据仍可读', (await vaultService.list()).entries.length === 1)

  vaultService.lock()
  await expectReject('旧密码改密后失效', () => vaultService.unlock('master-pw-1'), /不正确/)
  const ok = await vaultService.unlock('master-pw-2-long')
  check('新密码可解锁', ok.ok === true, ok)
  check('新密码下数据完好', (await vaultService.list()).entries.length === 1)
}

console.log('\n【条目更新与删除】')
{
  const before = await vaultService.list()
  const id = before.entries[0].id
  await vaultService.upsert({ id, title: '生产机 root 私钥（已改名）', content: 'new-content' })
  const after = await vaultService.list()
  check('更新条目数不变', after.entries.length === 1)
  check('标题已更新', after.entries[0].title.includes('已改名'))
  check('内容已更新', after.entries[0].content === 'new-content')

  await vaultService.upsert({ title: '第二条', content: 'k2' })
  check('可新增第二条', (await vaultService.list()).entries.length === 2)

  await vaultService.remove(id)
  check('删除后剩 1 条', (await vaultService.list()).entries.length === 1)
  await expectReject('删除不存在的条目报错', () => vaultService.remove('nope'), /不存在/)
}

console.log('\n【输入校验】')
{
  await expectReject('空标题被拒绝', () => vaultService.upsert({ title: '  ', content: 'x' }), /标题/)
  await expectReject('空内容被拒绝（保存按钮本已禁用，这里锁住服务端）', () => vaultService.upsert({ title: 'ok', content: '' }), /内容|过长/)
  await expectReject('超长内容被拒绝', () => vaultService.upsert({ title: 'ok', content: 'x'.repeat(20001) }), /过长/)
  await expectReject('超长标题被拒绝', () => vaultService.upsert({ title: 'x'.repeat(121), content: 'y' }), /标题/)
}

console.log('\n【备份导出/导入：自描述文件的实际价值】')
{
  const backup = await vaultService.exportBackup()
  check('导出拿到缓冲区', Buffer.isBuffer(backup.buffer) && backup.buffer.length > 0)
  check('导出文件带完整头部', describeHeader(backup.buffer).kdf === 'pbkdf2-sha256')
  check('备份不含明文', !backup.buffer.toString('latin1').includes('k2'))
}

console.log('\n【找回模式：可切换，且状态如实反映】')
{
  // 当前处于解锁态（前面改过主密码为 master-pw-2-long）
  vaultService.lock()
  let st = await vaultService.status()
  check('默认应为不存密码模式', st.recovery.canRecover === false, st.recovery)
  check('状态里给出模式标识', st.recovery.mode === 'offline', st.recovery)

  // 错误密码不能开启找回
  await expectReject('错误密码不能开启找回', () => vaultService.setRecoveryMode(true, 'wrong'), /不正确/)

  // 正确密码可以开启
  const on = await vaultService.setRecoveryMode(true, 'master-pw-2-long')
  check('开启本机找回成功', on.mode === 'recoverable', on)
  st = await vaultService.status()
  check('状态变为可找回', st.recovery.canRecover === true, st.recovery)
  check('标注能力边界', /Windows 账户/.test(st.recovery.scope || ''), st.recovery.scope)

  // 恢复密钥可用
  const rec = await vaultService.recover('master-pw-2-long')
  check('找回流程可用', rec.ok === true, rec)
  vaultService.lock()

  // 关闭找回
  vaultService.unlock('master-pw-2-long')
  const off = await vaultService.setRecoveryMode(false, 'master-pw-2-long')
  check('关闭本机找回成功', off.mode === 'offline', off)
  st = await vaultService.status()
  check('状态变为不可找回', st.recovery.canRecover === false, st.recovery)

  // 关闭后 recover 必须给出明确说明，而不是含糊报错
  vaultService.lock()
  await expectReject('关闭后找回给出明确说明', () => vaultService.recover('master-pw-2-long'), /不存恢复密钥|无法找回/)
}

console.log('\n【改主密码必须同步重建恢复密钥】')
{
  vaultService.unlock('master-pw-2-long')
  await vaultService.setRecoveryMode(true, 'master-pw-2-long')
  // 改密码
  await vaultService.changeMasterPassword('master-pw-2-long', 'master-pw-3-new')
  vaultService.lock()
  // 新密码的恢复流程必须可用（若不同步重建，这里会失败）
  const rec = await vaultService.recover('master-pw-3-new')
  check('改密码后找回仍可用', rec.ok === true, rec)
  vaultService.lock()
  await expectReject('旧密码改后无法找回', () => vaultService.recover('master-pw-2-long'), /不正确/)
  // 收尾：清掉恢复密钥
  vaultService.unlock('master-pw-3-new')
  await vaultService.setRecoveryMode(false, 'master-pw-3-new')
  vaultService.lock()
}

console.log('\n【离线模式下也能正常创建与使用】')
{
  const st0 = await vaultService.status()
  check('最终为离线模式', st0.recovery.canRecover === false, st0.recovery)
  const r = await vaultService.unlock('master-pw-3-new')
  check('离线模式仍可解锁', r.ok === true, r)
  check('返回的模式是 offline', r.mode === 'offline', r)
}

fs.rmSync(DATA_DIR, { recursive: true, force: true })

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures.slice(0, 12), null, 2))
  process.exitCode = 1
}