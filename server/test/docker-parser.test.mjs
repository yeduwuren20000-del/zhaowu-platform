/**
 * Docker 解析器单元测试（不联网）：
 *   node server/test/docker-parser.test.mjs
 * 覆盖：容器列表 / 端口映射 / 健康状态 / stats / 镜像 / 守护进程错误 / 三类核对状态 / 只读约束。
 */
import {
  DOCKER_COMMAND,
  auditContainers,
  parseContainerStatus,
  parseDaemonInfo,
  parseDockerPorts,
  parseDockerSnapshot,
  parseHumanDuration,
  parseSize,
} from '../src/services/dockerMetrics.js'
import {
  DAEMON_INFO,
  NO_DOCKER_STDOUT,
  PERMISSION_DENIED_STDOUT,
  PS_OUTPUT,
  buildDockerStdout,
} from './fixtures/docker-output.mjs'

let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push({ name, detail })
    console.log(`  ✗ ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`)
  }
}

console.log('\n[1] 基础解析工具')
check('parseSize 二进制单位', parseSize('512MiB') === 512 * 1024 * 1024, parseSize('512MiB'))
check('parseSize 十进制单位', parseSize('142MB') === 142 * 1000 * 1000, parseSize('142MB'))
check('parseSize GiB', parseSize('15.6GiB') === Math.round(15.6 * 1024 ** 3), parseSize('15.6GiB'))
check('parseSize 无单位即字节', parseSize('0B') === 0, parseSize('0B'))
check('parseSize 非法输入返回 null', parseSize('') === null && parseSize('abc') === null)
check('parseHumanDuration 3 days', parseHumanDuration('3 days') === 259200)
check('parseHumanDuration 5 hours', parseHumanDuration('5 hours') === 18000)
check('parseHumanDuration 组合', parseHumanDuration('1 day 2 hours') === 93600)
check('parseContainerStatus 识别 healthy', parseContainerStatus('Up 3 days (healthy)', 'running').health === 'healthy')
check('parseContainerStatus 识别 unhealthy', parseContainerStatus('Up 5 hours (unhealthy)', 'running').health === 'unhealthy')
check('parseContainerStatus 识别 starting', parseContainerStatus('Up 10 seconds (health: starting)', 'running').health === 'starting')
check('parseContainerStatus 退出信息', parseContainerStatus('Exited (0) 2 days ago', 'exited').runningFor === '已退出 2 days ago')

console.log('\n[2] 端口映射解析')
const ports = parseDockerPorts('0.0.0.0:8080->3000/tcp, :::8080->3000/tcp, 5001/tcp')
check('解析出 3 条记录（2 发布 + 1 仅暴露）', ports.length === 3, ports)
check('发布端口字段正确', ports[0].hostIp === '0.0.0.0' && ports[0].hostPort === 8080 && ports[0].containerPort === 3000, ports[0])
check('IPv6 通配地址', ports[1].hostIp === '::' && ports[1].hostPort === 8080, ports[1])
check('未发布端口 published=false', ports[2].published === false && ports[2].containerPort === 5001, ports[2])
const localBind = parseDockerPorts('127.0.0.1:3306->3306/tcp')
check('仅本机绑定', localBind[0].hostIp === '127.0.0.1' && localBind[0].hostPort === 3306, localBind[0])
check('空字符串安全', parseDockerPorts('').length === 0)

console.log('\n[3] 守护进程检测')
const daemon = parseDaemonInfo(DAEMON_INFO)
check('daemon 可用', daemon.ok === true, daemon)
check('server 版本', daemon.serverVersion === '27.3.1', daemon.serverVersion)
check('容器统计', daemon.containers === 7 && daemon.containersRunning === 5 && daemon.containersStopped === 1, daemon)
const denied = parseDaemonInfo('permission denied while trying to connect to the Docker daemon socket')
check('权限错误被识别', denied.ok === false && /docker 组/.test(denied.error), denied.error)
check('守护进程未运行提示', /未运行|不可达/.test(parseDaemonInfo('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?').error))

console.log('\n[4] 完整快照')
const snapshot = parseDockerSnapshot(buildDockerStdout())
check('已安装且守护进程可用', snapshot.installed === true && snapshot.daemonOk === true)
check('容器数量 7', snapshot.containers.length === 7, snapshot.containers.length)
check('镜像数量 7', snapshot.images.length === 7, snapshot.images.length)
check('Docker 版本', snapshot.version === '27.3.1', snapshot.version)

const web = snapshot.containers.find((item) => item.name === 'dify-web')
check('容器 ID 与短 ID', web.id.length === 64 && web.shortId === web.id.slice(0, 12), web.shortId)
check('镜像名', web.image === 'langgenius/dify-web:0.6.14', web.image)
check('状态 running', web.state === 'running')
check('健康状态 healthy', web.health === 'healthy', web.health)
check('运行时长来自 inspect StartedAt', Number.isFinite(web.uptimeSec) && web.uptimeSec > 86400, web.uptimeSec)
check('端口映射 8080->3000', web.ports.some((port) => port.hostPort === 8080 && port.containerPort === 3000))
check('CPU 与内存来自 docker stats', web.cpuPercent === 1.25 && web.memoryUsedBytes === 512 * 1024 * 1024, { cpu: web.cpuPercent, mem: web.memoryUsedBytes })
check('内存上限', web.memoryLimitBytes === Math.round(15.6 * 1024 ** 3), web.memoryLimitBytes)
check('compose 项目/服务标签', web.composeProject === 'dify' && web.composeService === 'web', { p: web.composeProject, s: web.composeService })

