/**
 * Minimal Platform client for accounts that are not the active grant.
 *
 * The account service can only read profile and balance for the *current*
 * credential. The switcher needs every saved account, so it speaks the same
 * two read-only Platform endpoints directly. Tokens stay in this process and
 * are never logged or returned to the browser.
 */

import { createHash, randomBytes } from 'node:crypto'

/** The Platform rejected the grant with HTTP 401 or business code 40003. */
export class UnauthorizedError extends Error {
  constructor() {
    super('account unauthorized')
    this.name = 'UnauthorizedError'
    this.code = 'ACCOUNT_TOKEN_INVALID'
  }
}

/** A Platform request failed without proving the grant invalid. */
export class PlatformError extends Error {
  constructor(reason, status = 0, bizCode = null) {
    super(`platform ${reason}`)
    this.name = 'PlatformError'
    this.code = reason === 'network' ? 'ACCOUNT_NETWORK' : 'ACCOUNT_PROTOCOL'
    this.status = status
    this.bizCode = bizCode
  }
}

/** Response body bound; profile and balance payloads are far smaller. */
const MAX_BODY_BYTES = 64 * 1024
/** Per-request deadline. */
const REQUEST_TIMEOUT_MS = 30000

/**
 * Validate a Platform origin.
 * @param {string} value - configured origin.
 * @param {boolean} allowLoopbackHttp - development-only HTTP opt-in.
 * @returns {string} normalized origin without a trailing slash.
 */
export function normalizeOrigin(value, allowLoopbackHttp = false) {
  let url
  try {
    url = new URL(String(value))
  } catch {
    throw new Error('platformOrigin 不是合法 URL')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  const allowed = url.protocol === 'https:' || (allowLoopbackHttp && loopback && url.protocol === 'http:')
  if (!allowed || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('platformOrigin 必须是 HTTPS 源，或显式允许的 loopback HTTP 源')
  }
  return url.origin
}

/** Platform wire locale from an arbitrary UI language. */
function wireLocale(locale) {
  return String(locale ?? '').toLowerCase().startsWith('zh') ? 'zh_CN' : 'en_US'
}

/** The five client identity headers the Platform expects. */
export function clientHeaders(client, version) {
  return {
    'x-client-bundle-id': '',
    'x-client-platform': process.platform === 'darwin' ? 'desktop-mac' : process.platform === 'win32' ? 'desktop-win' : 'web',
    'x-client-version': String(client?.version || version || '0.2.1-rc.2'),
    'x-client-locale': wireLocale(client?.locale),
    'x-client-timezone-offset': String(Math.trunc(Number(client?.timezoneOffsetSeconds) || 0)),
  }
}

/**
 * Read one bounded Platform response and unwrap the business envelope.
 * @param {string} origin - normalized Platform origin.
 * @param {'/auth-api/v0/users/current'|'/api/v0/users/get_user_summary'} path - fixed endpoint.
 * @param {string} token - account grant.
 * @param {object} client - client metadata for identity headers.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<unknown>} `data.biz_data`.
 */
async function readEnvelope(response) {
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined)
    throw new UnauthorizedError()
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => undefined)
    throw new PlatformError('network', response.status)
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new PlatformError('protocol', response.status)
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new PlatformError('protocol', response.status)
  }
  if (payload?.code === 40003) throw new UnauthorizedError()
  if (payload === null || typeof payload !== 'object' || payload.code !== 0) {
    throw new PlatformError('protocol', response.status, payload?.data?.biz_code ?? payload?.code ?? null)
  }
  const data = payload.data
  if (data === null || typeof data !== 'object' || data.biz_code !== 0) {
    throw new PlatformError('protocol', response.status, data?.biz_code ?? null)
  }
  return data.biz_data
}

async function request(origin, path, token, client, signal, version) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const fused = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  let response
  try {
    response = await fetch(`${origin}${path}`, {
      method: 'GET',
      headers: {
        ...clientHeaders(client, version),
        'x-dsh-auth-token': token,
        accept: 'application/json',
      },
      redirect: 'error',
      signal: fused,
    })
  } catch (error) {
    if (fused.aborted && !timeout.aborted) throw error
    throw new PlatformError('network')
  }
  return readEnvelope(response)
}

async function postEnvelope(origin, path, body, headers, client, signal, version) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const fused = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  let response
  try {
    response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        ...clientHeaders(client, version),
        'content-type': 'application/json',
        accept: 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: fused,
    })
  } catch (error) {
    if (fused.aborted && !timeout.aborted) throw error
    throw new PlatformError('network')
  }
  return readEnvelope(response)
}

