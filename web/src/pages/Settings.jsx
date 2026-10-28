import { useState } from 'react'
import { api } from '../api/client.js'
import { useAsync } from '../hooks/useAsync.js'
import { useToast } from '../hooks/useToast.jsx'
import { Button, Card, ConfirmDialog, Loading, Notice } from '../components/ui.jsx'
import { PageHint } from '../components/PageHint.jsx'

export function SettingsPage() {
  const toast = useToast()
  const { data, loading, reload } = useAsync(() => api.settings(), { deps: [] })
  const [confirm, setConfirm] = useState(null)
  const [working, setWorking] = useState(false)

  async function run(action, fn) {
    setWorking(true)
    try {
      await fn()
      setConfirm(null)
      await reload()
    } catch (error) {
      toast.error(`${action}失败`, error.message)
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__title">设置</div>
        <div className="page__actions">
          <Button icon="refresh" loading={loading} onClick={() => reload().catch(() => {})}>
            刷新
          </Button>
        </div>
      </div>

      {/* 每页一次性提示：新手落地第一眼就知道这页是干嘛的（见 PageHint） */}
      <PageHint id="settings" icon="settings">
        所有数据都是明文 JSON，存在「数据目录」里，可以直接备份或纳入 Git。搞乱了可以「恢复示例数据」（原文件会先备份）。
      </PageHint>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)' }}>
        <Card title="数据与路径" icon="database">
          {loading && !data ? (
            <Loading />
          ) : (
            <div className="kv">
              <span className="kv__key">数据目录</span>
              <span className="kv__value">{data?.dataDir}</span>
              <span className="kv__key">日志目录</span>
              <span className="kv__value">{data?.logDir}</span>
              <span className="kv__key">项目记录文件</span>
              <span className="kv__value">{data?.files?.projects}</span>
              <span className="kv__key">服务器记录文件</span>
              <span className="kv__value">{data?.files?.servers}</span>
              <span className="kv__key">运行态文件</span>
              <span className="kv__value">{data?.files?.runtime}</span>
              <span className="kv__key">工作台事件日志</span>
              <span className="kv__value">{data?.files?.workbenchLog}</span>
              <span className="kv__key">前端构建目录</span>
              <span className="kv__value">
                {data?.webDistDir} {data?.webDistExists ? '（已构建）' : '（未构建，开发模式走 Vite 5180）'}
              </span>
            </div>
          )}
        </Card>

        <Card title="运行环境" icon="cpu">
          {loading && !data ? (
            <Loading />
          ) : (
            <div className="kv" style={{ gridTemplateColumns: '112px minmax(0, 1fr)' }}>
              <span className="kv__key">API 端口</span>
              <span className="kv__value">{data?.apiPort}</span>
              <span className="kv__key">Node 版本</span>
              <span className="kv__value">{data?.node}</span>
              <span className="kv__key">平台</span>
              <span className="kv__value">{data?.platform}</span>
              <span className="kv__key">主机名</span>
              <span className="kv__value">{data?.hostname}</span>
              <span className="kv__key">服务进程 PID</span>
              <span className="kv__value">{data?.pid}</span>
            </div>
          )}
        </Card>
      </div>

      <Card title="维护操作" icon="settings">
        <div className="row row--wrap" style={{ gap: 10 }}>
          <Button icon="folderOpen" onClick={() => run('打开数据目录', () => api.openDataDir())}>
            打开数据目录
          </Button>
          <Button
            icon="refresh"
            onClick={() =>
              run('重置运行态', async () => {
                const result = await api.resetRuntime()
                toast.success('运行态已重置', `清理了 ${result.dropped.length} 条已失效的 PID 记录`)
              })
            }
          >
            重置运行态
          </Button>
          <Button variant="danger" icon="alert" onClick={() => setConfirm('reseed')}>
            恢复示例数据
          </Button>
        </div>
        <Notice tone="info" icon="shield">
          数据以 JSON 明文保存在 <span className="mono">{data?.dataDir}</span>，可以直接备份、手改或纳入 Git（已在 .gitignore 中忽略）。
        </Notice>
      </Card>

      <ConfirmDialog
        open={confirm === 'reseed'}
        title="恢复示例数据"
        message="会删除当前的 projects.json / servers.json / runtime.json（原文件重命名备份），并写回示例数据。"
        confirmText="确认恢复"
        loading={working}
        onClose={() => setConfirm(null)}
        onConfirm={() =>
          run('恢复示例数据', async () => {
            await api.reseed()
            toast.success('已恢复示例数据', '原文件已备份保留在数据目录中')
          })
        }
      />
    </div>
  )
}
