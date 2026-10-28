import { randomUUID } from 'node:crypto'

export function makeId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`
}

export function nowIso() {
  return new Date().toISOString()
}
