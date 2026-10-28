import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client.js'
import { Modal, Button, Field } from './ui.jsx'

function useFormState(initial) {
  const [values, setValues] = useState(initial || {})
  useEffect(() => {
    setValues(initial || {})
  }, [initial])
  const set = (key, value) => setValues((prev) => ({ ...prev, [key]: value }))
  return { values, set, setValues }
}

/** 项目表单字段的中文名（识别结果里要说清"填了哪个空"） */
const PROJECT_FIELD_LABELS = {
  name: '项目名称',
  type: '项目类型',
  dir: '项目目录',
  startCommand: '启动命令',
  stopCommand: '停止方式',
  port: '端口',
  portEnv: '端口变量',
  portArg: '端口参数',
  url: '访问地址',
}

/** 新增 / 编辑本地项目 */
export function ProjectFormModal({ open, initial, onClose, onSubmit, submitting }) {
  const { values, set } = useFormState(initial)
  const [detect, setDetect] = useState({ busy: false, error: '', result: null })
  /**
   * 识别自动填过的字段名。用途：换候选命令时，端口/地址是"跟着命令派生"的，
   * 只要用户没手动改过，就该跟着新命令一起换；手动改过的（人的意图）不碰。
   */
  const autoFilled = useRef(new Set())

  // 弹窗换个项目打开时，清掉上一个项目的自动填写记录
  useEffect(() => {
    autoFilled.current.clear()
  }, [initial])

  const submit = () => {
    const payload = {
      name: (values.name || '').trim(),
      type: (values.type || '').trim(),
      dir: (values.dir || '').trim(),
      startCommand: (values.startCommand || '').trim(),
      stopCommand: (values.stopCommand || '').trim(),
      port: values.port === '' || values.port === undefined ? null : Number(values.port),
      // 端口冲突时的自动避让方式：环境变量（CRA/Dify）或命令行参数（vite/next/uvicorn）
      portEnv: (values.portEnv || '').trim(),
      portArg: (values.portArg || '').trim(),
      url: (values.url || '').trim() || (values.port ? `http://localhost:${values.port}` : ''),
      remark: (values.remark || '').trim(),
    }
    onSubmit(payload)
  }

  /**
   * 用户手动改字段：一旦手动改过，这个字段就不再是"识别自动填的"，
   * 之后换候选命令时不覆盖它（人的意图优先于机器的猜测）。
   * 端口手动改时，如果地址还是自动生成的 localhost 地址，跟着换端口号，
   * 避免存下一个对不上端口的访问地址。
   */
  const manual = (key) => (event) => {
    autoFilled.current.delete(key)
    set(key, event.target.value)
    if (key === 'port' && autoFilled.current.has('url')) {
      const next = String(event.target.value).replace(/\D/g, '')
      const current = values.url || ''
      if (/^http:\/\/localhost:\d+$/.test(current)) set('url', next ? `http://localhost:${next}` : '')
    }
  }

  /**
   * 识别：前端地址、项目目录，填哪个都行，两个都填更好。
   *   - 只填地址：查本机端口监听者，反推出项目目录（"只记得 localhost:5173"的场景）；
   *   - 只填目录：读 vite/next/.env/scripts 推断端口与启动命令；
   *   - 只填空白字段，已填的一律跳过（人的输入优先）。
   */
  async function runDetect() {
    const dir = (values.dir || '').trim()
    const url = (values.url || '').trim()
    if (!dir && !url) {
      setDetect({ busy: false, error: '先填前端地址（如 http://localhost:5173）或项目目录，再点「识别」', result: null })
      return
    }
    setDetect({ busy: true, error: '', result: null })
    try {
      const data = await api.detectProject({ dir, url })
      if (data?.ok === false) throw new Error(data.error || '识别失败')
      const filled = []
      const skipped = []
      for (const [key, value] of Object.entries(data?.fields || {})) {
        if (value === undefined || value === null || value === '') continue
        const current = values[key]
        const empty = current === undefined || current === null || current === ''
        if (empty) {
          set(key, value)
          autoFilled.current.add(key)
          filled.push(PROJECT_FIELD_LABELS[key] || key)
        } else {
          skipped.push(PROJECT_FIELD_LABELS[key] || key)
        }
      }
      setDetect({ busy: false, error: '', result: { ...data, filled, skipped } })
    } catch (err) {
      setDetect({ busy: false, error: err.message || '识别失败', result: null })
    }
  }

  return (
    <Modal
      open={open}
      title={initial?.id ? `编辑项目 · ${initial.name}` : '新增本地项目'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" icon="check" loading={submitting} onClick={submit}>
            保存
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="项目名称 *">
          <input className="input" value={values.name || ''} placeholder="例如 Family Album" onChange={(event) => set('name', event.target.value)} />
        </Field>
        <Field label="项目类型" hint="Vue3 / React / FastAPI / Docker / 数据库 …">
          <input className="input" value={values.type || ''} placeholder="Vue3" onChange={(event) => set('type', event.target.value)} />
        </Field>
        <Field
          label="前端地址"
          full
          hint="粘贴 http://localhost:5173 —— 自动反查目录和启动命令；端口被别的程序占了会自动换一个空闲端口"
        >
          <div className="pdet">
            <input className="input input--tech" value={values.url || ''} placeholder="http://localhost:5173" onChange={manual('url')} />
            <Button size="sm" icon="search" loading={detect.busy} onClick={runDetect}>
              识别
            </Button>
          </div>
        </Field>
        <Field label="项目目录" full hint="Windows 路径，例如 D:\projects\family-album（只填地址也能反查出来）">
          <input className="input input--tech" value={values.dir || ''} placeholder="D:\projects\my-app" onChange={(event) => set('dir', event.target.value)} />
        </Field>
        <Field label="启动命令" full hint="在项目目录下执行，例如 npm run dev / python -m uvicorn main:app --port 8000">
          <input className="input input--tech" value={values.startCommand || ''} placeholder="npm run dev" onChange={manual('startCommand')} />
        </Field>
        <Field label="停止方式" full hint="留空 = 结束该项目进程树（推荐）；也可填 docker compose down 之类的命令">
          <input className="input input--tech" value={values.stopCommand || ''} placeholder="留空即可" onChange={(event) => set('stopCommand', event.target.value)} />
        </Field>
        <Field label="端口" hint="留空会从地址或配置里推断；被占时自动换空闲端口启动">
          <input className="input input--tech" value={values.port ?? ''} placeholder="5173" onChange={manual('port')} />
        </Field>
        <Field label="备注" full>
          <textarea className="textarea" value={values.remark || ''} placeholder="这个项目是做什么的、注意事项…" onChange={(event) => set('remark', event.target.value)} />
        </Field>
      </div>

      {/* 识别结果放在 grid 外：双列网格会把它挤进一列，说明文字要横着占满才好读 */}
      {detect.error ? <p className="pdet__msg pdet__msg--warn pdet__error">{detect.error}</p> : null}
      {detect.result ? (
        <div className="pdet__result">
          {detect.result.knownProject ? (
            <p className="pdet__msg pdet__msg--ok">
              已记住：这个{detect.result.knownProject.matchedBy}是项目「{detect.result.knownProject.name}」——
              不用重复添加，直接去本地项目页点启动。
            </p>
          ) : null}
          {detect.result.portPlan ? (
            <p className={`pdet__msg ${detect.result.portPlan.status === 'free' || detect.result.portPlan.status === 'in-use' ? 'pdet__msg--ok' : 'pdet__msg--warn'}`}>
              {detect.result.portPlan.message}
              {detect.result.portPlan.status === 'shifted' ? '（地址已按这个端口改写）' : ''}
            </p>
          ) : detect.result.live?.listening && detect.result.live.owners?.[0] ? (
            <p className="pdet__msg">
              端口 {detect.result.live.port} 正在监听：{detect.result.live.owners[0].processName}
              （PID {detect.result.live.owners[0].pid}）
            </p>
          ) : null}
          {detect.result.filled.length > 0 ? <p className="pdet__msg pdet__msg--ok">已填入：{detect.result.filled.join('、')}</p> : null}
          {detect.result.skipped.length > 0 ? (
            <p className="pdet__msg">已跳过（这些字段你填过了）：{detect.result.skipped.join('、')}</p>
          ) : null}
          {detect.result.matched?.length > 0 ? <p className="pdet__msg">读到的项目文件：{detect.result.matched.join('、')}</p> : null}
          {(detect.result.notes || []).map((note) => (
            <p className="pdet__msg pdet__msg--warn" key={note}>
              {note}
            </p>
          ))}
          {(detect.result.ports || []).length > 1 ? (
            <div className="pdet__chips">
              <span className="pdet__chips-label">换个端口：</span>
              {detect.result.ports.slice(0, 4).map((item) => (
                <button
                  type="button"
                  key={`${item.port}-${item.source}`}
                  className="pdet__chip"
                  title={`${item.source}：${item.evidence}`}
                  onClick={() => {
                    set('port', item.port)
                    autoFilled.current.add('port')
                    if (!values.url || autoFilled.current.has('url')) {
                      set('url', `http://localhost:${item.port}`)
                      autoFilled.current.add('url')
                    }
                  }}
                >
                  {item.port}
                  <span className="pdet__chip-hint">{item.source}</span>
                </button>
              ))}
            </div>
          ) : null}
          {(detect.result.candidates?.startCommand || []).length > 1 ? (
            <div className="pdet__chips">
              <span className="pdet__chips-label">换条启动命令：</span>
              {detect.result.candidates.startCommand.map((item) => (
                <button
                  type="button"
                  key={item.command}
                  className="pdet__chip"
                  title={item.why}
                  onClick={() => {
                    set('startCommand', item.command)
                    if (!item.port) return
                    // 端口与命令是派生关系：空着、或还是识别自动填的，就跟着新命令换；
                    // 用户手动填过的端口是明确意图，不碰。
                    const portIsAuto = !values.port || autoFilled.current.has('port')
                    if (!portIsAuto) return
                    set('port', item.port)
                    autoFilled.current.add('port')
                    if (!values.url || autoFilled.current.has('url')) {
                      set('url', `http://localhost:${item.port}`)
                      autoFilled.current.add('url')
                    }
                  }}
                >
                  {item.command}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  )
}

/**
 * 给 AI 的执行指令：自包含，不依赖 AI 是否装了 zhaowu-server-import 技能。
 * 三段——端点 / 三步流程 / 红线，缺一段 AI 就容易跳步或编字段。
 */
const AI_IMPORT_PROMPT = `帮我在「昭武工作台」里新增一台服务器。

后端：http://127.0.0.1:8787/api （本机回环，curl 一律加 --noproxy 127.0.0.1，否则会被本机代理劫持成 502）

请按这三步走，不要跳步：
1. 解析——POST /api/servers/quick-fill，body 为 {"text":"<我的连接信息>"}，返回 {fields, matched, notes}。
2. 补全——fields 只含识别到的字段。把必填项缺失的问我，可选项用默认值并明确告诉我你补了什么；确认后再提交。
3. 落库并探活——POST /api/servers 建记录，拿到 id 后必须再跑
   POST /api/servers/<id>/probe（TCP）和 POST /api/servers/<id>/probe-ssh（SSH 只读监控），
   两层都跑完才可以说"配好了"。

红线：
- 绝不提交 password / passphrase / 私钥正文，只允许 keyPath（私钥路径）和 passwordEnv（环境变量名）。
- 解析不出来就问我，不要编造 host / 用户名 / 端口。
- 不要修改我已有的服务器记录。
- 探活失败要帮我分辨是超时（安全组/端口）、publickey（私钥或 authorized_keys）、还是首次连接的 host key 指纹确认。

我的连接信息：
`

function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text)
  }
  // 兜底：非安全上下文下 clipboard API 不可用
  const area = document.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  try {
    document.execCommand('copy')
    return Promise.resolve()
  } catch (err) {
    return Promise.reject(err)
  } finally {
    document.body.removeChild(area)
  }
}

/**
 * 服务器「快速填入」：粘贴一段文本，自动拆成表单字段。
 * 口径与后端一致——只填空字段、不覆盖用户已填的内容、解析不出就如实说明。
 */
export function ServerQuickFill({ values, set }) {
  const [text, setText] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  async function apply() {
    const value = text.trim()
    if (!value) return
    setBusy(true)
    setError('')
    try {
      const data = await api.serverQuickFill(value)
      const fields = data?.fields || {}
      // 只填空字段：已经手工填过的一律保留
      const filled = []
      const skipped = []
      for (const [key, fieldValue] of Object.entries(fields)) {
        const current = values[key]
        const empty = current === undefined || current === null || current === ''
        if (empty) {
          set(key, fieldValue)
          filled.push(FIELD_LABELS[key] || key)
        } else {
          skipped.push(FIELD_LABELS[key] || key)
        }
      }
      setResult({
        matched: data?.matched || [],
        notes: data?.notes || [],
        filled,
        skipped,
      })
    } catch (err) {
      setError(err.message || '识别失败')
      setResult(null)
    } finally {
      setBusy(false)
    }
  }

  async function copyAiPrompt() {
    const tail = text.trim() || '<把你的 ssh 命令 / IP、端口、用户名 粘在这里>'
    try {
      await copyText(AI_IMPORT_PROMPT + tail)
      setCopied(true)
      setError('')
      window.setTimeout(() => setCopied(false), 2400)
    } catch (err) {
      setError('复制失败，请手动选中说明文字复制')
    }
  }

  return (
    <div className="quickfill">
      <div className="quickfill__head">
        <span className="quickfill__title">快速填入</span>
        <span className="quickfill__sub">粘贴下面任意一种，识别到的空字段会自动填好</span>
      </div>
      <textarea
        className="textarea quickfill__input"
        value={text}
        placeholder={'ssh -p 2222 -i ~/.ssh/id_ed25519 root@203.0.113.10\n或：deploy@203.0.113.10:2022\n或 .ssh/config 片段 / 云控制台复制的「IP 地址、用户名、端口」'}
        onChange={(event) => {
          setText(event.target.value)
          setResult(null)
          setError('')
        }}
      />
      <div className="quickfill__actions">
        <Button className="quickfill__ai-btn" icon="send" onClick={copyAiPrompt}>
          {copied ? '已复制，去粘给 AI' : '让 AI 帮我配'}
        </Button>
        <Button icon="refresh" loading={busy} disabled={!text.trim()} onClick={apply}>
          识别并填入
        </Button>
      </div>
      <p className="quickfill__hint">
        「让 AI 帮我配」会把一段配置指令复制到剪贴板（已填的连接信息一并带上），粘到 AI 对话框里，
        它会自己解析、建档、双层探活；不会写入密码或私钥正文。
      </p>

      {error ? <p className="quickfill__msg quickfill__msg--warn">{error}</p> : null}

      {result ? (
        <div className="quickfill__result">
          {result.filled.length > 0 ? (
            <p className="quickfill__msg quickfill__msg--ok">已填入：{result.filled.join('、')}</p>
          ) : null}
          {result.skipped.length > 0 ? (
            <p className="quickfill__msg">已跳过（这些字段你填过了）：{result.skipped.join('、')}</p>
          ) : null}
          {result.matched.length > 0 ? <p className="quickfill__msg">识别为：{result.matched.join(' + ')}</p> : null}
          {result.notes.map((note) => (
            <p className="quickfill__msg quickfill__msg--warn" key={note}>
              {note}
            </p>
          ))}
          {!result.filled.length && !result.skipped.length && !result.notes.length ? (
            <p className="quickfill__msg quickfill__msg--warn">没识别出可用信息，可直接手工填写</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const FIELD_LABELS = {
  name: '名称',
  host: 'IP/域名',
  os: '操作系统',
  sshPort: 'SSH 端口',
  username: '登录用户',
  authType: '认证方式',
  keyPath: '私钥路径',
  passwordEnv: '密码来源',
  remark: '备注',
}

/** 新增 / 编辑服务器（含第二阶段 SSH 只读监控连接配置） */
export function ServerFormModal({ open, initial, onClose, onSubmit, submitting }) {
  const { values, set } = useFormState(initial)
  const authType = values.authType || 'key'

  const submit = () => {
    onSubmit({
      name: (values.name || '').trim(),
      host: (values.host || '').trim(),
      os: (values.os || '').trim(),
      sshPort: values.sshPort === '' || values.sshPort === undefined ? 22 : Number(values.sshPort),
      user: (values.username || values.user || '').trim(),
      username: (values.username || values.user || '').trim(),
      authType,
      keyPath: (values.keyPath || '').trim(),
      passwordEnv: (values.passwordEnv || '').trim(),
      passphraseEnv: (values.passphraseEnv || '').trim(),
      connectTimeout: values.connectTimeout === '' || values.connectTimeout === undefined ? 8000 : Number(values.connectTimeout),
      monitorEnabled: values.monitorEnabled === undefined ? true : Boolean(values.monitorEnabled),
      logPaths: String(values.logPathsText || '')
        .split(/[\r\n,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
      remark: (values.remark || '').trim(),
    })
  }

  return (
    <Modal
      open={open}
      title={initial?.id ? `编辑服务器 · ${initial.name}` : '新增服务器'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" icon="check" loading={submitting} onClick={submit}>
            保存
          </Button>
        </>
      }
    >
      <div className="form-grid">
        {initial?.id ? null : <ServerQuickFill values={values} set={set} />}
        <Field label="服务器名称 *">
          <input className="input" value={values.name || ''} placeholder="主服务器" onChange={(event) => set('name', event.target.value)} />
        </Field>
        <Field label="IP / 域名 *">
          <input className="input input--tech" value={values.host || ''} placeholder="203.0.113.10 或 server.example.com" onChange={(event) => set('host', event.target.value)} />
        </Field>
        <Field label="操作系统">
          <input className="input" value={values.os || ''} placeholder="Ubuntu 22.04" onChange={(event) => set('os', event.target.value)} />
        </Field>
        <Field label="SSH 端口">
          <input className="input input--tech" value={values.sshPort ?? ''} placeholder="22" onChange={(event) => set('sshPort', event.target.value)} />
        </Field>
        <Field label="登录用户">
          <input className="input input--tech" value={values.username || values.user || ''} placeholder="root" onChange={(event) => set('username', event.target.value)} />
        </Field>
        <Field label="认证方式">
          <select className="select" value={authType} onChange={(event) => set('authType', event.target.value)}>
            <option value="key">密钥文件（推荐）</option>
            <option value="agent">本机 SSH Agent</option>
            <option value="password">密码（从环境变量/凭据文件读取）</option>
          </select>
        </Field>

        {authType === 'key' ? (
          <>
            <Field label="私钥路径" full hint="只保存路径，不保存私钥正文；支持 ~ 开头的路径">
              <input
                className="input input--tech"
                value={values.keyPath || ''}
                placeholder="C:\Users\you\.ssh\id_ed25519 或 ~/.ssh/id_ed25519"
                onChange={(event) => set('keyPath', event.target.value)}
              />
            </Field>
            <Field label="私钥口令环境变量名" hint="私钥有口令时填写变量名，口令本身不会写入配置">
              <input
                className="input input--tech"
                value={values.passphraseEnv || ''}
                placeholder="DSM_SSH_PASSPHRASE_XXX"
                onChange={(event) => set('passphraseEnv', event.target.value)}
              />
            </Field>
          </>
        ) : null}

        {authType === 'password' ? (
          <Field
            label="密码环境变量名"
            full
            hint="安全约定：配置文件里永不保存密码。请把密码放到环境变量（默认 DSM_SSH_PASSWORD_<服务器ID>）或项目内 data/secrets.json"
          >
            <input
              className="input input--tech"
              value={values.passwordEnv || ''}
              placeholder="留空则使用 DSM_SSH_PASSWORD_<服务器ID>"
              onChange={(event) => set('passwordEnv', event.target.value)}
            />
          </Field>
        ) : null}

        <Field label="连接超时（毫秒）" hint="2000 - 60000，默认 8000">
          <input
            className="input input--tech"
            value={values.connectTimeout ?? ''}
            placeholder="8000"
            onChange={(event) => set('connectTimeout', event.target.value)}
          />
        </Field>
        <Field label="SSH 监控">
          <select
            className="select"
            value={values.monitorEnabled === false ? 'off' : 'on'}
            onChange={(event) => set('monitorEnabled', event.target.value === 'on')}
          >
            <option value="on">开启（采集资源与真实端口）</option>
            <option value="off">关闭（只做 TCP 探测）</option>
          </select>
        </Field>

        <Field label="可读日志路径" full hint="每行一个绝对路径，只允许读取这些文件；日志查看页没有命令输入框">
          <textarea
            className="textarea"
            value={values.logPathsText ?? (values.logPaths || []).join('\n')}
            placeholder={'/var/log/nginx/error.log\n/var/log/syslog'}
            onChange={(event) => set('logPathsText', event.target.value)}
          />
        </Field>

        <Field label="备注" full>
          <input className="input" value={values.remark || ''} placeholder="用途说明" onChange={(event) => set('remark', event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

/** 新增 / 编辑服务器下的 APP 记录 */
export function AppFormModal({ open, initial, serverName, onClose, onSubmit, submitting }) {
  const { values, set } = useFormState(initial)

  const submit = () => {
    onSubmit({
      name: (values.name || '').trim(),
      port: values.port === '' || values.port === undefined ? null : Number(values.port),
      deployPath: (values.deployPath || '').trim(),
      url: (values.url || '').trim(),
      status: values.status || 'unknown',
      remark: (values.remark || '').trim(),
    })
  }

  return (
    <Modal
      open={open}
      title={initial?.id ? `编辑应用 · ${initial.name}` : `新增应用 / 服务${serverName ? ` · ${serverName}` : ''}`}
      size="md"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" icon="check" loading={submitting} onClick={submit}>
            保存
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="APP / 服务名称 *" hint="例如 Nginx、Dify Web、Ollama API">
          <input className="input" value={values.name || ''} placeholder="Dify Web" onChange={(event) => set('name', event.target.value)} />
        </Field>
        <Field label="端口">
          <input className="input" value={values.port ?? ''} placeholder="8080" onChange={(event) => set('port', event.target.value)} />
        </Field>
        <Field label="部署路径" full hint="服务器上的实际路径，例如 /opt/dify">
          <input className="input input--tech" value={values.deployPath || ''} placeholder="/opt/dify" onChange={(event) => set('deployPath', event.target.value)} />
        </Field>
        <Field label="访问地址">
          <input className="input input--tech" value={values.url || ''} placeholder="http://203.0.113.10:8080" onChange={(event) => set('url', event.target.value)} />
        </Field>
        <Field label="状态">
          <select className="select" value={values.status || 'unknown'} onChange={(event) => set('status', event.target.value)}>
            <option value="running">运行中</option>
            <option value="stopped">已停止</option>
            <option value="unknown">未知</option>
          </select>
        </Field>
        <Field label="备注" full>
          <textarea className="textarea" value={values.remark || ''} onChange={(event) => set('remark', event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
