/**
 * 凭据库备份 / 恢复测试：
 *   node server/test/vault-backup.test.mjs
 *
 * 覆盖的核心承诺：**误删之后能回滚**。
 * 起因是一次真实事故 —— 清理测试残留时把用户刚存的凭据一起删了，
 * AES-256-GCM 不可逆、没有备份即永久丢失。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DATA_DIR = path.join(os.tmpdir(), `dsm-vaultbk-${Date.now()}`)
fs.mkdirSync(DATA_DIR, { recursive: true })
process.env.DSM_DATA_DIR = DATA_DIR
process.env.DSM_VAULT_RECOVERY_PATH = path.join(DATA_DIR, 'recovery.key')

const { vaultService } = await import('../src/services/vaultService.js')
const { decryptFromBuffer } = await import('../src/utils/vaultCrypto.js')

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

const PW = 'backup-master-pw'
const VAULT_FILE = path.join(DATA_DIR, 'vault.dsmv')

console.log('【1. 首次建库：不该产生无意义的空备份】')
{
  vaultService.lock()
  await vaultService.unlock(PW)
  const list = await vaultService.listBackups()
  check('刚建库时没有备份（无可备份内容）', list.items.length === 0, list.items)
  check('库文件已创建', fs.existsSync(VAULT_FILE))
}

console.log('\n【2. 新增条目 → 写入前自动快照】')
{
  await vaultService.upsert({ title: '生产机私钥', content: 'KEY-1' })
  const list = await vaultService.listBackups()
  check('新增后有 1 份备份', list.items.length === 1, list.items)
  check('备份文件名含来源标记 save', list.items[0].name.includes('-save'), list.items[0].name)

  // 备份存的是**覆盖前**的内容：这时主库还是空库，所以备份解出来应该是 0 条。
  // （备份就是备份，不该是"当前内容的副本"，否则它对回滚毫无意义。）
  const backupFile = path.join(DATA_DIR, 'vault-backups', list.items[0].name)
  const snapshotData = decryptFromBuffer(fs.readFileSync(backupFile), PW)
  check('备份保存的是覆盖前的内容（0 条）', snapshotData.entries.length === 0, snapshotData.entries.length)
  check('当前库有 1 条', decryptFromBuffer(fs.readFileSync(VAULT_FILE), PW).entries.length === 1)
  check('备份与当前库不是同一份内容', list.items[0].bytes !== fs.statSync(VAULT_FILE).size, {
    backup: list.items[0].bytes,
    main: fs.statSync(VAULT_FILE).size,
  })
}

console.log('\n【3. 核心承诺：误删后可回滚】')
{
  // 从当前状态往后推，不假设具体条数（测试可重复运行）
  for (const [title, content] of [['K1', 'KEY-1'], ['K2', 'KEY-2'], ['K3', 'KEY-3']]) {
    if (!(await vaultService.list()).entries.some((e) => e.content === content)) {
      await vaultService.upsert({ title, content })
    }
  }
  const before = await vaultService.list()
  check('库里有 3 条', before.entries.length === 3, before.entries.length)

  // 模拟"手滑删了主库文件"—— 这是最容易发生的误操作
  fs.rmSync(VAULT_FILE)
  check('主库文件已删除', !fs.existsSync(VAULT_FILE))

  const list = await vaultService.listBackups()
  check('备份仍在', list.items.length > 0, list.items.length)

  // 恢复：回滚到"最后一次写入之前"的状态，也就是 2 条。
  // 这是备份语义的正确表现 —— 恢复的是**过去某一刻**，不是"少了一条的现在"。
  const latest = list.items[0].name
  const snapshotOfLatest = decryptFromBuffer(fs.readFileSync(path.join(DATA_DIR, 'vault-backups', latest)), PW)
  const expectedCount = snapshotOfLatest.entries.length

  const restored = await vaultService.restoreBackup(latest)
  check('恢复成功', restored.restored === latest, restored)
  check('主库文件回来了', fs.existsSync(VAULT_FILE))

  const after = await vaultService.list()
  check(`恢复后条目与该备份一致（${expectedCount} 条）`, after.entries.length === expectedCount, {
    got: after.entries.length,
    expected: expectedCount,
  })
  check('恢复出的内容与备份逐条一致',
    JSON.stringify(after.entries.map((e) => [e.title, e.content]).sort()) ===
    JSON.stringify(snapshotOfLatest.entries.map((e) => [e.title, e.content]).sort()),
    { got: after.entries.map((e) => e.title), expected: snapshotOfLatest.entries.map((e) => e.title) })
  check('恢复后 KEY-1/KEY-2 都在（回滚只丢最后一次写入）',
    after.entries.some((e) => e.content === 'KEY-1') && after.entries.some((e) => e.content === 'KEY-2'),
    after.entries.map((e) => e.content))
}

console.log('\n【4. 恢复前也会快照当前库（恢复错了还能再回去）】')
{
  // 明确构造到"3 条"再往前推，不依赖上一节的残留状态
  const now = (await vaultService.list()).entries.length
  for (let i = now; i < 3; i++) await vaultService.upsert({ title: `补齐-${i}`, content: `PAD-${i}` })
  check('前置状态为 3 条', (await vaultService.list()).entries.length === 3, (await vaultService.list()).entries.length)

  await vaultService.upsert({ title: '第四条', content: 'KEY-4' })
  const afterWrite = await vaultService.listBackups()
  check('新增条目产生了快照', afterWrite.items.length > 0, afterWrite.items.length)

  const threeBack = afterWrite.items.find((b) => {
    const buf = fs.readFileSync(path.join(DATA_DIR, 'vault-backups', b.name))
    try { return decryptFromBuffer(buf, PW).entries.length === 3 } catch { return false }
  })
  check('能定位到写入前的 3 条备份', Boolean(threeBack), afterWrite.items.map((b) => b.name))

  if (threeBack) {
    const countBefore = afterWrite.items.length
    await vaultService.restoreBackup(threeBack.name)
    const afterRestore = await vaultService.listBackups()
    check('恢复动作本身也留了快照', afterRestore.items.length > countBefore, { before: countBefore, after: afterRestore.items.length })
    check('确实回到了 3 条', (await vaultService.list()).entries.length === 3, (await vaultService.list()).entries.length)

    // 关键：回滚掉的那一版仍然留在快照里，可以再恢复回去 —— 这才是"恢复错了还能回去"
    const hasFour = afterRestore.items.some((b) => {
      const buf = fs.readFileSync(path.join(DATA_DIR, 'vault-backups', b.name))
      try { return decryptFromBuffer(buf, PW).entries.length === 4 } catch { return false }
    })
    check('回滚掉的 4 条状态仍可从快照找回', hasFour, afterRestore.items.map((b) => b.name))
  }
}

console.log('\n【5. 手动备份 / 列出 / 恢复】')
{
  await vaultService.upsert({ title: '手动备份时的内容', content: 'MANUAL' })
  const created = await vaultService.createBackup('manual')
  check('手动备份成功', Boolean(created.name) && fs.existsSync(path.join(DATA_DIR, 'vault-backups', created.name)), created)

  const list = await vaultService.listBackups()
  check('备份列表包含手动备份', list.items.some((b) => b.name === created.name), list.items.map((b) => b.name))
  check('列表按时间倒序', list.items[0].at >= list.items[list.items.length - 1].at, list.items.map((b) => b.at))

  // 改内容后恢复回去
  await vaultService.upsert({ title: '临时改动', content: 'TEMP' })
  const before = await vaultService.list()
  check('改动后条目变多', before.entries.some((e) => e.content === 'TEMP'))

  await vaultService.restoreBackup(created.name)
  const after = await vaultService.list()
  check('恢复到手动备份时的状态', !after.entries.some((e) => e.content === 'TEMP'), after.entries.map((e) => e.content))
  check('原内容还在', after.entries.some((e) => e.content === 'MANUAL'), after.entries.map((e) => e.content))
}

console.log('\n【6. 备份名防穿越 + 坏文件防护】')
{
  await expectReject('路径穿越被拒', () => vaultService.restoreBackup('../../vault.dsmv'), /备份名不合法/)
  await expectReject('绝对路径被拒', () => vaultService.restoreBackup('C:/Windows/x.dsmv'), /备份名不合法/)
  await expectReject('不存在��备份', () => vaultService.restoreBackup('vault-nonexistent.dsmv'), /不存在/)
  await expectReject('非 dsmv 后缀被拒', () => vaultService.restoreBackup('evil.txt'), /备份名不合法/)
  await expectReject('未解锁不能恢复', async () => {
    vaultService.lock()
    return vaultService.restoreBackup('x.dsmv')
  }, /未解锁/)
  await vaultService.unlock(PW)
}

console.log('\n【7. 保留上限：不会无限增长】')
{
  const dir = path.join(DATA_DIR, 'vault-backups')
  const mainBuf = fs.readFileSync(VAULT_FILE)
  // 塞 40 份**最新**的假备份：prune 按时间倒序保留，所以这批会被优先保留，
  // 老的真备份会被挤掉，从而确定性地验证"数量被压到上限内"。
  for (let i = 0; i < 40; i++) {
    const name = `vault-2999010${String(i).padStart(2, '0')}-000000-fake-deadbe${i % 10}${Math.floor(i / 10)}.dsmv`
    const p = path.join(dir, name)
    fs.writeFileSync(p, mainBuf)
    const t = new Date(Date.now() - (40 - i) * 1000)
    fs.utimesSync(p, t, t)
  }
  const before = fs.readdirSync(dir).filter((n) => n.endsWith('.dsmv')).length
  check('塞入后超过上限', before > 20, before)

  await vaultService.upsert({ title: '触发清理', content: 'TRIM' })
  const after = fs.readdirSync(dir).filter((n) => n.endsWith('.dsmv')).length
  check('写入后自动清理到上限内', after <= 20, { before, after })
  check('确实清理掉了多余的', after < before, { before, after })
  check('本次写入的快照被保留（最新那份）', fs.readdirSync(dir).some((n) => n.includes('-save')), fs.readdirSync(dir).slice(0, 3))
}

console.log('\n【8. 备份本身也是密文（不额外泄露）】')
{
  const dir = path.join(DATA_DIR, 'vault-backups')
  const anyBackup = fs.readdirSync(dir).filter((n) => n.endsWith('.dsmv'))[0]
  const raw = fs.readFileSync(path.join(dir, anyBackup))
  check('备份以魔数开头（是密文文件）', raw.subarray(0, 9).toString('latin1') === 'DSMVAULT1', raw.subarray(0, 9).toString('latin1'))
  check('备份不含条目明文', !raw.toString('utf8').includes('生产机'), '不应出现明文')
  check('备份不含主密码', !raw.toString('latin1').includes(PW))
}

console.log('\n【9. 改主密码后，旧备份仍然可读（用新密码）】')
{
  const dir = path.join(DATA_DIR, 'vault-backups')
  // 注意：此时备份目录已在上限（上一节验证过），所以不能用"数量增加"来判断是否产生了快照，
  // 要看**有没有出现带 chpwd 标记的新文件**。
  await vaultService.changeMasterPassword(PW, 'new-master-pw-2')
  check('改密后库仍可读', (await vaultService.list()).entries.length > 0)

  const names = fs.readdirSync(dir).filter((n) => n.endsWith('.dsmv'))
  check('改密产生了快照（文件名含 chpwd）', names.some((n) => n.includes('-chpwd')), names.slice(0, 5))

  vaultService.lock()
  await expectReject('旧密码已失效', () => vaultService.unlock(PW), /不正确/)
  await vaultService.unlock('new-master-pw-2')

  // 改密前那份备份是用旧密码加密的，用新密码解不开 —— 这是预期行为，要明确报错而不是静默恢复
  const oldBackup = names.find((n) => n.includes('-before-restore') || n.includes('-save'))
  if (oldBackup) {
    await expectReject('改密前的备份无法用新密码恢复（明确报错，不静默写坏库）', () => vaultService.restoreBackup(oldBackup), /无法用当前主密码解开/)
  }
}

console.log('\n【10. 磁盘文件仍只有密文】')
{
  const raw = fs.readFileSync(VAULT_FILE)
  check('主库以魔数开头', raw.subarray(0, 9).toString('latin1') === 'DSMVAULT1')
  check('不含条目明文', !raw.toString('utf8').includes('生产机'))
  check('不含主密码', !raw.toString('latin1').includes('new-master-pw-2'))
}

vaultService.lock()
fs.rmSync(DATA_DIR, { recursive: true, force: true })

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures.slice(0, 12), null, 2))
  process.exitCode = 1
}