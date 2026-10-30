import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** 本地资源采样最多 3 秒复用一次：dashboard 每次刷新、轮询都不该重跑 PowerShell */
const TTL_MS = 3000
let cache = { at: 0, data: null }

/**
 * Windows：用 CIM 即时读数（LoadPercentage / Win32_OperatingSystem / Win32_LogicalDisk），
 * 不依赖 Get-Counter 的秒级采样，开销低、可缓存。输出强制 UTF-8，避开 PowerShell 管道默认的 UTF-16LE。
 */
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$os = Get-CimInstance Win32_OperatingSystem
$memTotal = [double]$os.TotalVisibleMemorySize * 1KB
$memFree = [double]$os.FreePhysicalMemory * 1KB
$memUsed = $memTotal - $memFree
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
  [PSCustomObject]@{
    drive = $_.DeviceID
    totalBytes = [double]$_.Size
    freeBytes = [double]$_.FreeSpace
    usedBytes = [double]($_.Size - $_.FreeSpace)
  }
})
$result = [PSCustomObject]@{
  hostname = $env:COMPUTERNAME
  cpuPercent = [math]::Round($cpu, 1)
  memTotalBytes = [math]::Round($memTotal)
  memFreeBytes = [math]::Round($memFree)
  memUsedBytes = [math]::Round($memUsed)
  memPercent = [math]::Round(($memUsed / $memTotal) * 100, 1)
  disks = $disks
}
[Console]::WriteLine(($result | ConvertTo-Json -Compress))
`

/**
 * 把 PowerShell 的 JSON 输出整理成「聚合磁盘」结构，并计算整体磁盘占用率。
 * 独立成纯函数：既方便测试，也让非 Windows 平台（拿不到 Win32_*）时直接返回 null。
 * @returns {null | {platform,hostname,cpuPercent,memTotalBytes,memFreeBytes,memUsedBytes,memPercent,diskUsedBytes,diskTotalBytes,diskPercent,disks,collectedAt}}
 */
export function normalizeLocalResources(raw) {
  if (!raw || typeof raw !== 'object') return null
  const disks = Array.isArray(raw.disks)
    ? raw.disks.map((disk) => ({
        drive: disk.drive,
        totalBytes: Number(disk.totalBytes) || 0,
        usedBytes: Number(disk.usedBytes) || 0,
        freeBytes: Number(disk.freeBytes) || 0,
      }))
    : []
  const diskTotalBytes = disks.reduce((sum, disk) => sum + (disk.totalBytes || 0), 0)
  const diskUsedBytes = disks.reduce((sum, disk) => sum + (disk.usedBytes || 0), 0)
  const diskPercent = diskTotalBytes > 0 ? Math.round((diskUsedBytes / diskTotalBytes) * 1000) / 10 : null
  const cpuPercent = Number.isFinite(Number(raw.cpuPercent)) ? Number(raw.cpuPercent) : null
  const memTotalBytes = Number(raw.memTotalBytes) || 0
  const memUsedBytes = Number(raw.memUsedBytes) || 0
  const memFreeBytes = Number(raw.memFreeBytes) || 0
  const memPercent =
    memTotalBytes > 0 && Number.isFinite(Number(raw.memPercent)) ? Number(raw.memPercent) : null
  if (cpuPercent === null && memPercent === null && diskPercent === null) return null
  return {
    platform: 'win32',
    hostname: String(raw.hostname || ''),
    cpuPercent,
    memTotalBytes,
    memFreeBytes,
    memUsedBytes,
    memPercent,
    diskUsedBytes,
    diskTotalBytes,
    diskPercent,
    disks,
    collectedAt: new Date().toISOString(),
  }
}

async function collectWindows() {
  const { stdout } = await execFileP(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT],
    { windowsHide: true, timeout: 8000 },
  )
  const text = String(stdout || '').trim()
  if (!text) return null
  return normalizeLocalResources(JSON.parse(text))
}

/** 读取本机资源（CPU / 内存 / 磁盘）。非 Windows 或采集失败返回 null，不抛错、不让首页崩。 */
export async function getLocalResources({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < TTL_MS) return cache.data
  try {
    const data =
      process.platform === 'win32' ? await collectWindows() : null
    if (data) {
      cache = { at: Date.now(), data }
      return data
    }
  } catch {
    /* 采集失败（无 PowerShell / 权限）就按"无本机数据"处理 */
  }
  // 失败也写入一次缓存，避免每次 dashboard 都重跑失败的命令（TTL 内静默降级）
  if (force || !cache.data) cache = { at: Date.now(), data: null }
  return cache.data
}