/**
 * Exchange a signed-in platform Web token for a DSH account grant.
 *
 * This is the same sequence the platform's own /dsh/authorize page uses:
 * auth_init creates a pending authorization, auth_approve approves it with the
 * caller's platform session, and auth_exchange redeems the callback code for a
 * DSH grant. The Web token is used once and never returned.
 *
 * @param {object} input - exchange inputs.
 * @param {string} input.origin - normalized platform origin.
 * @param {string} input.webToken - platform Web session token (Bearer).
 * @param {string} input.redirectUri - loopback callback URI used by auth_init.
 * @param {object} input.client - client metadata.
 * @param {string} input.deviceId - shared DSH device record id.
 * @param {string} input.deviceModel - device model string.
 * @param {string} input.osVersion - OS version string.
 * @param {AbortSignal} [input.signal] - cancellation.
 * @param {string} [input.version] - x-client-version.
 * @returns {Promise<{token: string, user: unknown}>} the new DSH grant.
 */
export async function exchangeWebToken(input) {
  const { origin, webToken, redirectUri, client, deviceId, deviceModel, osVersion, signal, version } = input
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(32).toString('base64url')
  const init = await postEnvelope(origin, '/auth-api/v0/dsh/auth_init', {
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    redirect_uri: redirectUri,
    locale: wireLocale(client?.locale),
    login_source: 'web',
  }, {}, client, signal, version)
  if (init === null || typeof init !== 'object' || typeof init.authorize_id !== 'string' || init.authorize_id === '') {
    throw new PlatformError('protocol')
  }
  const approve = await postEnvelope(origin, '/auth-api/v0/dsh/auth_approve', {
    authorize_id: init.authorize_id,
  }, { authorization: `Bearer ${webToken}` }, client, signal, version)
  const callbackUrl = approve?.callback_url
  if (typeof callbackUrl !== 'string' || callbackUrl === '') throw new PlatformError('protocol')
  let callback
  try {
    callback = new URL(callbackUrl)
  } catch {
    throw new PlatformError('protocol')
  }
  let redirect
  try {
    redirect = new URL(redirectUri)
  } catch {
    throw new PlatformError('protocol')
  }
  if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname) throw new PlatformError('protocol')
  if (callback.searchParams.get('state') !== state) throw new PlatformError('protocol')
  const code = callback.searchParams.get('code')
  if (code === null || code === '') throw new PlatformError('protocol')
  const exchanged = await postEnvelope(origin, '/auth-api/v0/dsh/auth_exchange', {
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    device_id: deviceId,
    device_model: deviceModel,
    os_version: osVersion,
  }, {}, client, signal, version)
  if (exchanged === null || typeof exchanged !== 'object' || typeof exchanged.token !== 'string' || exchanged.token === '') {
    throw new PlatformError('protocol')
  }
  return { token: exchanged.token, user: exchanged.user ?? null }
}

/**
 * Read the account profile behind one grant.
 * @param {string} origin - Platform origin.
 * @param {object} grant - `{token, issuer}`.
 * @param {object} client - client metadata.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<{uid: string|null, name: string|null, contact: string|null, avatarUrl: string|null}>}
 */
export async function fetchProfile(origin, grant, client, signal, version) {
  const body = await request(origin, '/auth-api/v0/users/current', grant.token, client, signal, version)
  if (body === null || typeof body !== 'object') throw new PlatformError('protocol')
  const identity = body.id_profile !== null && typeof body.id_profile === 'object' ? body.id_profile : {}
  const contact = [body.mobile, body.mobile_number, body.email].find((value) => typeof value === 'string' && value !== '') ?? null
  return {
    uid: typeof body.id === 'string' && body.id !== '' ? body.id : null,
    name: typeof identity.name === 'string' && identity.name !== '' ? identity.name : null,
    contact,
    avatarUrl: typeof identity.picture === 'string' && identity.picture !== '' ? identity.picture : null,
  }
}

/** Keep only wallet rows the UI can render. */
function wallets(value) {
  if (!Array.isArray(value)) return []
  return value.filter((wallet) => wallet !== null && typeof wallet === 'object'
    && (wallet.currency === 'CNY' || wallet.currency === 'USD')
    && typeof wallet.balance === 'string')
    .map((wallet) => ({ currency: wallet.currency, balance: wallet.balance }))
}

/**
 * Read recharge and bonus wallet balances behind one grant.
 * @param {string} origin - Platform origin.
 * @param {object} grant - `{token, issuer}`.
 * @param {object} client - client metadata.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<{normal: object[], bonus: object[], checkedAt: number}>}
 */
export async function fetchBalance(origin, grant, client, signal, version) {
  const body = await request(origin, '/api/v0/users/get_user_summary', grant.token, client, signal, version)
  if (body === null || typeof body !== 'object') throw new PlatformError('protocol')
  return {
    normal: wallets(body.normal_wallets),
    bonus: wallets(body.bonus_wallets),
    checkedAt: Date.now(),
  }
}
