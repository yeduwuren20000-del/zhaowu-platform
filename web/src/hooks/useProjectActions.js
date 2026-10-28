import { useState } from 'react'
import { api } from '../api/client.js'
import { useEmbed } from './useEmbed.jsx'
import { useToast } from './useToast.jsx'

/**
 * 项目操作统一入口：启动 / 停止 / 重启 / 打开目录 / 打开网页 / 复制路径。
 * 所有页面共用，避免把交互逻辑散落在各页面里。
 */
export function useProjectActions(onChanged) {
  const toast = useToast()
  const embed = useEmbed()
  const [busy, setBusy] = useState({})

  async function exec(project, action, fn, onResult) {
    setBusy((prev) => ({ ...prev, [project.id]: action }))
    try {
      const data = await fn()
      onResult?.(data, toast, project)
      await onChanged?.()
      return data
    } catch (error) {
      toast.error(`${project.name}：操作失败`, error.message)
      return null
    } finally {
      setBusy((prev) => {
        const next = { ...prev }
        delete next[project.id]
        return next
      })
    }
  }

  return {
    busy,
    actionOf: (id) => busy[id],
    start: (project) =>
      exec(project, 'start', () => api.startProject(project.id), (data, t) => {
        const result = data.result
        if (result.running) {
          t.success(`${project.name} 已启动`, `${result.message}${result.portWarning ? ` · ${result.portWarning}` : ''}`)
        } else if (result.diagnosis) {
          // 有诊断：标题说人话，摘要给出第一步（完整建议留在卡片横幅里）
          t.warn(`${project.name}：${result.diagnosis.title}`, result.diagnosis.summary)
        } else {
          t.warn(`${project.name} 启动未就绪`, result.message)
        }
      }),
    stop: (project) =>
      exec(project, 'stop', () => api.stopProject(project.id), (data, t) => {
        const result = data.result
        if (result.portReleased) {
          t.success(`${project.name} 已停止`, result.killed?.length ? `已结束进程：${result.killed.map((item) => item.pid).join(', ')}` : '没有需要结束的进程')
        } else {
          t.warn(`${project.name} 端口未释放`, result.skipped?.map((item) => item.reason).join('；') || '请查看日志')
        }
      }),
    restart: (project) =>
      exec(project, 'restart', () => api.restartProject(project.id), (data, t) => {
        const result = data.result.started
        if (result.running) t.success(`${project.name} 已重启`, result.message)
        else if (result.diagnosis) t.warn(`${project.name}：${result.diagnosis.title}`, result.diagnosis.summary)
        else t.warn(`${project.name} 重启后未就绪`, result.message)
      }),
    openDir: (project) => exec(project, 'open-dir', () => api.openProjectDir(project.id), (data, t) => t.info('已打开项目目录', data.opened)),
    openUrl: (project) =>
      exec(
        project,
        'open-url',
        async () => {
          // 只向后端问"该开哪个地址"，进程一个都不起（省掉 cmd.exe 的几百毫秒）
          const data = await api.openProjectUrl(project.id)
          // 在工作台内部用 iframe 打开：没有新窗口的建窗白屏期，从头到尾看不到白色。
          // 抽屉顶部仍留「新窗口」出口，站点禁止内嵌时由用户显式选择。
          embed.openEmbed({ url: data.url, name: project.name })
          return data
        },
        // 内嵌打开是即时的，不弹 toast——抽屉本身就是反馈，再多一句反而吵
        null,
      ),
    copyPath: (project) => exec(project, 'copy', () => api.copyProject(project.id, 'path'), (data, t) => t.success('路径已复制到剪贴板', data.copied)),
    copyUrl: (project) => exec(project, 'copy', () => api.copyProject(project.id, 'url'), (data, t) => t.success('地址已复制到剪贴板', data.copied)),
  }
}
