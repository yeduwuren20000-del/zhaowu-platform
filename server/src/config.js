import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** 目录常量：server/src -> server -> 项目根 */
export const SERVER_SRC_DIR = here
export const SERVER_DIR = path.resolve(here, '..')
export const PROJECT_ROOT = path.resolve(SERVER_DIR, '..')

export const DATA_DIR = process.env.DSM_DATA_DIR
  ? path.resolve(process.env.DSM_DATA_DIR)
  : path.join(PROJECT_ROOT, 'data')
export const LOG_DIR = path.join(DATA_DIR, 'logs')
export const WEB_DIST_DIR = path.join(PROJECT_ROOT, 'web', 'dist')

export const HOST = process.env.DSM_HOST || '127.0.0.1'
export const PORT = Number(process.env.DSM_PORT || 8787)

export const FILES = {
  projects: path.join(DATA_DIR, 'projects.json'),
  servers: path.join(DATA_DIR, 'servers.json'),
  runtime: path.join(DATA_DIR, 'runtime.json'),
  discovery: path.join(DATA_DIR, 'discovery.json'),
  events: path.join(DATA_DIR, 'events.json'),
  monitor: path.join(DATA_DIR, 'monitor.json'),
  resources: path.join(DATA_DIR, 'resources.json'),
  // 凭据库：磁盘上永远是密文（AES-256-GCM），文件头自带全部解密参数
  vault: path.join(DATA_DIR, 'vault.dsmv'),
  workbenchLog: path.join(LOG_DIR, 'workbench.log'),
}

/**
 * 端口扫描结果缓存时长（毫秒）
 * 必须明显大于一次扫描本身耗时（实测 Get-NetTCPConnection 全表约 3 秒），
 * 否则缓存永远在返回前就过期，等于没有缓存。
 */
export const PORT_SCAN_TTL_MS = Number(process.env.DSM_PORT_SCAN_TTL_MS || 10000)
/** 启动后回查端口是否就绪的总等待时间（测试可用 DSM_START_VERIFY_TIMEOUT_MS 缩短） */
export const START_VERIFY_TIMEOUT_MS = Number(process.env.DSM_START_VERIFY_TIMEOUT_MS || 20000)
/** 停止后等待端口释放的总时间 */
export const STOP_VERIFY_TIMEOUT_MS = 12000
/** 远程服务器 TCP 探测超时 */
export const PROBE_TIMEOUT_MS = 1600
/** SSE 推送轮询间隔 */
export const LOG_STREAM_INTERVAL_MS = 1000
/** 事件时间线：最多保留多少条事件（超出裁最旧的） */
export const EVENT_MAX_ITEMS = Math.max(50, Number(process.env.DSM_EVENT_MAX || 800))
/** 事件时间线：最多保留多少个主体状态指纹（每个主体一条，不是快照） */
export const EVENT_MAX_STATES = 600

// ---- 第七阶段·第三轮：资源历史趋势 ----

/** 每台服务器最多保留多少采样点（2 分钟间隔下约等于 24 小时） */
export const RESOURCE_MAX_SAMPLES = Math.max(20, Number(process.env.DSM_RESOURCE_MAX_SAMPLES || 720))
/** 尖峰告警最多保留多少条 */
export const RESOURCE_MAX_SPIKES = Math.max(10, Number(process.env.DSM_RESOURCE_SPIKE_MAX || 200))
/** 两次采样至少间隔多久才记新点：手动连点探测不会把历史刷爆 */
export const RESOURCE_MIN_GAP_MS = Math.max(1000, Number(process.env.DSM_RESOURCE_MIN_GAP_MS || 30000))
/** CPU 尖峰阈值（%）与内存尖峰阈值（%） */
export const RESOURCE_SPIKE_CPU_PERCENT = Number(process.env.DSM_RESOURCE_SPIKE_CPU || 85)
export const RESOURCE_SPIKE_MEMORY_PERCENT = Number(process.env.DSM_RESOURCE_SPIKE_MEM || 90)
/** 同一台机器同一指标的告警冷却：持续高负载不会每轮刷一条 */
export const RESOURCE_SPIKE_COOLDOWN_MS = Math.max(60000, Number(process.env.DSM_RESOURCE_SPIKE_COOLDOWN_MS || 900000))
