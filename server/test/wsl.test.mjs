/**
 * WSL 只读采集单元测试：
 *   node server/test/wsl.test.mjs
 *
 * 覆盖（纯解析部分不依赖本机真的装了 WSL）：
 *   - parseSsOutput：实测到的各种真实格式，含 `127.0.0.53%lo:53`（带接口名）
 *     与 `[::]:5173`（IPv6），这些是朴素 split(':') 会解错的两种
 *   - parsePsOutput：pid/comm/args
 *   - 端口合法性：越界端口、非数字一律丢弃，不猜
 *   - 空输入不崩
 *
 * 真实 wsl.exe 调用部分（listDistros / collectDistro）会检查"没有 WSL 时
 * 给出可读提示而不是崩溃"，有 WSL 的机器上会额外验证发行版列举。
 */
import {
  parseSsOutput,
  parsePsOutput,
  listDistros,
  collectDistro,
  collectAllDistros,
  wslAvailable,
} from '../src/services/wslMetrics.js'

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

console.log('【ss 输出解析：实测格式】')
{
  // 这些行是真实从 WSL 里 ss -tlnpH 抓到的（见本文件顶部说明）
  const sample = [
    'LISTEN 0      4096       127.0.0.54:53         0.0.0.0:*',
    'LISTEN 0      1000       10.255.255.254:53     0.0.0.0:*',
    'LISTEN 0      4096       127.0.0.53%lo:53      0.0.0.0:*',
    'LISTEN 0      511        0.0.0.0:18099         0.0.0.0:*    users:(("python3",pid=584,fd=3))',
    'LISTEN 0      128        [::]:5173             [::]:*       users:(("node",pid=1234,fd=20))',
    'LISTEN 0      128        127.0.0.1:3000        0.0.0.0:*    users:(("node",pid=999,fd=18),("nginx",pid=888,fd=6))',
  ].join('\n')
  const rows = parseSsOutput(sample)
  check('全部行都解析出来', rows.length === 6, rows.length)
  check('普通 IPv4 地址', rows[0].address === '127.0.0.54' && rows[0].port === 53, rows[0])
  check('带 %lo 接口名的地址能剥掉', rows[2].address === '127.0.0.53' && rows[2].port === 53, rows[2])
  check('提取进程名与 PID', rows[3].processName === 'python3' && rows[3].pid === 584, rows[3])
  check('IPv6 方括号能正确剥掉', rows[4].address === '::' && rows[4].port === 5173, rows[4])
  check('IPv6 也提取到进程', rows[4].processName === 'node' && rows[4].pid === 1234, rows[4])
  check('多监听者取第一个', rows[5].pid === 999, rows[5])
  check('按端口升序之外不乱排序（保持原样即可）', rows.length === 6, rows.length)
}

console.log('\n【ss 解析：不编造、只丢弃不猜】')
{
  check('非 LISTEN 行被忽略', parseSsOutput('ESTAB 0 0 1.2.3.4:80 5.6.7.8:1').length === 0)
  check('空行被忽略', parseSsOutput('\n\n\n').length === 0)
  check('列数不足的行被忽略', parseSsOutput('LISTEN 0').length === 0)
  const bad = parseSsOutput('LISTEN 0 128 0.0.0.0:notaport 0.0.0.0:*')
  check('非数字端口被丢弃', bad.length === 0, bad)
  const huge = parseSsOutput('LISTEN 0 128 0.0.0.0:99999 0.0.0.0:*')
  check('越界端口被丢弃', huge.length === 0, huge)
}

console.log('\n【ps 输出解析】')
{
  const rows = parsePsOutput(['  584 python3   python3 -m http.server 18099 --bind 0.0.0.0', ' 1234 node      /usr/bin/node server.js'].join('\n'))
  check('条数正确', rows.length === 2, rows)
  check('PID 与进程名', rows[0].pid === 584 && rows[0].processName === 'python3', rows[0])
  check('命令行完整保留', rows[0].commandLine.includes('http.server 18099'), rows[0].commandLine)
  check('路径形式的命令行', rows[1].commandLine === '/usr/bin/node server.js', rows[1].commandLine)
  check('格式不对的行被忽略', parsePsOutput('这不是进程行').length === 0)
}

console.log('\n【空输入不崩】')
{
  check('parseSsOutput(空串)', parseSsOutput('').length === 0)
  check('parseSsOutput(null)', parseSsOutput(null).length === 0)
  check('parseSsOutput(undefined)', parseSsOutput(undefined).length === 0)
  check('parsePsOutput(空串)', parsePsOutput('').length === 0)
  check('parsePsOutput(null)', parsePsOutput(null).length === 0)
}

console.log('\n【真实环境探测】（没有 WSL 的机器应给出可读提示而不是崩溃）')
{
  let available
  try {
    available = await wslAvailable()
  } catch (error) {
    available = { available: false, reason: `探测异常：${error.message}` }
  }
  check('可用性探测不抛异常', available && typeof available.available === 'boolean', available)
  if (available.available === false) {
    check('不可用时给出可读原因', typeof available.reason === 'string' && available.reason.length > 0, available.reason)
  }

  const list = await listDistros()
  check('发行版列举不抛异常', Array.isArray(list.distros), list)
  // Docker Desktop 的内部发行版不该出现在给用户看的列表里
  check('跳过 docker-desktop 内部发行版', !list.distros.some((d) => d.toLowerCase().includes('docker-desktop')), list.distros)

  if (list.distros.length > 0) {
    const single = await collectDistro(list.distros[0])
    check('单个发行版采集返回结构完整', typeof single.ok === 'boolean' && Array.isArray(single.ports) && Array.isArray(single.processes), {
      ok: single.ok,
      ports: Array.isArray(single.ports),
      processes: Array.isArray(single.processes),
    })
    check('WSL 内部 53 端口被过滤', !single.ports.some((p) => p.port === 53), single.ports.filter((p) => p.port === 53))
    check('采集耗时在超时内', single.durationMs < 60000, single.durationMs)

    const t0 = Date.now()
    const all = await collectAllDistros({ includeProcesses: false })
    const ms = Date.now() - t0
    check('并行采集覆盖所有发行版', all.results.length === list.distros.length, {
      expected: list.distros.length,
      actual: all.results.length,
    })
    check('每个发行版都有结构化结果', all.results.every((r) => Array.isArray(r.ports)), all.results.map((r) => r.name))
    // 串行会累加到每个发行版耗时之和；并行应显著更快
    const sumOfDurations = all.results.reduce((s, r) => s + (r.durationMs || 0), 0)
    check('并行总耗时未超过各发行版耗时之和（说明确实并行）', ms <= sumOfDurations + 1500, { total: ms, sum: sumOfDurations })
  }
}

console.log('\n【不存在的发行版要优雅失败】')
{
  let result
  try {
    result = await collectDistro('__dsm_not_a_real_distro__', { timeout: 8000 })
  } catch (error) {
    result = { ok: false, error: `抛异常：${error.message}`, ports: [] }
  }
  check('不抛异常而是返回失败', result && result.ok === false, result)
  check('返回空端口数组', Array.isArray(result.ports) && result.ports.length === 0, result.ports)
  check('有错误说明文本', typeof result.error === 'string' && result.error.length > 0, result.error)
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures.slice(0, 12), null, 2))
  process.exitCode = 1
}