const ollama = snapshot.containers.find((item) => item.name === 'ollama')
check('unhealthy 容器被识别', ollama.health === 'unhealthy' && ollama.restartCount === 3, { health: ollama.health, restarts: ollama.restartCount })
const watchtower = snapshot.containers.find((item) => item.name === 'watchtower')
check('restarting 状态', watchtower.state === 'restarting', watchtower.state)
check('restarting 无 StartedAt', watchtower.startedAt === null, watchtower.startedAt)
const legacy = snapshot.containers.find((item) => item.name === 'legacy-web')
check('exited 容器保留端口信息', legacy.state === 'exited' && legacy.ports[0].hostPort === 8888, legacy.ports)

check('汇总：运行 5 个', snapshot.summary.running === 5, snapshot.summary)
check('汇总：退出 1 个', snapshot.summary.exited === 1, snapshot.summary)
check('汇总：重启中 1 个', snapshot.summary.restarting === 1, snapshot.summary)
check('汇总：异常 1 个', snapshot.summary.unhealthy === 1, snapshot.summary)
check('汇总：CPU 合计', snapshot.summary.cpuPercentTotal === 50.2, snapshot.summary.cpuPercentTotal)
check('汇总：发布端口的容器数', snapshot.summary.withPublishedPorts === 5, snapshot.summary.withPublishedPorts)

console.log('\n[5] 没装 Docker 的机器')
const none = parseDockerSnapshot(NO_DOCKER_STDOUT)
check('installed=false', none.installed === false)
check('容器与镜像为空', none.containers.length === 0 && none.images.length === 0)
check('错误信息可读', /没有 docker 命令/.test(none.daemonError || ''), none.daemonError)

console.log('\n[6] 无权限访问 Docker')
const deniedSnapshot = parseDockerSnapshot(PERMISSION_DENIED_STDOUT)
check('installed=true 但 daemonOk=false', deniedSnapshot.installed === true && deniedSnapshot.daemonOk === false)
check('给出 docker 组提示', /docker 组/.test(deniedSnapshot.daemonError || ''), deniedSnapshot.daemonError)

console.log('\n[7] 容器与 APP 三类核对')
const apps = [
  { id: 'a1', name: 'Dify Web', port: 8080, deployPath: '/opt/dify' },
  { id: 'a2', name: 'MySQL', port: 3306, deployPath: '/var/lib/mysql' },
  { id: 'a3', name: 'Redis', port: 6379, deployPath: '/var/lib/redis' },
  { id: 'a4', name: 'Ollama API', port: 11434, deployPath: '/opt/ollama' },
  { id: 'a5', name: 'Legacy Web', port: 8888, deployPath: '/srv/legacy' },
  { id: 'a6', name: 'Nginx', port: 80, deployPath: '/etc/nginx' },
]
const audit = auditContainers(apps, snapshot.containers)
check('已登记且运行 4 个（按端口匹配）', audit.summary.ok === 4, audit.summary)
check('已登记但未运行 2 个（legacy-web 容器已退出 + Nginx 根本不是容器部署）', audit.summary.recordedStopped === 2, audit.summary)
check('容器存在但未登记 2 个（dify-api / watchtower）', audit.summary.containerNotRecorded === 2, audit.summary)
check('无对应容器的 APP 标记 matched=false', audit.items.find((item) => item.appName === 'Nginx')?.matched === false)
check('Dify Web 匹配到 dify-web 容器', audit.items.find((item) => item.appName === 'Dify Web')?.container?.name === 'dify-web')
check('按端口匹配优先于名称', audit.items.find((item) => item.appName === 'Ollama API')?.container?.name === 'ollama')
check('已退出容器归入"已登记但停止"', audit.items.find((item) => item.appName === 'Legacy Web')?.state === 'recordedStopped')
check('未登记容器带镜像信息', audit.items.find((item) => item.state === 'containerNotRecorded')?.container?.image.includes('dify-api') ||
  audit.items.filter((item) => item.state === 'containerNotRecorded').some((item) => item.container.image.includes('dify-api')))
check('Nginx（非容器部署）不算未登记容器', audit.items.find((item) => item.appName === 'Nginx')?.matched === false)

console.log('\n[8] 严格只读约束')
const forbidden = ['exec', 'restart', 'docker stop', 'docker rm', 'docker kill', 'docker run', 'prune', 'docker build', 'docker pull', 'docker start', 'docker pause', 'create ']
const violations = forbidden.filter((word) => new RegExp(`\\b${word}\\b`).test(DOCKER_COMMAND))
check('命令里没有写操作', violations.length === 0, violations)
const readOnlyVerbs = ['docker ps', 'docker images', 'docker inspect', 'docker stats --no-stream', 'docker info', 'docker version']
check('只包含查询类命令', readOnlyVerbs.every((verb) => DOCKER_COMMAND.includes(verb)), readOnlyVerbs.filter((verb) => !DOCKER_COMMAND.includes(verb)))
check('命令为常量字符串', typeof DOCKER_COMMAND === 'string' && !DOCKER_COMMAND.includes('${'))

console.log('\n[9] 边界情况')
const partial = parseDockerSnapshot('@@D:docker\nyes\n@@D:ps\n@@D:end\n')
check('只有 docker 段时安全', partial.installed === true && partial.containers.length === 0 && partial.daemonOk === false)
const garbage = parseDockerSnapshot('随便一段没有分段的输出')
check('无分段输出不抛错', garbage.installed === false && garbage.containers.length === 0)

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures, null, 2))
  process.exitCode = 1
}
