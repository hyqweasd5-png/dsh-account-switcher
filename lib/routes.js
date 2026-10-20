/**
 * Same-origin JSON API for the settings page.
 *
 * The page runs on the Host's loopback Web server. There is no RPC stub to
 * generate: the router validates a custom header, a loopback peer, and (for
 * writes) a same-origin `Origin`, then dispatches to the Host handlers.
 */

import { PlatformError, UnauthorizedError } from './platform.js'

/** Explicit HTTP failure the router can render. */
export class ApiError extends Error {
  constructor(status, message, code = 'bad-request') {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** Request body bound for every write. */
const MAX_BODY_BYTES = 64 * 1024

/** Whether an address is a loopback peer. */
function isLoopback(address) {
  const value = String(address ?? '')
  return value === '::1'
    || value === '127.0.0.1'
    || value.startsWith('127.')
    || value === '::ffff:127.0.0.1'
    || value.startsWith('::ffff:127.')
}

/** Loopback spellings a browser may use for the same local server. */
function isLoopbackHostname(hostname) {
  const value = String(hostname).toLowerCase().replace(/\.$/, '')
  return value === 'localhost'
    || value === '127.0.0.1'
    || value === '[::1]'
    || value.startsWith('127.')
}

/** Whether an Origin/Referer URL names a loopback HTTP(S) origin. */
function isLoopbackUrl(value) {
  let url
  try {
    url = new URL(String(value))
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  return isLoopbackHostname(url.hostname)
}

/**
 * Reject requests that did not come from the local settings page.
 *
 * The custom header is the CSRF gate: a cross-origin page cannot send it
 * without a preflight, and this server never answers one. The page runs on a
 * loopback Web carrier, but Electron and proxies do not always preserve the
 * browser `Origin` (it can be absent or `null`), so an absent origin must not
 * block a request that already proved it can set the header. A present origin
 * must still be loopback.
 */
function guard(req) {
  if (!isLoopback(req.socket.remoteAddress)) return new ApiError(403, '仅允许本机访问', 'forbidden')
  if (req.headers['x-account-switcher'] !== '1') return new ApiError(403, '缺少请求标记', 'forbidden')
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== 'null' && !isLoopbackUrl(origin)) {
      return new ApiError(403, `请求来源不匹配（${origin}）`, 'forbidden')
    }
  }
  return null
}

/** Read and parse a bounded JSON body. */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new ApiError(413, '请求体过大', 'too-large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const type = String(req.headers['content-type'] ?? '')
  if (!type.toLowerCase().startsWith('application/json')) throw new ApiError(415, '需要 application/json', 'unsupported-media-type')
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch {
    throw new ApiError(400, '请求体不是合法 JSON 对象', 'invalid-json')
  }
}

/** Write one JSON response. */
function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * Build the prefix-route handler.
 * @param {object} handlers - one async function per action.
 * @param {object} logger - Cordis logger (info/warn).
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createRouter(handlers, logger) {
  const routes = new Map([
    ['GET /state', handlers.state],
    ['POST /sync', handlers.sync],
    ['POST /save-current', handlers.saveCurrent],
    ['POST /import', handlers.importToken],
    ['POST /exchange', handlers.exchange],
    ['POST /sync-login', handlers.syncLogin],
    ['POST /switch', handlers.switchAccount],
    ['POST /remove', handlers.removeAccount],
    ['POST /refresh', handlers.refresh],
    ['POST /policy', handlers.setPolicy],
    ['POST /login/start', handlers.loginStart],
    ['POST /login/cancel', handlers.loginCancel],
    ['POST /debug/trigger', handlers.debugTrigger],
  ])

  return async function route(req, res) {
    try {
      const rejection = guard(req)
      if (rejection !== null) {
        logger?.warn?.(`account-switcher: request rejected (${rejection.code}); origin=${String(req.headers.origin ?? '')} host=${String(req.headers.host ?? '')} referer=${String(req.headers.referer ?? '')}`)
        send(res, rejection.status, { ok: false, error: { code: rejection.code, message: rejection.message } })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const prefix = '/account-switcher/api'
      if (!url.pathname.startsWith(prefix)) {
        send(res, 404, { ok: false, error: { code: 'not-found', message: '未知接口' } })
        return
      }
      const action = url.pathname.slice(prefix.length) || '/'
      const key = `${req.method === 'HEAD' ? 'GET' : req.method} ${action}`
      const handler = routes.get(key)
      if (handler === undefined) {
        send(res, 404, { ok: false, error: { code: 'not-found', message: `未知接口 ${key}` } })
        return
      }
      const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readBody(req)
      const result = await handler(req, body)
      send(res, 200, { ok: true, ...result })
    } catch (error) {
      if (error instanceof ApiError) {
        send(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
        return
      }
      if (error instanceof UnauthorizedError) {
        send(res, 401, { ok: false, error: { code: 'account-token-invalid', message: '账号 token 已失效' } })
        return
      }
      if (error instanceof PlatformError) {
        logger?.warn?.(`account-switcher: platform request failed (${error.status || 'network'})`)
        send(res, 502, { ok: false, error: { code: 'platform-unavailable', message: '平台请求失败，请稍后重试' } })
        return
      }
      logger?.warn?.(`account-switcher: api failure: ${String(error?.stack ?? error)}`)
      send(res, 500, { ok: false, error: { code: 'internal', message: '内部错误，请查看运行日志' } })
    }
  }
}
