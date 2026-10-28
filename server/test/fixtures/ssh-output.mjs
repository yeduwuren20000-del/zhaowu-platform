/**
 * 测试用样本输出：模拟一台 Ubuntu 22.04 生产机的真实命令返回。
 * 解析器测试与假 SSH 服务器（ssh-fixture-server.mjs）共用这份数据。
 */

export const HOSTNAME = 'prod-web-01'
export const OS = 'Ubuntu 22.04.4 LTS'
export const USER = 'root'

export const SECTION_DATA = {
  hostname: HOSTNAME,
  user: USER,
  os: OS,
  kernel: 'Linux 5.15.0-105-generic',
  arch: 'x86_64',
  uptime: '432100.55 1234567.89',
  load: '0.42 0.58 0.61 2/512 41234',
  cores: '8',
  cpu1: 'cpu  120345 512 30122 987654 3210 0 1200 0 0 0',
  cpu2: 'cpu  120700 520 30200 988100 3220 0 1205 0 0 0',
  mem: [
    '               total        used        free      shared  buff/cache   available',
    'Mem:     16702988288  5234524160  2104520704   123456789  9363943424  10384384000',
    'Swap:     2147483648    52428800  2095054848',
  ].join('\n'),
  disk: [
    'Filesystem     Type 1B-blocks        Used   Available Capacity Mounted on',
    '/dev/vda1      ext4 107374182400 21474836480 85899345920      20% /',
    'tmpfs          tmpfs  8388608000        0   8388608000       0% /dev/shm',
    '/dev/vdb1      ext4 536870912000 402653184000 134217728000      75% /data',
  ].join('\n'),
  ports: [
    'Netid State  Recv-Q Send-Q Local Address:Port Peer Address:PortProcess',
    'udp   UNCONN 0      0          127.0.0.53:53        0.0.0.0:*    users:(("systemd-resolve",pid=712,fd=13))',
    'tcp   LISTEN 0      4096       127.0.0.1:8080      0.0.0.0:*    users:(("docker-proxy",pid=2211,fd=4))',
    'tcp   LISTEN 0      511           0.0.0.0:80        0.0.0.0:*    users:(("nginx",pid=1337,fd=6),("nginx",pid=1338,fd=6))',
    'tcp   LISTEN 0      128           0.0.0.0:22        0.0.0.0:*    users:(("sshd",pid=902,fd=3))',
    'tcp   LISTEN 0      70          127.0.0.1:3306      0.0.0.0:*    users:(("mysqld",pid=1500,fd=21))',
    'tcp   LISTEN 0      4096              *:9100          0.0.0.0:*    users:(("node_exporter",pid=1811,fd=3))',
  ].join('\n'),
}

/** 按客户端实际使用的 @@S: 分段协议拼出完整输出 */
export function buildMetricsStdout(sections = SECTION_DATA) {
  const order = ['hostname', 'user', 'os', 'kernel', 'arch', 'uptime', 'load', 'cores', 'cpu1', 'cpu2', 'mem', 'disk', 'ports', 'end']
  return order.map((key) => `@@S:${key}\n${sections[key] ?? ''}`).join('\n') + '\n'
}

/** netstat 回退格式（老系统 / 没有 ss 时） */
export const NETSTAT_PORTS = [
  'Active Internet connections (only servers)',
  'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name',
  'tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      902/sshd',
  'tcp        0      0 127.0.0.1:3306          0.0.0.0:*               LISTEN      1500/mysqld',
  'tcp        0      0 0.0.0.0:80              0.0.0.0:*               LISTEN      1337/nginx',
  'udp        0      0 0.0.0.0:68              0.0.0.0:*                           712/systemd-resolve',
].join('\n')

/** 只有 /proc/meminfo（没有 free 命令）时的输出 */
export const MEMINFO = [
  'MemTotal:       16303776 kB',
  'MemFree:         2055204 kB',
  'MemAvailable:   10140000 kB',
  'Buffers:          130000 kB',
  'Cached:          9140000 kB',
  'SwapTotal:       2097148 kB',
  'SwapFree:        2048000 kB',
].join('\n')

/** 只有 df -Pk（没有 -T / -B1）时的输出 */
export const DF_KB = [
  'Filesystem     1K-blocks      Used Available Use% Mounted on',
  '/dev/vda1      104857600  20971520  83886080  20% /',
].join('\n')

/** 日志文件样本（用于 SFTP 读取尾部测试） */
export const SAMPLE_LOG = Array.from({ length: 500 }, (_, index) => {
  const n = index + 1
  const level = n % 97 === 0 ? 'error' : n % 13 === 0 ? 'warn' : 'info'
  return `2026-10-06T10:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}Z [${level}] request #${n} handled`
}).join('\n')
