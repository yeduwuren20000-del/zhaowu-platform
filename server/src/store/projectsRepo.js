import { createJsonStore } from './jsonStore.js'
import { FILES, PROJECT_ROOT } from '../config.js'
import { makeId, nowIso } from '../utils/ids.js'
import { notFound } from '../utils/http.js'

/** 首次运行时的示例数据（可自由编辑或删除） */
function seedProjects() {
  const now = nowIso()
  const items = [
    {
      id: makeId('prj'),
      name: 'DevServerManager',
      type: 'React + Vite',
      dir: PROJECT_ROOT,
      startCommand: 'npm run dev',
      stopCommand: '',
      port: 5180,
      url: 'http://localhost:5180',
      remark: '本工作台自身（开发模式：API 8787 + 前端 5180）',
      accent: 'blue',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: makeId('prj'),
      name: 'Family Album',
      type: 'Vue3',
      dir: 'D:\\projects\\family-album',
      startCommand: 'npm run dev',
      stopCommand: '',
      port: 5173,
      url: 'http://localhost:5173',
      remark: '示例数据：家庭相册，改成自己的目录即可',
      accent: 'teal',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: makeId('prj'),
      name: 'Robot Vision',
      type: 'FastAPI',
      dir: 'D:\\projects\\robot-vision',
      startCommand: 'python -m uvicorn main:app --reload --port 8000',
      stopCommand: '',
      port: 8000,
      url: 'http://localhost:8000',
      remark: '示例数据：Python 服务',
      accent: 'green',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: makeId('prj'),
      name: 'Dify',
      type: 'Docker',
      dir: 'D:\\tools\\dify',
      startCommand: 'docker compose up -d',
      stopCommand: 'docker compose down',
      port: 8080,
      url: 'http://localhost:8080',
      remark: '示例数据：容器编排，端口发布到 8080',
      accent: 'indigo',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: makeId('prj'),
      name: 'Ollama',
      type: '本地服务',
      dir: 'D:\\tools\\ollama',
      startCommand: 'ollama serve',
      stopCommand: '',
      port: 11434,
      url: 'http://localhost:11434',
      remark: '示例数据：本地大模型 API',
      accent: 'purple',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: makeId('prj'),
      name: 'MySQL',
      type: '数据库',
      dir: 'C:\\Program Files\\MySQL\\MySQL Server 8.0',
      startCommand: 'net start MySQL80',
      stopCommand: 'net stop MySQL80',
      port: 3306,
      url: '',
      remark: '示例数据：Windows 服务方式启停',
      accent: 'amber',
      createdAt: now,
      updatedAt: now,
    },
  ]
  return { version: 1, items }
}

const store = createJsonStore(FILES.projects, {
  seed: seedProjects,
  isValid: (value) => Boolean(value) && Array.isArray(value?.items),
})

export const projectsRepo = {
  file: FILES.projects,

  async list() {
    const data = await store.read()
    return data.items
  },

  async get(id) {
    const items = await projectsRepo.list()
    const found = items.find((item) => item.id === id)
    if (!found) throw notFound(`项目不存在：${id}`)
    return found
  },

  async find(id) {
    const items = await projectsRepo.list()
    return items.find((item) => item.id === id) || null
  },

  async create(input) {
    return store.mutate((data) => {
      const now = nowIso()
      const item = {
        id: makeId('prj'),
        ...input,
        services: Array.isArray(input.services) ? input.services : [],
        createdAt: now,
        updatedAt: now,
      }
      data.items.push(item)
      return item
    })
  },

  async update(id, patch) {
    return store.mutate((data) => {
      const index = data.items.findIndex((item) => item.id === id)
      if (index < 0) throw notFound(`项目不存在：${id}`)
      const next = { ...data.items[index], ...patch, updatedAt: nowIso() }
      data.items[index] = next
      return next
    })
  },

  async remove(id) {
    return store.mutate((data) => {
      const index = data.items.findIndex((item) => item.id === id)
      if (index < 0) throw notFound(`项目不存在：${id}`)
      const [removed] = data.items.splice(index, 1)
      return removed
    })
  },

  /** 恢复示例数据（原文件会备份保留） */
  async reset() {
    return store.reset()
  },

  // ---- 第五阶段：项目下的子服务（多进程 / 多端口） ----

  async listServices(projectId) {
    const project = await projectsRepo.get(projectId)
    return Array.isArray(project.services) ? project.services : []
  },

  async addService(projectId, service) {
    return store.mutate((data) => {
      const index = data.items.findIndex((item) => item.id === projectId)
      if (index < 0) throw notFound(`项目不存在：${projectId}`)
      const project = data.items[index]
      const services = Array.isArray(project.services) ? project.services : []
      const item = { id: makeId('svc'), createdAt: nowIso(), ...service }
      data.items[index] = { ...project, services: [...services, item], updatedAt: nowIso() }
      return item
    })
  },

  async updateService(projectId, serviceId, patch) {
    return store.mutate((data) => {
      const index = data.items.findIndex((item) => item.id === projectId)
      if (index < 0) throw notFound(`项目不存在：${projectId}`)
      const project = data.items[index]
      const services = Array.isArray(project.services) ? project.services : []
      const serviceIndex = services.findIndex((item) => item.id === serviceId)
      if (serviceIndex < 0) throw notFound(`子服务不存在：${serviceId}`)
      const next = [...services]
      next[serviceIndex] = { ...services[serviceIndex], ...patch, updatedAt: nowIso() }
      data.items[index] = { ...project, services: next, updatedAt: nowIso() }
      return next[serviceIndex]
    })
  },

  async removeService(projectId, serviceId) {
    return store.mutate((data) => {
      const index = data.items.findIndex((item) => item.id === projectId)
      if (index < 0) throw notFound(`项目不存在：${projectId}`)
      const project = data.items[index]
      const services = Array.isArray(project.services) ? project.services : []
      const serviceIndex = services.findIndex((item) => item.id === serviceId)
      if (serviceIndex < 0) throw notFound(`子服务不存在：${serviceId}`)
      const next = [...services]
      const [removed] = next.splice(serviceIndex, 1)
      data.items[index] = { ...project, services: next, updatedAt: nowIso() }
      return removed
    })
  },
}
