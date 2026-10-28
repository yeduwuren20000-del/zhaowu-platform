import { createJsonStore } from './jsonStore.js'
import { FILES } from '../config.js'
import { makeId, nowIso } from '../utils/ids.js'
import { notFound } from '../utils/http.js'

function app(name, port, deployPath, status, extra = {}) {
  return {
    id: makeId('app'),
    name,
    port,
    deployPath,
    url: '',
    status,
    remark: '',
    ...extra,
  }
}

/** 首次运行时的示例服务器（占位 IP，可编辑成真实服务器） */
function seedServers() {
  const now = nowIso()
  return {
    version: 1,
    items: [
      {
        id: makeId('srv'),
        name: '主服务器',
        host: '203.0.113.10',
        os: 'Ubuntu 22.04',
        sshPort: 22,
        user: 'root',
        username: 'root',
        authType: 'key',
        keyPath: '~/.ssh/id_ed25519',
        connectTimeout: 8000,
        monitorEnabled: true,
        logPaths: ['/var/log/nginx/error.log', '/var/log/syslog'],
        remark: '示例数据：生产环境（Dify / MySQL / Nginx）',
        online: true,
        latencyMs: 42,
        lastCheckedAt: now,
        ssh: null,
        metrics: null,
        listeningPorts: [],
        portAudit: null,
        apps: [
          app('Nginx', 80, '/etc/nginx', 'running'),
          app('Dify Web', 8080, '/opt/dify', 'running', { url: 'http://203.0.113.10:8080' }),
          app('MySQL', 3306, '/var/lib/mysql', 'running'),
        ],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: makeId('srv'),
        name: 'AI 实验服务器',
        host: '192.168.1.20',
        os: 'Debian 12',
        sshPort: 22,
        user: 'ubuntu',
        username: 'ubuntu',
        authType: 'key',
        keyPath: '~/.ssh/id_ed25519',
        connectTimeout: 6000,
        monitorEnabled: true,
        logPaths: ['/var/log/ollama.log'],
        remark: '示例数据：内网 GPU 机器',
        online: true,
        latencyMs: 3,
        lastCheckedAt: now,
        ssh: null,
        metrics: null,
        listeningPorts: [],
        portAudit: null,
        apps: [
          app('Ollama API', 11434, '/opt/ollama', 'running'),
          app('Jupyter', 8888, '/home/jupyter', 'running'),
        ],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: makeId('srv'),
        name: '测试服务器',
        host: '198.51.100.30',
        os: 'CentOS 7',
        sshPort: 22,
        user: 'root',
        username: 'root',
        authType: 'password',
        keyPath: '',
        connectTimeout: 8000,
        monitorEnabled: true,
        logPaths: ['/var/log/messages'],
        remark: '示例数据：预发验证机（密码登录，密码只从环境变量或 data/secrets.json 读取）',
        online: false,
        latencyMs: null,
        lastCheckedAt: null,
        ssh: null,
        metrics: null,
        listeningPorts: [],
        portAudit: null,
        apps: [
          app('Nginx', 80, '/usr/share/nginx/html', 'running'),
          app('Redis', 6379, '/var/lib/redis', 'stopped'),
        ],
        createdAt: now,
        updatedAt: now,
      },
    ],
  }
}

const store = createJsonStore(FILES.servers, {
  seed: seedServers,
  isValid: (value) => Boolean(value) && Array.isArray(value?.items),
})

function findServerOrThrow(data, serverId) {
  const index = data.items.findIndex((item) => item.id === serverId)
  if (index < 0) throw notFound(`服务器不存在：${serverId}`)
  return { index, server: data.items[index] }
}

