/**
 * Docker 采集样本输出：模拟一台跑着 Dify + MySQL + Redis + Ollama 的宿主机。
 * 解析器测试与假 SSH 服务器共用。
 */

export const DOCKER_INSTALLED = 'yes'
export const DAEMON_INFO =
  '27.3.1|7|5|1|12|overlay2|Ubuntu 22.04.4 LTS'
export const VERSION = '27.3.1'

/** docker ps -a --no-trunc --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}|{{.Ports}}|{{.RunningFor}}|{{.Labels}}' */
export const PS_OUTPUT = [
  'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2|dify-web|langgenius/dify-web:0.6.14|running|Up 3 days (healthy)|0.0.0.0:8080->3000/tcp, :::8080->3000/tcp|3 days ago|com.docker.compose.project=dify,com.docker.compose.service=web',
  'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3|dify-api|langgenius/dify-api:0.6.14|running|Up 3 days|5001/tcp|3 days ago|com.docker.compose.project=dify,com.docker.compose.service=api',
  'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4|mysql|mysql:8.0|running|Up 3 days (healthy)|127.0.0.1:3306->3306/tcp|3 days ago|com.docker.compose.project=dify,com.docker.compose.service=db',
  'd4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5|redis|redis:7-alpine|running|Up 2 days|0.0.0.0:6379->6379/tcp, :::6379->6379/tcp|2 days ago|',
  'e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6|ollama|ollama/ollama:latest|running|Up 5 hours (unhealthy)|0.0.0.0:11434->11434/tcp, :::11434->11434/tcp|5 hours ago|',
  'f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1|watchtower|containrrr/watchtower:latest|restarting|Restarting (1) 5 seconds ago|8088/tcp|10 minutes ago|',
  'a7b8c9d0e1f2a7b8c9d0e1f2a7b8c9d0e1f2a7b8c9d0e1f2a7b8c9d0e1f2a7b8|legacy-web|nginx:1.21|exited|Exited (0) 2 days ago|0.0.0.0:8888->80/tcp|2 days ago|',
].join('\n')

/** docker inspect --format '{{.Id}}|{{.Name}}|{{.State.Status}}|{{.State.StartedAt}}|{{if .State.Health}}…' */
export const INSPECT_OUTPUT = [
  'sha256:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2|/dify-web|running|2026-10-03T02:11:22.123456789Z|healthy|0|dify|web',
  'sha256:b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3|/dify-api|running|2026-10-03T02:11:25.987654321Z|none|0|dify|api',
  'sha256:c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4|/mysql|running|2026-10-03T02:11:20.000000000Z|healthy|0|dify|db',
  'sha256:d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5|/redis|running|2026-10-04T09:00:00.000000000Z|none|1||',
  'sha256:e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6|/ollama|running|2026-10-06T04:00:00.000000000Z|unhealthy|3||',
  'sha256:f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1|/watchtower|restarting||none|7||',
  'sha256:a7b8c9d0e1f2a7b8c9d0e1f2a7b8c9d0e1f2a7b8c9d0e1f2a7b8c9d0e1f2a7b8|/legacy-web|exited|2026-10-04T01:00:00.000000000Z|none|0||',
].join('\n')

/** docker stats --no-stream */
export const STATS_OUTPUT = [
  'a1b2c3d4e5f6|dify-web|1.25%|512MiB / 15.6GiB|3.20%|1.2GB / 3.4MB|0B / 0B|12',
  'b2c3d4e5f6a1|dify-api|0.80%|1.2GiB / 15.6GiB|7.69%|900MB / 120MB|4.1MB / 0B|48',
  'c3d4e5f6a1b2|mysql|2.40%|800MiB / 15.6GiB|5.01%|12MB / 8MB|1.5MB / 220MB|31',
  'd4e5f6a1b2c3|redis|0.10%|12MiB / 15.6GiB|0.08%|640kB / 320kB|0B / 0B|5',
  'e5f6a1b2c3d4|ollama|45.60%|3.2GiB / 15.6GiB|20.51%|2.4GB / 1.1GB|0B / 0B|19',
].join('\n')

/** docker images */
export const IMAGES_OUTPUT = [
  'langgenius/dify-web:0.6.14|b7c1d2e3f4a5|142MB|2 weeks ago',
  'langgenius/dify-api:0.6.14|c8d2e3f4a5b6|689MB|2 weeks ago',
  'mysql:8.0|d9e3f4a5b6c7|586MB|3 weeks ago',
  'redis:7-alpine|e1f4a5b6c7d8|41.2MB|3 weeks ago',
  'ollama/ollama:latest|f2a5b6c7d8e9|1.6GB|5 days ago',
  'containrrr/watchtower:latest|a3b6c7d8e9f1|14.8MB|2 months ago',
  'nginx:1.21|b4c7d8e9f1a2|141MB|8 months ago',
].join('\n')

/** 组装成假服务器返回给客户端的完整输出 */
export function buildDockerStdout({
  docker = DOCKER_INSTALLED,
  daemon = DAEMON_INFO,
  version = VERSION,
  ps = PS_OUTPUT,
  inspect = INSPECT_OUTPUT,
  stats = STATS_OUTPUT,
  images = IMAGES_OUTPUT,
} = {}) {
  return [
    `@@D:docker\n${docker}`,
    `@@D:daemon\n${daemon}`,
    `@@D:version\n${version}`,
    `@@D:ps\n${ps}`,
    `@@D:inspect\n${inspect}`,
    `@@D:stats\n${stats}`,
    `@@D:images\n${images}`,
    '@@D:end\n',
  ].join('\n')
}

/** 没装 Docker 的机器 */
export const NO_DOCKER_STDOUT = buildDockerStdout({
  docker: 'no',
  daemon: 'bash: docker: command not found',
  version: '',
  ps: '',
  inspect: '',
  stats: '',
  images: '',
})

/** 装了 Docker 但当前用户无权限访问 socket（真实环境里很常见） */
export const PERMISSION_DENIED_STDOUT = buildDockerStdout({
  docker: 'yes',
  daemon: 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock',
  version: '27.3.1',
  ps: '',
  inspect: '',
  stats: '',
  images: '',
})
