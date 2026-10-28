import { buildMappings } from './mappingService.js'
import { buildProjectViews } from './projectService.js'
import { listServerViews } from './serverService.js'

function matches(query, ...fields) {
  return fields.some((field) => {
    if (field === null || field === undefined) return false
    return String(field).toLowerCase().includes(query)
  })
}

/**
 * 全局搜索：输入 8000 能找到项目/端口，输入 Dify 能找到服务器、端口和部署目录，
 * 输入路径片段也能找到项目。
 */
export async function globalSearch(rawQuery) {
  const query = String(rawQuery || '').trim().toLowerCase()
  if (!query) return { query: '', projects: [], servers: [], ports: [], total: 0 }

  const [projectViews, servers, mappings] = await Promise.all([buildProjectViews(), listServerViews(), buildMappings()])

  const projects = projectViews.filter((view) =>
    matches(query, view.name, view.type, view.dir, view.startCommand, view.port, view.url, view.remark),
  )

  const serverHits = servers
    .map((server) => ({
      server,
      apps: (server.apps || []).filter((app) => matches(query, app.name, app.port, app.deployPath, app.url, app.remark)),
    }))
    .filter((hit) => hit.apps.length > 0 || matches(query, hit.server.name, hit.server.host, hit.server.os, hit.server.sshPort, hit.server.remark))

  const ports = mappings.rows.filter((row) => matches(query, row.port, row.app, row.owner, row.path, row.host, row.env, row.statusText))

  return {
    query,
    projects,
    servers: serverHits,
    ports,
    total: projects.length + serverHits.length + ports.length,
  }
}