export const serversRepo = {
  file: FILES.servers,

  async list() {
    const data = await store.read()
    return data.items
  },

  async get(id) {
    const items = await serversRepo.list()
    const found = items.find((item) => item.id === id)
    if (!found) throw notFound(`服务器不存在：${id}`)
    return found
  },

  async create(input) {
    return store.mutate((data) => {
      const now = nowIso()
      const item = {
        id: makeId('srv'),
        online: false,
        latencyMs: null,
        lastCheckedAt: null,
        apps: [],
        ...input,
        createdAt: now,
        updatedAt: now,
      }
      data.items.push(item)
      return item
    })
  },

  async update(id, patch) {
    return store.mutate((data) => {
      const { index, server } = findServerOrThrow(data, id)
      const next = { ...server, ...patch, updatedAt: nowIso() }
      data.items[index] = next
      return next
    })
  },

  async remove(id) {
    return store.mutate((data) => {
      const { index } = findServerOrThrow(data, id)
      const [removed] = data.items.splice(index, 1)
      return removed
    })
  },

  async setProbe(id, { online, latencyMs }) {
    return store.mutate((data) => {
      const { index, server } = findServerOrThrow(data, id)
      const at = nowIso()
      const next = {
        ...server,
        online,
        latencyMs,
        lastCheckedAt: at,
        tcp: { ok: Boolean(online), latencyMs: latencyMs ?? null, at },
        updatedAt: at,
      }
      data.items[index] = next
      return next
    })
  },

  /**
   * 写入一次 SSH 只读采集的结果（指标 + 真实监听端口 + 端口核对 + Docker 容器）。
   * 只保存结构化结果，不保存任何命令输出原文或凭据。
   */
  async setSshMonitor(id, { ssh, metrics, listeningPorts, portAudit, docker }) {
    return store.mutate((data) => {
      const { index, server } = findServerOrThrow(data, id)
      const at = nowIso()
      const next = {
        ...server,
        ssh: ssh ? { ...ssh, at: ssh.at || at } : server.ssh || null,
        metrics: metrics ?? server.metrics ?? null,
        listeningPorts: listeningPorts ?? server.listeningPorts ?? [],
        portAudit: portAudit ? { ...portAudit, at } : server.portAudit || null,
        docker: docker !== undefined ? (docker ? { ...docker, at } : null) : server.docker || null,
        lastMonitorAt: at,
        updatedAt: at,
      }
      data.items[index] = next
      return next
    })
  },

  /** 记录一次日志读取（路径必须来自 logPaths 允许列表） */
  async setLogRead(id, { path: remotePath, lines, size, error }) {
    return store.mutate((data) => {
      const { index, server } = findServerOrThrow(data, id)
      const at = nowIso()
      const next = {
        ...server,
        logRead: { path: remotePath, at, lines, size: size ?? null, error: error || null },
      }
      data.items[index] = next
      return next
    })
  },

  async addApp(serverId, input) {
    return store.mutate((data) => {
      const { index, server } = findServerOrThrow(data, serverId)
      const item = { id: makeId('app'), url: '', remark: '', status: 'unknown', ...input }
      const next = { ...server, apps: [...(server.apps || []), item], updatedAt: nowIso() }
      data.items[index] = next
      return item
    })
  },

  async updateApp(serverId, appId, patch) {
    return store.mutate((data) => {
      const { index, server } = findServerOrThrow(data, serverId)
      const apps = server.apps || []
      const appIndex = apps.findIndex((item) => item.id === appId)
      if (appIndex < 0) throw notFound(`APP 记录不存在：${appId}`)
      const nextApp = { ...apps[appIndex], ...patch }
      const nextApps = [...apps]
      nextApps[appIndex] = nextApp
      data.items[index] = { ...server, apps: nextApps, updatedAt: nowIso() }
      return nextApp
    })
  },

  async removeApp(serverId, appId) {
    return store.mutate((data) => {
      const { index, server } = findServerOrThrow(data, serverId)
      const apps = server.apps || []
      const appIndex = apps.findIndex((item) => item.id === appId)
      if (appIndex < 0) throw notFound(`APP 记录不存在：${appId}`)
      const nextApps = [...apps]
      const [removed] = nextApps.splice(appIndex, 1)
      data.items[index] = { ...server, apps: nextApps, updatedAt: nowIso() }
      return removed
    })
  },

  /** 恢复示例数据（原文件会备份保留） */
  async reset() {
    return store.reset()
  },
}
