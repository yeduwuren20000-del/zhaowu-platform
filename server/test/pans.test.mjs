/**
 * 网盘直链的「落地」能力测试：aria2 推送 + 下载到本机。
 *   node server/test/pans.test.mjs
 *
 * 全部走本地假服务 / 注入式假子进程，不联网、不需要真实 aria2、不需要真 Python：
 *   - aria2Service：JSON-RPC 报文格式（token 前缀、options.header）、错误翻译、
 *     basename 去重、非 http 链接拒绝、以及「本机代理不该劫持回环 RPC」这条设计约束；
 *   - panDownloadService：目录校验（相对路径 / 盘符根 / Windows 目录）、进度解析、
 *     完成汇总以 pan.py 的汇总行为准、取消、并发上限与历史裁剪；
 *   - 内嵌副本契约：tools/panlink 是否仍提供工作台用到的 CLI 形状（有 Python 才跑）。
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..', '..')

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
    check(name, pattern.test(error.message), `${error.message}（期望匹配 ${pattern}）`)
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5))

// ---------------------------------------------------------------- aria2 fixture
/** 最小 aria2 JSON-RPC 假服务：认得 getVersion / addUri，可切换成异常模式 */
function startAria2({ secret = '', mode = 'ok' } = {}) {
  const calls = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      if (mode === 'html') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body>aria2 web console</body></html>')
        return
      }
      let payload = {}
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400)
        res.end('bad json')
        return
      }
      calls.push(payload)
      const params = Array.isArray(payload.params) ? payload.params : []
      if (secret) {
        if (params[0] !== `token:${secret}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, error: { code: 1, message: 'Unauthorized' } }))
          return
        }
      }
      if (payload.method === 'aria2.getVersion') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: payload.id,
          result: { version: '1.37.0', enabledFeatures: ['Async DNS', 'BitTorrent'] },
        }))
        return
      }
      if (payload.method === 'aria2.addUri') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: `gid-${calls.length}` }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, error: { code: -32601, message: 'no such method' } }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        calls,
        url: `http://127.0.0.1:${port}/jsonrpc`,
        port,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

// --------------------------------------------------------- download fake child
function makeFakeChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = () => {
    child.killed = true
    child.emit('close', null)
    return true
  }
  return child
}

function makeSpawner() {
  const calls = []
  const children = []
  const spawnFn = (command, args, options) => {
    const child = makeFakeChild()
    calls.push({ command, args, options })
    children.push(child)
    return child
  }
  return { spawnFn, calls, children }
}

const TMP = path.join(os.tmpdir(), `dsm-pans-${Date.now()}`)
fs.mkdirSync(TMP, { recursive: true })

const { normalizeRpcUrl, testConnection, pushLinks, toOutName } =
  await import('../src/services/aria2Service.js')
const { createDownloadManager, validateDownloadDir, defaultDownloadDir, normalizeOnly } =
  await import('../src/services/panDownloadService.js')

// ================================================================== aria2 服务
console.log('\n【aria2 RPC：地址与报文】')
{
  check('只填主机时自动补 /jsonrpc', normalizeRpcUrl('http://127.0.0.1:6800').toString()
    === 'http://127.0.0.1:6800/jsonrpc')
  check('留空用默认地址', normalizeRpcUrl('').toString() === 'http://127.0.0.1:6800/jsonrpc')
  check('保留自定义路径', normalizeRpcUrl('http://127.0.0.1:6800/rpc').toString()
    === 'http://127.0.0.1:6800/rpc')
  await expectReject('拒绝 ftp 协议', async () => normalizeRpcUrl('ftp://127.0.0.1/x'), /http/)
  await expectReject('拒绝乱写的地址', async () => normalizeRpcUrl('not a url'), /不合法/)

  const fixture = await startAria2({ secret: 's3cret' })
  const info = await testConnection({ rpcUrl: fixture.url, secret: 's3cret' })
  check('探活返回版本号', info.version === '1.37.0', info)
  check('密钥以 token: 前缀放在 params[0]', fixture.calls[0].params[0] === 'token:s3cret',
    fixture.calls[0].params)
  check('探活只发一次 getVersion', fixture.calls.length === 1, fixture.calls.length)
  await fixture.close()
}

console.log('\n【aria2 RPC：错误翻译成人话】')
{
  const wrongSecret = await startAria2({ secret: 'right' })
  await expectReject('密钥不对 -> 提示核对 --rpc-secret',
    async () => testConnection({ rpcUrl: wrongSecret.url, secret: 'wrong' }), /密钥/)
  await wrongSecret.close()

  const htmlMode = await startAria2({ mode: 'html' })
  await expectReject('填成了网页界面 -> 提示要 /jsonrpc',
    async () => testConnection({ rpcUrl: htmlMode.url }), /不是 JSON|jsonrpc/)
  await htmlMode.close()

  const closed = await startAria2({})
  await closed.close()
  await expectReject('端口没人听 -> 提示 aria2 没启动',
    async () => testConnection({ rpcUrl: closed.url }), /连不上/)

  // 本机若配了 HTTP_PROXY（很常见），全局 fetch 会把回环请求也塞进代理，
  // 表现为「aria2 明明活着却 502」。这里显式设置代理变量后仍必须成功，
  // 锁住「用 node:http 而不是 fetch」这个设计决定。
  const proxied = await startAria2({})
  const previousProxy = process.env.HTTP_PROXY
  process.env.HTTP_PROXY = 'http://127.0.0.1:9'
  process.env.http_proxy = 'http://127.0.0.1:9'
  try {
    const info = await testConnection({ rpcUrl: proxied.url })
    check('配了 HTTP_PROXY 也能连通回环 RPC（不经过代理）', info.version === '1.37.0', info)
  } finally {
    if (previousProxy === undefined) delete process.env.HTTP_PROXY
    else process.env.HTTP_PROXY = previousProxy
    delete process.env.http_proxy
    await proxied.close()
  }
}

console.log('\n【aria2 推送：报文与去重】')
{
  const fixture = await startAria2({ secret: 'k' })
  const result = await pushLinks({
    rpcUrl: fixture.url,
    secret: 'k',
    dir: 'D:\\Downloads\\pan',
    items: [
      { url: 'https://cdn.example.com/a/1.zip?sig=x', path: '素材/1.zip' },
      { url: 'https://cdn.example.com/b/1.zip?sig=y', path: '备份/1.zip' },
      { url: 'https://cdn.example.com/c/2.mkv?sig=z', path: '2.mkv',
        headers: { Referer: 'https://pan.quark.cn/', Cookie: 'a=b' } },
    ],
  })
  check('三条全部推送成功', result.pushed === 3 && result.failed === 0, result)
  const addCalls = fixture.calls.filter((call) => call.method === 'aria2.addUri')
  check('逐条 addUri（3 次）', addCalls.length === 3, addCalls.length)
  const outs = addCalls.map((call) => call.params[2].out)
  check('同名文件自动去重成 (2)', outs[0] === '1.zip' && outs[1] === '1 (2).zip', outs)
  check('保存目录透传给 aria2', addCalls.every((call) => call.params[2].dir === 'D:\\Downloads\\pan'))
  const withHeader = addCalls[2].params[2].header || []
  check('请求头转成 "K: V" 数组', withHeader.includes('Referer: https://pan.quark.cn/')
    && withHeader.includes('Cookie: a=b'), withHeader)
  check('直链原样传给 aria2（不去掉查询串）',
    addCalls[0].params[1][0] === 'https://cdn.example.com/a/1.zip?sig=x')
  check('返回里带 gid', result.results.every((item) => item.ok && item.gid), result.results)
  await fixture.close()

  await expectReject('空列表 -> 400', async () => pushLinks({ items: [] }), /没有可推送/)
  await expectReject('file:// 链接被拒绝',
    async () => pushLinks({ items: [{ url: 'file:///etc/passwd' }] }), /http/)
  await expectReject('空直链被拒绝',
    async () => pushLinks({ items: [{ url: '  ' }] }), /为空/)
  check('toOutName 去掉非法字符与目录',
    toOutName({ path: 'a/b:c*.txt' }) === 'b_c_.txt', toOutName({ path: 'a/b:c*.txt' }))
  check('toOutName 从 URL 兜底取名', toOutName({ url: 'https://example.com/' }) === 'example.com',
    toOutName({ url: 'https://example.com/' }))
  check('toOutName 绝不返回空串或分隔符',
    toOutName({ url: 'https://example.com' }) !== '' && !/[\\/]/.test(toOutName({ url: 'https://example.com' })),
    toOutName({ url: 'https://example.com' }))
}

console.log('\n【aria2 推送：不可用时快速收手】')
{
  const fixture = await startAria2({ secret: 'right' })
  const result = await pushLinks({
    rpcUrl: fixture.url,
    secret: 'wrong',
    items: [
      { url: 'https://x/1.zip', path: '1.zip' },
      { url: 'https://x/2.zip', path: '2.zip' },
      { url: 'https://x/3.zip', path: '3.zip' },
    ],
  })
  check('一条都没成功', result.pushed === 0 && result.failed === 3, result)
  check('第 1 条是真实错误', /密钥/.test(result.results[0].error), result.results[0])
  check('后续条目标注已中止', /已中止/.test(result.results[1].error), result.results[1])
  check('只发了 1 次 addUri（没有白试两次）',
    fixture.calls.filter((call) => call.method === 'aria2.addUri').length === 1)
  await fixture.close()
}

// ============================================================== 下载任务管理
console.log('\n【下载：目录校验】')
{
  check('默认目录在下载文件夹下', /Downloads[\\/]pan$/.test(defaultDownloadDir()), defaultDownloadDir())
  await expectReject('相对路径被拒绝', async () => validateDownloadDir('downloads'), /完整路径/)
  await expectReject('空目录被拒绝', async () => validateDownloadDir('  '), /缺少/)
  await expectReject('盘符根目录被拒绝', async () => validateDownloadDir('D:\\'), /根目录/)
  if (process.platform === 'win32') {
    // 实测过的坑："/tmp/x" 在 Windows 是"当前盘根 + tmp"，会落到意料之外的盘符
    await expectReject('无盘符的根路径被拒绝（会落到当前盘）',
      async () => validateDownloadDir('/tmp/pan'), /盘符/)
    check('UNC 共享路径可用',
      validateDownloadDir('\\\\nas\\share\\pan').endsWith('pan'),
      validateDownloadDir('\\\\nas\\share\\pan'))
    await expectReject('Windows 系统目录被拒绝',
      async () => validateDownloadDir('C:\\Windows\\Temp\\x'), /系统目录/)
  }
  await expectReject('含换行的目录被拒绝',
    async () => validateDownloadDir(`${TMP}\nbad`), /非法字符/)
  check('正常目录通过并归一化', validateDownloadDir(TMP) === path.normalize(TMP))
}

console.log('\n【下载：进度来自 pan.py 的真实输出】')
{
  const spawner = makeSpawner()
  const manager = createDownloadManager({ spawnFn: spawner.spawnFn })
  const job = manager.start({ url: 'https://pan.quark.cn/s/abc', dir: path.join(TMP, 'job1') })
  check('刚创建时是 queued 或 running',
    ['queued', 'running'].includes(job.status), job.status)
  await flush()
  const child = spawner.children[0]
  check('子进程参数含 --out / --jobs / --json',
    child !== undefined
      && spawner.calls[0].args.includes('--out')
      && spawner.calls[0].args.includes('--json')
      && spawner.calls[0].args.includes('--jobs'), spawner.calls[0]?.args)
  check('cwd 指向 panlink 工具目录', /panlink$/.test(spawner.calls[0].options.cwd),
    spawner.calls[0].options.cwd)

  child.stdout.write('开始下载到 ' + path.join(TMP, 'job1') + ' ...（3 个文件，文件间并发 3，断点续传开启）\n')
  await flush()
  check('从启动行解析出总文件数', manager.get(job.id).total === 3, manager.get(job.id).total)

  child.stderr.write('\r  素材/1.zip  1048576/5242880  20.0%')
  await flush()
  const mid = manager.get(job.id)
  check('解析字节进度', mid.bytesDone === 1048576 && mid.bytesTotal === 5242880, mid)
  check('解析百分比', Math.abs(mid.percent - 20) < 0.01, mid.percent)
  check('当前文件名来自进度行', mid.current === '素材/1.zip', mid.current)

  child.stdout.write('  ✓ 素材/1.zip\n')
  child.stdout.write('  = 素材/2.zip（已存在，跳过）\n')
  child.stdout.write('  ✗ 素材/3.zip : 404 Not Found\n')
  await flush()
  const files = manager.get(job.id).files
  check('逐条记录结果状态',
    files.length === 3 && files[0].state === 'ok' && files[1].state === 'skipped'
      && files[2].state === 'failed', files)
  check('失败条目带原因', /404/.test(files[2].error || ''), files[2])
  const running = manager.get(job.id)
  check('下载中就能看到已完成/跳过/失败数（不必等汇总行）',
    running.done === 1 && running.skipped === 1 && running.failed === 1,
    { done: running.done, skipped: running.skipped, failed: running.failed })

  child.stdout.write('下载完成: 成功 1 / 跳过 1 / 失败 1（共 3）\n')
  await flush()
  const summarized = manager.get(job.id)
  check('以汇总为准（1/1/1）',
    summarized.done === 1 && summarized.skipped === 1 && summarized.failed === 1, summarized)
  check('结束时清掉当前文件名', summarized.current === '')

  child.stdout.write('{\n  "pan": "夸克网盘",\n  "title": "我的资料",\n  "files": []\n}\n')
  child.emit('close', 2)
  await flush()
  const done = manager.get(job.id)
  check('退出码 2 = 部分成功，任务算跑完', done.status === 'done', done.status)
  check('从收尾 JSON 补上标题', done.title === '我的资料', done.title)
  check('从收尾 JSON 补上网盘名', done.pan === '夸克网盘', done.pan)
  check('完成后进度置 100', done.percent === 100, done.percent)
}

console.log('\n【下载：失败与取消】')
{
  const spawner = makeSpawner()
  const manager = createDownloadManager({ spawnFn: spawner.spawnFn })
  const bad = manager.start({ url: 'https://pan.quark.cn/s/dead', dir: path.join(TMP, 'job2') })
  await flush()
  spawner.children[0].stdout.write('错误: 分享不存在\n')
  spawner.children[0].emit('close', 3)
  await flush()
  const failed = manager.get(bad.id)
  check('退出码 3 -> error', failed.status === 'error', failed.status)
  check('错误说明提到链接失效', /失效/.test(failed.error), failed.error)

  const usage = manager.start({ url: 'https://pan.quark.cn/s/x', dir: path.join(TMP, 'job3') })
  await flush()
  spawner.children[1].emit('close', 1)
  await flush()
  check('退出码 1 -> 提示是参数问题', /前提不满足/.test(manager.get(usage.id).error),
    manager.get(usage.id).error)

  const running = manager.start({ url: 'https://pan.quark.cn/s/y', dir: path.join(TMP, 'job4') })
  await flush()
  const target = spawner.children[2]
  manager.cancel(running.id)
  check('取消会杀掉子进程', target.killed === true)
  check('取消后状态是 cancelled', manager.get(running.id).status === 'cancelled',
    manager.get(running.id).status)

  await expectReject('查不存在的任务 -> 404', async () => manager.get('nope'), /不存在/)
}

console.log('\n【下载：并发上限与排队】')
{
  const spawner = makeSpawner()
  const manager = createDownloadManager({ spawnFn: spawner.spawnFn, maxConcurrent: 1 })
  const a = manager.start({ url: 'https://pan.quark.cn/s/a', dir: path.join(TMP, 'q-a') })
  const b = manager.start({ url: 'https://pan.quark.cn/s/b', dir: path.join(TMP, 'q-b') })
  const c = manager.start({ url: 'https://pan.quark.cn/s/c', dir: path.join(TMP, 'q-c') })
  await flush()
  check('只起了 1 个子进程', spawner.children.length === 1, spawner.children.length)
  check('后两个在排队', manager.get(b.id).status === 'queued' && manager.get(c.id).status === 'queued',
    [manager.get(a.id).status, manager.get(b.id).status, manager.get(c.id).status])
  check('stats 反映并发与队列', manager.stats().active === 1 && manager.stats().queued === 2,
    manager.stats())

  spawner.children[0].emit('close', 0)
  await flush()
  await flush()
  check('前一个结束后开始下一个', spawner.children.length === 2, spawner.children.length)
  check('队列减少', manager.stats().queued === 1, manager.stats())

  const queuedCancel = manager.cancel(c.id)
  check('排队中的任务可直接取消', queuedCancel.status === 'cancelled', queuedCancel.status)
  spawner.children[1].emit('close', 0)
  await flush()
  check('取消的排队任务不会再启动', spawner.children.length === 2, spawner.children.length)
}

console.log('\n【下载：历史裁剪】')
{
  const spawner = makeSpawner()
  const manager = createDownloadManager({ spawnFn: spawner.spawnFn, keep: 2 })
  for (let i = 0; i < 5; i += 1) {
    manager.start({ url: `https://pan.quark.cn/s/${i}`, dir: path.join(TMP, `hist-${i}`) })
    await flush()
    spawner.children[spawner.children.length - 1].emit('close', 0)
    await flush()
  }
  check('历史只保留 keep 条', manager.list(50).length === 2, manager.list(50).length)
  check('保留的是最近的', manager.list(2).every((job) => job.status === 'done'))
}

// ============================================================ 选择性下载
console.log('\n【只下选中的文件：--only 透传】')
{
  const spawner = makeSpawner()
  const manager = createDownloadManager({ spawnFn: spawner.spawnFn })
  const job = manager.start({
    url: 'https://pan.quark.cn/s/x',
    dir: path.join(TMP, 'dl-only'),
    only: ['a.txt', 'sub', '   ', 'a.txt'], // 重复 + 空白项应被归一掉
  })
  const args = spawner.calls[0]?.args || []
  const at = (from = 0) => args.indexOf('--only', from)
  check('去重去空白后逐条 --only 透传',
    at() >= 0 && args[at() + 1] === 'a.txt' && at(at() + 1) >= 0
    && args[at(at() + 1) + 1] === 'sub' && at(at(at() + 1) + 1) === -1,
    args.join(' '))
  check('任务对象带 selected 计数（进度卡要显示）', job.selected === 2, job.selected)
  manager.cancel(job.id)

  const spawner2 = makeSpawner()
  const manager2 = createDownloadManager({ spawnFn: spawner2.spawnFn })
  manager2.start({ url: 'https://pan.quark.cn/s/x', dir: path.join(TMP, 'dl-all') })
  check('不传 only 时不出现 --only（整条分享，旧行为不变）',
    !(spawner2.calls[0]?.args || []).includes('--only'))
  manager2.cancel(manager2.list(1)[0].id)

  check('normalizeOnly 收单个字符串', normalizeOnly('a.txt').join() === 'a.txt')
  check('normalizeOnly 去空白/去重/丢空项',
    normalizeOnly([' a.txt ', 'a.txt', '', null, 'b/c']).join() === 'a.txt,b/c',
    normalizeOnly([' a.txt ', 'a.txt', '', null, 'b/c']))
  check('normalizeOnly  null/undefined → 空',
    normalizeOnly(null).length === 0 && normalizeOnly(undefined).length === 0)
  check('normalizeOnly 上限 2000 条（防滥用）',
    normalizeOnly(Array.from({ length: 2500 }, (_, i) => `f${i}.txt`)).length === 2000)
}

// ============================================================ 迅雷验证码回传
console.log('\n【迅雷验证码：图片回传（用户不用离开工作台）】')
{
  const python = process.env.DSM_PYTHON || 'python'
  const probe = spawnSync(python, ['-c', 'print(1)'], { encoding: 'utf8', timeout: 10000 })
  if (probe.error || probe.status !== 0) {
    console.log('  - 跳过（本机没有可用的 Python）')
  } else {
    const fakeDir = path.join(TMP, 'fake-pan')
    fs.mkdirSync(fakeDir, { recursive: true })
    // 假 pan.py：把收到的 argv 记下来，按 --captcha-png 写一张真 PNG，
    // 然后打 CAPTCHA_REQUIRED 标记并非零退出——复刻迅雷验证码失败的形状。
    const fakeOk = [
      'import os, sys',
      'args = sys.argv[1:]',
      "i = args.index('--captcha-png')",
      'png = args[i + 1]',
      "open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'argv.txt'), 'w').write(' '.join(args))",
      "os.makedirs(os.path.dirname(png), exist_ok=True)",
      "open(png, 'wb').write(b'\\x89PNG\\r\\n\\x1a\\n' + b'\\x00' * 64)",
      "sys.stderr.write('CAPTCHA_REQUIRED\\t%s\\n' % png)",
      "sys.stderr.write('\\u9519\\u8bef: \\u9700\\u8981\\u8f93\\u5165\\u56fe\\u5f62\\u9a8c\\u8bc1\\u7801\\n')",
      'sys.exit(3)',
    ].join('\n')
    fs.writeFileSync(path.join(fakeDir, 'pan.py'), fakeOk)

    const prev = process.env.DSM_PAN_DIR
    let err = null
    try {
      process.env.DSM_PAN_DIR = fakeDir
      const mod = await import(`../../server/src/services/panService.js?captcha=${Date.now()}`)
      try {
        await mod.resolveShare({ url: 'https://pan.xunlei.com/s/x' })
      } catch (e) {
        err = e
      }
    } finally {
      if (prev === undefined) delete process.env.DSM_PAN_DIR
      else process.env.DSM_PAN_DIR = prev
    }
    check('验证码失败 → HTTP 400（可继续，不是服务器错）', err?.status === 400, err?.status)
    check('extra.needsCaptcha 为真', err?.extra?.needsCaptcha === true,
      err?.extra && Object.keys(err.extra))
    check('captchaImage 是 PNG data URI',
      /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(err?.extra?.captchaImage || ''))
    if (err?.extra?.captchaImage) {
      const buf = Buffer.from(err.extra.captchaImage.split(',')[1], 'base64')
      check('内嵌图片解回来是 PNG（头 89504e47）',
        buf.subarray(0, 4).toString('hex') === '89504e47', buf.length)
    }
    const argvFile = path.join(fakeDir, 'argv.txt')
    check('子进程收到了 --captcha-png',
      fs.existsSync(argvFile) && fs.readFileSync(argvFile, 'utf8').includes('--captcha-png'),
      fs.existsSync(argvFile) ? fs.readFileSync(argvFile, 'utf8') : '(没有 argv.txt)')

    // 标记里的图片读不到（临时文件被删/不存在）→ 绝不能弹验证码框，
    // 按普通错误出去，否则前端顶着一张碎图让人白填。
    fs.writeFileSync(path.join(fakeDir, 'pan.py'), [
      'import sys',
      "sys.stderr.write('CAPTCHA_REQUIRED\\t' + __import__('os').path.join(__import__('tempfile').gettempdir(), 'gone-captcha.png') + '\\n')",
      "sys.stderr.write('\\u9519\\u8bef: \\u9700\\u8981\\u8f93\\u5165\\u56fe\\u5f62\\u9a8c\\u8bc1\\u7801\\n')",
      'sys.exit(3)',
    ].join('\n'))
    let err2 = null
    try {
      process.env.DSM_PAN_DIR = fakeDir
      const mod2 = await import(`../../server/src/services/panService.js?captcha-miss=${Date.now()}`)
      try {
        await mod2.resolveShare({ url: 'https://pan.xunlei.com/s/x' })
      } catch (e) {
        err2 = e
      }
    } finally {
      if (prev === undefined) delete process.env.DSM_PAN_DIR
      else process.env.DSM_PAN_DIR = prev
    }
    check('图片读不到时按普通错误出去（不弹验证码框）',
      err2 != null && err2.extra?.needsCaptcha !== true && /验证码/.test(err2.message || ''),
      err2?.message)
  }
}

// ============================================================ 内嵌副本契约
console.log('\n【tools/panlink 契约（工作台依赖的 CLI 形状）】')
{
  const toolDir = process.env.DSM_PAN_DIR || path.join(ROOT, 'tools', 'panlink')
  const python = process.env.DSM_PYTHON || 'python'
  const probe = spawnSync(python, ['pan.py', '--list-pans', '--json'], {
    cwd: toolDir, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  if (probe.error || probe.status !== 0) {
    console.log(`  - 跳过（本机没有可用的 Python：${probe.error?.message || probe.stderr?.slice(0, 120)}）`)
  } else {
    let data = null
    try {
      data = JSON.parse(probe.stdout)
    } catch {
      check('--list-pans --json 输出可解析', false, probe.stdout.slice(0, 200))
    }
    if (data) {
      const pans = data.pans || []
      check('内嵌副本已是 10 家网盘', pans.length === 10, pans.length)
      check('包含新增 UC网盘 / 123云盘',
        pans.some((p) => p.name === 'UC网盘') && pans.some((p) => p.name === '123云盘'),
        pans.map((p) => p.name))
      check('字段结构满足服务层使用',
        pans.every((p) => typeof p.name === 'string' && typeof p.requiresAuth === 'boolean'
          && typeof p.authHint === 'string'))
      const help = spawnSync(python, ['pan.py', '--help'], { cwd: toolDir, encoding: 'utf8', timeout: 20000 })
      const text = help.stdout || ''
      const needed = ['--out', '--jobs', '--threads', '--retry', '--no-resume',
        '--overwrite', '--aria2-rpc', '--list-pans', '--only', '--captcha-png']
      const missing = needed.filter((flag) => !text.includes(flag))
      check('下载/推送用到的参数都在', missing.length === 0, missing)
      check('副本无 __pycache__ 残留', !fs.existsSync(path.join(toolDir, 'pans', '__pycache__')))
      check('同步清单存在（能追溯来源）', fs.existsSync(path.join(toolDir, 'SYNC.json')))
    }
  }
}

fs.rmSync(TMP, { recursive: true, force: true })

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures.slice(0, 12), null, 2))
  process.exitCode = 1
}
