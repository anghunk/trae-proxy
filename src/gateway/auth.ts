/**
 * 统一网关鉴权。
 *
 * - 管理员密码：scrypt 加盐哈希，数据库不落明文。
 * - 网关 API key：只存 sha256 哈希 + 可识别前缀；创建时展示一次。
 * - 管理会话：随机 token，数据库只存哈希。
 */

import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import type { GatewayStore } from './store.ts'

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 32
const SESSION_TTL_MS = 24 * 60 * 60 * 1000

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `scrypt:${salt}:${derived.toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const derived = Buffer.from(parts[2] ?? '', 'hex')
  const actual = scryptSync(password, parts[1] ?? '', SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })
  return derived.length === actual.length && timingSafeEqual(derived, actual)
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function generateApiKey(): { id: string; key: string; prefix: string; hash: string } {
  const id = `key_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const raw = randomBytes(24).toString('base64url')
  const prefix = `tr-${raw.slice(0, 8)}`
  const key = `${prefix}.${raw.slice(8)}`
  return { id, key, prefix, hash: hashSecret(key) }
}

export function generateSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashSecret(token) }
}

export interface ApiKeyContext {
  id: string
  name: string
  modelPrefixes: string[]
  modelIds: string[]
}

/**
 * 从 Authorization: Bearer <key> 解析并校验网关 API key。
 * 返回 undefined 表示无效/已吊销。
 */
export function authenticateApiKey(
  store: GatewayStore,
  header: string | undefined,
): ApiKeyContext | undefined {
  if (typeof header !== 'string') return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (match === null) return undefined
  const key = match[1] ?? ''
  const record = store.findApiKeyByHash(hashSecret(key))
  if (record === undefined || record.revokedAt !== undefined) return undefined
  let modelPrefixes: string[] = []
  let modelIds: string[] = []
  try {
    modelPrefixes = JSON.parse(record.modelPrefixes) as string[]
  } catch {
    modelPrefixes = []
  }
  try {
    modelIds = JSON.parse(record.modelIds) as string[]
  } catch {
    modelIds = []
  }
  if (!Array.isArray(modelPrefixes)) modelPrefixes = []
  if (!Array.isArray(modelIds)) modelIds = []
  return { id: record.id, name: record.name, modelPrefixes, modelIds }
}

export interface SessionContext {
  sessionId: string
  adminId: number
}

/** 解析管理会话 Cookie/Header 中的 token（数据库只存哈希）。 */
export function authenticateSession(store: GatewayStore, token: string | undefined): SessionContext | undefined {
  if (typeof token !== 'string' || token === '') return undefined
  const record = store.findSessionByHash(hashSecret(token))
  if (record === undefined) return undefined
  const now = Date.now()
  if (record.expiresAt <= now) {
    store.deleteSession(record.id)
    return undefined
  }
  return { sessionId: record.id, adminId: record.adminId }
}

/** 创建管理会话并返回明文 token（仅本次响应返回）。 */
export function createSession(store: GatewayStore, adminId: number): { token: string; expiresAt: number } {
  const { token, hash } = generateSessionToken()
  const now = Date.now()
  const expiresAt = now + SESSION_TTL_MS
  store.createSession({
    id: `sess_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    adminId,
    tokenHash: hash,
    createdAt: now,
    expiresAt,
  })
  return { token, expiresAt }
}

export function revokeSession(store: GatewayStore, token: string | undefined): void {
  if (typeof token !== 'string' || token === '') return
  const record = store.findSessionByHash(hashSecret(token))
  if (record !== undefined) store.deleteSession(record.id)
}
