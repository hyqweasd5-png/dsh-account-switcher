/**
 * Account switcher Host half.
 *
 * The active DeepSeek account is the `deepseek-account-platform/default` grant
 * in the credentials store. Switching is therefore one atomic record write:
 * the account provider watches `credentials/record-updated`, drops its cached
 * details, and the next inference request resolves the new token. No restart
 * and no remote logout are involved.
 *
 * This module deliberately imports no `@deepseek-ai/*` package. The packaged
 * Desktop runtime resolves profile packages against its own copies, but using
 * only the documented Cordis services and Node built-ins keeps the plugin
 * working across runtime revisions.
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { arch, platform as osPlatform, release } from 'node:os'
import { join } from 'node:path'

import { ApiError, createRouter } from './routes.js'
import { exchangeWebToken, fetchBalance, fetchProfile, normalizeOrigin, PlatformError, UnauthorizedError } from './platform.js'
import { classifyError, isLowBalance, normalizePolicy, selectTarget, triggerEnabled } from './rotation.js'
import {
  emptyVault, findById, findByToken, loadVault, publicState, pushLog, resolveHome, resolveVaultPath, saveVault, upsertAccount,
} from './vault.js'

/** Credentials record holding the one active account grant. */
const KEY = 'deepseek-account-platform/default'
/** Shared device identity record; the account provider uses the same record for browser logins. */
const DEVICE = 'deepseek-account-platform/device'
/** Version reported to the Platform in `x-client-version`. */
const CLIENT_VERSION = '0.2.1-rc.2'
/** Delay before re-reading the grant after our own write. */
const SWITCH_SETTLE_MS = 150
/** Manual and automatic switches share one serial queue. */
const MAX_REFRESH_CONCURRENCY = 3

/** Plugin identity used by the Loader and the client module table. */
export const name = 'account-switcher'
/** The credentials service is required; every other service is optional. */
export const inject = ['credentials']

/** Small promise sleep. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run one async operation per item with bounded concurrency.
 * @template T, R
 * @param {T[]} items - inputs.
 * @param {number} limit - maximum in-flight operations.
 * @param {(item: T, index: number) => Promise<R>} operation - worker.
 * @returns {Promise<R[]>} results in input order.
 */
async function mapLimit(items, limit, operation) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await operation(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Install the account switcher.
 * @param {import('@deepseek-ai/cordis').Context} ctx - profile context.
 * @param {object} [config] - plugin config from the bundle patch.
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger
  const origin = normalizeOrigin(config.platformOrigin ?? 'https://platform.deepseek.com', config.allowLoopbackHttp === true)
  const vaultPath = resolveVaultPath(config.vaultPath)
  const debug = config.debug === true

  let vault = emptyVault()
  let ready = null
  let loaded = false
  let disposed = false
  let saveChain = Promise.resolve()
  let syncTimer = null
  let syncPromise = null
  let refreshPromise = null
  let switchQueue = Promise.resolve()
  let switching = null
  let pendingTrigger = null
  let pendingTimer = null
  let lastSwitchAt = 0
  let lastAutoSwitchTimes = []
  let lastTriggerAt = 0
  let lastTriggerReason = null
  let expiringUntil = 0
  let selfDeleteUntil = 0
  let lastPollAt = 0
  let globalRateLimitedUntil = 0
  let rateLimitedSwitchAt = 0

  /** Resolve the optional account service. */
  const accountService = () => ctx.get('deepseekAccount')

  /** Client identity for Platform calls. */
  function clientMeta(override = {}) {
    const timezone = Number(override?.timezoneOffsetSeconds)
    return {
      version: String(config.clientVersion ?? CLIENT_VERSION),
      locale: String(override?.locale ?? config.locale ?? Intl.DateTimeFormat().resolvedOptions().locale ?? 'en-US'),
      timezoneOffsetSeconds: Number.isFinite(timezone) ? Math.trunc(timezone) : -new Date().getTimezoneOffset() * 60,
    }
  }

  /** Serialize vault writes onto one chain. */
  function persist() {
    if (!loaded) return Promise.resolve()
    const run = saveChain.then(() => saveVault(vaultPath, vault))
    saveChain = run.then(() => undefined, () => undefined)
    return run
  }

  /** Serialize manual switches; automatic switches use `switching` directly. */
  function serialize(operation) {
    const run = switchQueue.then(operation, operation)
    switchQueue = run.then(() => undefined, () => undefined)
    return run
  }

  /** Whether any agent is currently running. */
  function agentsBusy() {
    const agents = ctx.get('agents')
    if (agents === undefined || typeof agents.list !== 'function') return false
    try {
      return agents.list().some((agent) => agent?.status === 'running')
    } catch {
      return false
    }
  }

  /** Delete the active grant without letting our own deletion look like a manual sign-out. */
  async function deleteGrant() {
    selfDeleteUntil = Date.now() + 2000
    await ctx.credentials.deleteRecord(KEY)
  }

  /** Read the active grant record, if any. */
  async function readGrant() {
    const record = await ctx.credentials.readRecord(KEY)
    if (record === undefined || record.kind !== 'grant') return null
    const token = record.payload?.token
    if (typeof token !== 'string' || token === '') return null
    return {
      version: 1,
      token,
      issuer: typeof record.payload?.issuer === 'string' ? record.payload.issuer : origin,
    }
  }

  /** Fetch a profile, returning null instead of failing the caller. */
  async function safeProfile(grant) {
    try {
      return await fetchProfile(origin, grant, clientMeta())
    } catch (error) {
      if (error instanceof UnauthorizedError) throw error
      logger.warn(`account-switcher: profile lookup failed: ${String(error?.code ?? error)}`)
      return null
    }
  }

  /** Enrich one account from the Platform, marking only a rejected token dead. */
  async function enrich(account) {
    try {
      const profile = await fetchProfile(origin, account.grant, clientMeta())
      if (profile.uid !== null) account.uid = profile.uid
      if (profile.name !== null) account.name = profile.name
      if (profile.contact !== null) account.contact = profile.contact
      account.avatarUrl = profile.avatarUrl
      if (account.label === '当前账号' && account.name !== null) account.label = account.name
      account.lastError = null
      if (account.state === 'dead') account.state = 'idle'
      return true
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        account.state = 'dead'
        account.lastError = 'token-invalid'
        return false
      }
      account.lastError = 'profile-unavailable'
      return false
    }
  }

  /** Refresh profile and wallet balances for one account. */
  async function refreshAccount(account) {
    try {
      const [profile, balance] = await Promise.all([
        fetchProfile(origin, account.grant, clientMeta()),
        fetchBalance(origin, account.grant, clientMeta()),
      ])
      if (profile.uid !== null) account.uid = profile.uid
      if (profile.name !== null) account.name = profile.name
      if (profile.contact !== null) account.contact = profile.contact
      account.avatarUrl = profile.avatarUrl
      if (account.label === '当前账号' && account.name !== null) account.label = account.name
      account.balance = balance
      account.lastError = null
      if (account.state === 'dead') account.state = 'idle'
      return true
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        account.state = 'dead'
        account.lastError = 'token-invalid'
        return false
      }
      account.lastError = 'refresh-failed'
      return false
    }
  }

  /** Refresh one account in the background so boot and switching never wait on wallet I/O. */
  function refreshAccountLater(account) {
    return refreshAccount(account).then(() => persist()).catch((error) => {
      logger.warn(`account-switcher: background account refresh failed: ${String(error?.code ?? error)}`)
    })
  }

  /** Align the vault's active pointer with the credential store. */
  function syncCurrent() {
    if (syncPromise !== null) return syncPromise
    syncPromise = (async () => {
      const grant = await readGrant()
      if (grant === null) {
        if (vault.activeId !== null) {
          vault.activeId = null
          await persist()
        }
        return
      }
      const existing = findByToken(vault, grant.token)
      if (existing !== undefined) {
        vault.activeId = existing.id
        existing.state = existing.state === 'dead' ? 'idle' : 'active'
        existing.lastError = null
        await persist()
        if (existing.uid === null || existing.name === null || Number(existing.balance?.checkedAt ?? 0) === 0) void refreshAccountLater(existing)
        return
      }
      const adopted = upsertAccount(vault, { grant, profile: null, label: '当前账号' })
      vault.activeId = adopted.id
      pushLog(vault, { event: 'account-adopted', message: '已收入未保存的当前账号', to: adopted.id })
      await persist()
      void refreshAccountLater(adopted)
    })().finally(() => {
      syncPromise = null
    })
    return syncPromise
  }

  /** Debounced sync after the credentials record changes. */
  function scheduleSync() {
    if (!loaded || disposed) return
    if (syncTimer !== null) clearTimeout(syncTimer)
    syncTimer = setTimeout(() => {
      syncTimer = null
      syncCurrent().catch((error) => logger.warn(`account-switcher: sync failed: ${String(error)}`))
    }, 250)
  }

  /**
   * Switch the active grant, verifying the target and restoring on failure.
   * @param {string} id - target account id.
   * @param {object} [meta] - reason and whether the switch is automatic.
   * @returns {Promise<object>} the updated public state.
   */
  async function performSwitch(id, meta = {}) {
    const target = findById(vault, id)
    if (target === undefined) throw new ApiError(404, '账号不存在', 'not-found')
    if (target.state === 'dead') throw new ApiError(409, '该账号 token 已失效，请重新登录', 'account-dead')
    if (target.grant.issuer !== origin) throw new ApiError(400, '账号 issuer 与当前平台不一致', 'issuer-mismatch')

    const now = Date.now()
    const stale = now - Number(target.balance?.checkedAt ?? 0) > 10 * 60 * 1000
    if (target.uid === null || stale) {
      const verified = await enrich(target)
      if (!verified) {
        await persist()
        throw new ApiError(409, target.lastError === 'token-invalid' ? '目标账号 token 已失效' : '目标账号校验失败', 'account-unverified')
      }
    }

    const previous = await ctx.credentials.readRecord(KEY)
    const previousPayload = previous !== undefined && previous.kind === 'grant' ? previous.payload : null
    if (vault.activeId === id && previousPayload !== null && previousPayload.token === target.grant.token) {
      target.state = 'active'
      target.lastError = null
      await persist()
      return publicState(vault, { platformOrigin: origin, version: CLIENT_VERSION })
    }
    const fromId = vault.activeId
    try {
      await ctx.credentials.modifyRecord(KEY, async () => ({ kind: 'grant', payload: target.grant }))
      await sleep(SWITCH_SETTLE_MS)
      const service = accountService()
      if (service !== undefined) {
        const view = await service.getState()
        if (view?.status !== 'credential-stored') throw new Error('switch produced no credential')
        const profile = await service.getProfile(clientMeta())
        if (profile === null) throw new ApiError(409, '目标账号 token 已失效', 'account-dead')
      } else {
        await fetchProfile(origin, target.grant, clientMeta())
      }
    } catch (error) {
      try {
        if (previousPayload !== null) {
          await ctx.credentials.modifyRecord(KEY, async () => ({ kind: 'grant', payload: previousPayload }))
        } else {
          await deleteGrant()
        }
      } catch (rollbackError) {
        logger.warn(`account-switcher: rollback failed: ${String(rollbackError)}`)
      }
      const dead = error instanceof UnauthorizedError || (error instanceof ApiError && error.code === 'account-dead')
      target.state = dead ? 'dead' : 'idle'
      target.lastError = dead ? 'token-invalid' : 'switch-failed'
      pushLog(vault, {
        level: 'warn', event: 'switch-failed', message: `切换到 ${target.label} 失败，已恢复原账号`,
        from: fromId, to: target.id, reason: meta.reason,
      })
      await persist()
      if (error instanceof UnauthorizedError) throw new ApiError(409, '目标账号 token 已失效', 'account-dead')
      if (error instanceof ApiError) throw error
      throw new ApiError(502, '切换失败，已恢复原账号', 'switch-failed')
    }

    vault.activeId = target.id
    for (const account of vault.accounts) {
      if (account.id !== target.id && account.state === 'active') account.state = 'idle'
    }
    target.state = 'active'
    target.lastUsedAt = Date.now()
    target.lastError = null
    lastSwitchAt = Date.now()
    if (meta.automatic === true) lastAutoSwitchTimes.push(lastSwitchAt)
    lastAutoSwitchTimes = lastAutoSwitchTimes.filter((at) => Date.now() - at < 10 * 60 * 1000)
    pushLog(vault, {
      event: meta.automatic === true ? 'auto-switch' : 'switch',
      message: `已切换到 ${target.label}`,
      from: fromId, to: target.id, reason: meta.reason,
    })
    await persist()
    void refreshAccountLater(target)
    return publicState(vault, { platformOrigin: origin, version: CLIENT_VERSION })
  }

  /** Queue a manual switch behind any in-flight switch. */
  function switchTo(id, meta = {}) {
    return serialize(() => performSwitch(id, meta))
  }

  /** Save the current grant to the vault. */
  async function saveCurrent(body = {}) {
    const grant = await readGrant()
    if (grant === null) throw new ApiError(400, '当前没有已登录账号', 'no-current')
    let profile = null
    try {
      profile = await safeProfile(grant)
    } catch (error) {
      if (error instanceof UnauthorizedError) throw new ApiError(401, '当前账号 token 已失效', 'account-token-invalid')
      throw error
    }
    const account = upsertAccount(vault, { grant, profile, label: body.label })
    vault.activeId = account.id
    account.state = 'active'
    account.lastUsedAt = Date.now()
    pushLog(vault, { event: 'save-current', message: `已保存当前账号：${account.label}`, to: account.id })
    await persist()
    void refreshAccountLater(account)
    return publicState(vault, { platformOrigin: origin, version: CLIENT_VERSION })
  }

  /** Validate and store one imported token. */
  async function importToken(body = {}) {
    const token = typeof body.token === 'string' ? body.token.trim() : ''
    if (token === '' || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) {
      throw new ApiError(400, 'token 格式不合法', 'invalid-token')
    }
    const grant = { version: 1, token, issuer: origin }
    let profile
    try {
      profile = await fetchProfile(origin, grant, clientMeta())
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw new ApiError(401, '平台不认这条 token。请确认它是 platform.deepseek.com 的 DSH 账号 grant；chat.deepseek.com 的网页 token 不能直接导入，请改用「添加账号」登录。', 'account-token-invalid')
      }
      throw error
    }
    const account = upsertAccount(vault, { grant, profile, label: body.label })
    await persist()
    pushLog(vault, { event: 'import', message: `已导入账号：${account.label}`, to: account.id })
    if (body.switch === true) return switchTo(account.id, { reason: 'import' })
    void refreshAccountLater(account)
    return publicState(vault, { platformOrigin: origin, version: CLIENT_VERSION })
  }

  /** Shared device identity for auth_exchange; created once and reused by browser logins too. */
  async function ensureDeviceId() {
    const record = await ctx.credentials.modifyRecord(DEVICE, async (current) => {
      if (current !== undefined && current.kind === 'grant'
        && typeof current.payload?.id === 'string' && current.payload.id !== '') return undefined
      return { kind: 'grant', payload: { id: randomUUID() } }
    })
    return record?.kind === 'grant' && typeof record.payload?.id === 'string' ? record.payload.id : null
  }

  /** The loopback callback origin of this request, used as auth_init's redirect_uri. */
  function requestCallbackOrigin(req) {
    const host = req.headers.host
    if (typeof host !== 'string') return null
    const match = /^(?:127\.0\.0\.1|localhost|\[::1\]):([0-9]+)$/i.exec(host)
    if (match === null || Number(match[1]) === 0) return null
    return `http://${host}`
  }

  /**
   * Exchange a signed-in platform Web token for a DSH grant.
   *
   * The platform's own /dsh/authorize page performs the same sequence:
   * auth_init -> auth_approve (with the Web session) -> auth_exchange.
   */
  async function exchangeToken(body = {}, req) {
    const webToken = typeof body.token === 'string' ? body.token.trim() : ''
    if (webToken === '' || webToken.length > 4096 || !/^[\x21-\x7e]+$/.test(webToken)) {
      throw new ApiError(400, '网页 token 格式不合法', 'invalid-token')
    }
    const callbackOrigin = requestCallbackOrigin(req)
    if (callbackOrigin === null) throw new ApiError(400, '无法确定本机回调地址', 'invalid-callback-origin')
    const deviceId = await ensureDeviceId()
    if (deviceId === null) throw new ApiError(500, '无法准备设备标识', 'device-unavailable')
    let exchanged
    try {
      exchanged = await exchangeWebToken({
        origin,
        webToken,
        redirectUri: `${callbackOrigin}/oauth/callback`,
        client: clientMeta(body),
        deviceId,
        deviceModel: `${osPlatform()}-${arch()}`,
        osVersion: release(),
        version: CLIENT_VERSION,
      })
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw new ApiError(401, '平台不认这条网页 token。请确认它是 platform.deepseek.com 的登录 token；chat.deepseek.com 的网页 token 不能交换。', 'web-token-invalid')
      }
      if (error instanceof PlatformError && error.bizCode === 40002) {
        throw new ApiError(401, '缺少平台 token', 'web-token-missing')
      }
      if (error instanceof PlatformError) {
        throw new ApiError(502, '交换失败：平台拒绝了这次授权', 'exchange-failed')
      }
      throw error
    }
    const grant = { version: 1, token: exchanged.token, issuer: origin }
    let profile = null
    try {
      profile = await fetchProfile(origin, grant, clientMeta())
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw new ApiError(401, '交换得到的 token 被平台拒绝', 'exchange-token-invalid')
      }
    }
    const account = upsertAccount(vault, { grant, profile, label: body.label })
    await persist()
    pushLog(vault, { event: 'exchange', message: `已通过网页 token 交换并加入：${account.label}`, to: account.id })
    if (body.switch === true) return switchTo(account.id, { reason: 'exchange' })
    void refreshAccountLater(account)
    return publicState(vault, { platformOrigin: origin, version: CLIENT_VERSION })
  }

  /** Remove one account from the pool without revoking its remote token. */
  async function removeAccount(body = {}) {
    const id = typeof body.id === 'string' ? body.id : ''
    const target = findById(vault, id)
    if (target === undefined) throw new ApiError(404, '账号不存在', 'not-found')
    if (vault.activeId === id) {
      const next = selectTarget(vault.accounts, id, Date.now())
      if (next !== null) {
        await switchTo(next.id, { reason: 'remove' })
      } else {
        await deleteGrant()
        vault.activeId = null
      }
    }
    vault.accounts = vault.accounts.filter((account) => account.id !== id)
    pushLog(vault, { event: 'remove', message: `已从账号库移除：${target.label}`, from: id })
    await persist()
    return publicState(vault, { platformOrigin: origin, version: CLIENT_VERSION })
  }

  /** Import accounts produced by the separate login plugin. */
  async function syncLogin() {
    const path = typeof config.loginVaultPath === 'string' && config.loginVaultPath !== ''
      ? config.loginVaultPath
      : join(resolveHome(), 'account-login', 'accounts.json')
    let data
    try {
      data = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') throw new ApiError(404, '没有找到登录插件账号库，请先在「登录管理」登录一个账号', 'no-login-vault')
      throw new ApiError(500, '读取登录插件账号库失败', 'login-vault-error')
    }
    const imported = []
    for (const item of Array.isArray(data?.accounts) ? data.accounts : []) {
      if (item === null || typeof item !== 'object' || typeof item.grant?.token !== 'string') continue
      const account = upsertAccount(vault, {
        grant: item.grant,
        profile: {
          uid: typeof item.uid === 'string' ? item.uid : null,
          name: typeof item.name === 'string' ? item.name : null,
          contact: typeof item.contact === 'string' ? item.contact : null,
          avatarUrl: typeof item.avatarUrl === 'string' ? item.avatarUrl : null,
        },
        label: typeof item.label === 'string' ? item.label : undefined,
      })
      imported.push(account.id)
    }
    if (vault.activeId === null && vault.accounts.length > 0) vault.activeId = vault.accounts[0].id
    pushLog(vault, { event: 'sync-login', message: `从登录插件同步了 ${imported.length} 个账号` })
    await persist()
    return publicState(vault, { platformOrigin: origin, version: CLIENT_VERSION })
  }

  /** Refresh profile and balance for every saved account. */
  function refreshAll(id) {
    if (refreshPromise !== null) return refreshPromise
    refreshPromise = (async () => {
      const targets = typeof id === 'string' && id !== ''
        ? vault.accounts.filter((account) => account.id === id)
        : [...vault.accounts]
      await mapLimit(targets, MAX_REFRESH_CONCURRENCY, refreshAccount)
      await persist()
      return publicState(vault, { platformOrigin: origin, version: CLIENT_VERSION })
    })().finally(() => {
      refreshPromise = null
    })
    return refreshPromise
  }

  /** Persist a validated rotation policy. */
  async function setPolicy(body = {}) {
    try {
      vault.rotation = normalizePolicy(vault.rotation, body.rotation ?? body)
    } catch (error) {
      throw new ApiError(400, error.message, 'invalid-policy')
    }
    if (!vault.rotation.enabled) {
      pendingTrigger = null
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer)
        pendingTimer = null
      }
    }
    pushLog(vault, {
      event: 'policy',
      message: vault.rotation.enabled ? '已开启自动轮换' : '已关闭自动轮换',
    })
    await persist()
    return publicState(vault, { platformOrigin: origin, version: CLIENT_VERSION })
  }

  /** Wait for the account service to publish the browser authorization URL. */
  async function waitForAuthorizeUrl(service, initial, timeoutMs = 5000) {
    if (typeof initial?.attempt?.authorizeUrl === 'string') return initial.attempt.authorizeUrl
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(100)
      const state = await service.getState()
      if (typeof state?.attempt?.authorizeUrl === 'string') return state.attempt.authorizeUrl
      const phase = state?.attempt?.phase
      if (phase === 'succeeded') throw new ApiError(409, '登录已完成，账号已保存', 'login-completed')
      if (phase === 'failed' || phase === 'expired' || phase === 'cancelled') {
        throw new ApiError(502, `登录未完成：${phase}`, 'login-failed')
      }
      if (state?.status === 'credential-stored' && state.attempt == null) {
        throw new ApiError(409, '登录已完成，账号已保存', 'login-completed')
      }
    }
    return null
  }

  /** Start a browser login for an additional account. */
  async function loginStart(req, body = {}) {
    const service = accountService()
    if (service === undefined) throw new ApiError(503, '账号服务不可用', 'no-account-service')
    const callbackOrigin = requestCallbackOrigin(req)
    if (callbackOrigin === null) throw new ApiError(400, '无法确定本机回调地址', 'invalid-callback-origin')
    let initial
    try {
      initial = await service.startSignIn(clientMeta(body), callbackOrigin, 'web')
    } catch (error) {
      throw new ApiError(502, `登录启动失败：${String(error?.code ?? 'unknown')}`, 'login-failed')
    }
    const attemptId = initial?.attempt?.id ?? null
    const url = await waitForAuthorizeUrl(service, initial)
    if (url === null) {
      if (attemptId !== null) await service.cancelSignIn(attemptId).catch(() => undefined)
      throw new ApiError(504, '登录地址未就绪，请重试', 'login-timeout')
    }
    return { url, attemptId }
  }

  /** Cancel one browser login attempt. */
  async function loginCancel(_req, body = {}) {
    const service = accountService()
    if (service === undefined) throw new ApiError(503, '账号服务不可用', 'no-account-service')
    const attemptId = typeof body.attemptId === 'string' ? body.attemptId : ''
    if (attemptId === '') throw new ApiError(400, '缺少 attemptId', 'invalid-attempt')
    await service.cancelSignIn(attemptId)
    return { cancelled: true }
  }

  /** Record one rotation trigger, deduplicating bursts from the same reason. */
  function requestRotation(reason, source) {
    if (!loaded || disposed) return
    if (!triggerEnabled(vault.rotation, reason)) return
    const now = Date.now()
    if (now - lastTriggerAt < 1000 && lastTriggerReason === reason) return
    lastTriggerAt = now
    lastTriggerReason = reason
    pushLog(vault, { event: 'rotation-trigger', message: `触发轮换：${reason}（${source}）`, reason })
    persist().catch(() => undefined)
    queueRotation(reason)
  }

  /** Act on one rotation reason once guards allow it. */
  function queueRotation(reason) {
    if (!loaded || disposed) return
    if (switching !== null) {
      pendingTrigger = reason
      return
    }
    const wait = Math.max(0, Number(vault.rotation.minIntervalMs) - (Date.now() - lastSwitchAt))
    if (wait > 0) {
      pendingTrigger = reason
      if (pendingTimer !== null) clearTimeout(pendingTimer)
      pendingTimer = setTimeout(() => {
        pendingTimer = null
        const next = pendingTrigger
        pendingTrigger = null
        if (next !== null) queueRotation(next)
      }, wait)
      return
    }
    if (reason === 'rateLimit' && Date.now() < globalRateLimitedUntil) return
    if (reason === 'rateLimit' && rateLimitedSwitchAt > 0 && Date.now() - rateLimitedSwitchAt < 60000) {
      globalRateLimitedUntil = Date.now() + 5 * 60 * 1000
      rateLimitedSwitchAt = 0
      pushLog(vault, { level: 'warn', event: 'rate-limit-global', message: '连续两个账号被限流，暂停自动切换 5 分钟', reason })
      persist().catch(() => undefined)
      return
    }
    if (reason === 'balance' && vault.rotation.deferWhileRunning === true && agentsBusy()) {
      pendingTrigger = 'balance'
      if (pendingTimer === null) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null
          const next = pendingTrigger
          pendingTrigger = null
          if (next !== null) queueRotation(next)
        }, 10000)
      }
      return
    }
    const recent = lastAutoSwitchTimes.filter((at) => Date.now() - at < 10 * 60 * 1000)
    if (recent.length >= Number(vault.rotation.maxSwitchesPer10Min)) {
      pushLog(vault, { level: 'warn', event: 'rotation-throttled', message: '10 分钟内自动切换次数已达上限', reason })
      persist().catch(() => undefined)
      return
    }
    const current = vault.activeId === null ? undefined : findById(vault, vault.activeId)
    if (current !== undefined) {
      if (reason === 'auth') {
        current.state = 'dead'
        current.lastError = 'token-invalid'
      } else {
        current.state = 'cooldown'
        current.cooldownUntil = Date.now() + Number(vault.rotation.cooldownMs)
        current.lastError = reason
      }
    }
    const target = selectTarget(vault.accounts, vault.activeId, Date.now())
    if (target === null) {
      vault.activeId = current !== undefined && current.state !== 'dead' ? current.id : vault.activeId
      pushLog(vault, { level: 'warn', event: 'rotation-exhausted', message: '没有可用账号，已停止自动切换', reason })
      persist().catch(() => undefined)
      return
    }
    if (reason === 'rateLimit') rateLimitedSwitchAt = Date.now()
    switching = serialize(() => performSwitch(target.id, { automatic: true, reason }))
      .catch((error) => {
        logger.warn(`account-switcher: automatic switch failed: ${String(error?.code ?? error)}`)
        pushLog(vault, { level: 'warn', event: 'auto-switch-failed', message: '自动切换失败', reason })
        persist().catch(() => undefined)
      })
      .finally(() => {
        switching = null
        if (pendingTrigger !== null) {
          const next = pendingTrigger
          pendingTrigger = null
          queueRotation(next)
        }
      })
  }

  /** Poll balances and rotate when the active account drops below its floor. */
  async function pollBalances() {
    const accounts = vault.accounts.filter((account) => account.state !== 'dead')
    await mapLimit(accounts, 2, async (account) => {
      try {
        account.balance = await fetchBalance(origin, account.grant, clientMeta())
        account.lastError = null
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          account.state = 'dead'
          account.lastError = 'token-invalid'
        }
      }
    })
    await persist()
    const current = vault.activeId === null ? undefined : findById(vault, vault.activeId)
    if (current !== undefined && isLowBalance(current, vault.rotation.minBalance)) {
      requestRotation('balance', 'poll')
    }
  }

  /** Called when the account provider reports a rejected or removed credential. */
  function onCredentialLost() {
    if (!loaded || disposed) return
    if (switching !== null || (lastSwitchAt > 0 && Date.now() - lastSwitchAt < 2000)) {
      pushLog(vault, { event: 'expiry-ignored', message: '忽略切换后迟到的失效通知' })
      persist().catch(() => undefined)
      return
    }
    const current = vault.activeId === null ? undefined : findById(vault, vault.activeId)
    if (current !== undefined) {
      current.state = 'dead'
      current.lastError = 'token-invalid'
      pushLog(vault, { level: 'warn', event: 'credential-lost', message: `账号 ${current.label} 的登录态已失效`, from: current.id })
    }
    vault.activeId = null
    persist().catch(() => undefined)
    requestRotation('auth', 'session-expired')
  }

  /** A user-initiated official sign-out revokes the token; never auto-switch from it. */
  function onManualSignOut() {
    if (!loaded || disposed) return
    const current = vault.activeId === null ? undefined : findById(vault, vault.activeId)
    if (current !== undefined) {
      current.state = 'dead'
      current.lastError = 'signed-out'
      pushLog(vault, { level: 'warn', event: 'manual-sign-out', message: `检测到官方退出登录，${current.label} 的 token 已被撤销`, from: current.id })
    }
    vault.activeId = null
    persist().catch(() => undefined)
  }

  // ---- service wiring -----------------------------------------------------

  ctx.on('credentials/record-updated', (key) => {
    if (key === KEY) scheduleSync()
  })

  ctx.on('deepseek-account/session-expired', () => {
    expiringUntil = Date.now() + 1500
    onCredentialLost()
  })

  ctx.on('deepseek-account/signed-out', () => {
    if (Date.now() < expiringUntil) return
    if (Date.now() < selfDeleteUntil) {
      selfDeleteUntil = 0
      return
    }
    onManualSignOut()
  })

  ctx.on('agent/error', (payload) => {
    const reason = classifyError(payload?.error)
    if (reason === null) return
    if (reason === 'auth' && payload?.error?.code === 'ACCOUNT_SIGN_IN_REQUIRED') {
      pushLog(vault, { level: 'warn', event: 'sign-in-required', message: '模型请求需要重新登录账号' })
      persist().catch(() => undefined)
      return
    }
    requestRotation(reason, 'agent-error')
  }, { global: true })

  ready = (async () => {
    vault = await loadVault(vaultPath, logger)
    loaded = true
    await syncCurrent()
    logger.info(`account-switcher: ready (${vault.accounts.length} account(s), active=${String(vault.activeId)})`)
  })().catch((error) => {
    logger.warn(`account-switcher: initialization failed: ${String(error)}`)
  })

  const handlers = {
    state: async () => {
      await ready
      return publicState(vault, { platformOrigin: origin, version: CLIENT_VERSION })
    },
    sync: async () => {
      await ready
      await syncCurrent()
      return publicState(vault, { platformOrigin: origin, version: CLIENT_VERSION })
    },
    saveCurrent: async (_req, body) => {
      await ready
      return saveCurrent(body)
    },
    importToken: async (_req, body) => {
      await ready
      return importToken(body)
    },
    exchange: async (req, body) => {
      await ready
      return exchangeToken(body, req)
    },
    syncLogin: async () => {
      await ready
      return syncLogin()
    },
    switchAccount: async (_req, body) => {
      await ready
      if (typeof body.id !== 'string' || body.id === '') throw new ApiError(400, '缺少账号 id', 'invalid-id')
      return switchTo(body.id, { reason: 'manual' })
    },
    removeAccount: async (_req, body) => {
      await ready
      return removeAccount(body)
    },
    refresh: async (_req, body) => {
      await ready
      return refreshAll(body.id)
    },
    setPolicy: async (_req, body) => {
      await ready
      return setPolicy(body)
    },
    loginStart: async (req, body) => {
      await ready
      return loginStart(req, body)
    },
    loginCancel: async (req, body) => {
      await ready
      return loginCancel(req, body)
    },
    debugTrigger: async (_req, body) => {
      await ready
      if (!debug) throw new ApiError(404, '调试接口未启用', 'not-found')
      const reason = String(body.reason ?? '')
      if (!['auth', 'quota', 'rateLimit', 'balance'].includes(reason)) throw new ApiError(400, '未知原因', 'invalid-reason')
      requestRotation(reason, 'debug')
      return { triggered: true }
    },
  }

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: '/account-switcher/api',
      handler: createRouter(handlers, logger),
    }))
  })

  ctx.effect(() => () => {
    disposed = true
    if (pendingTimer !== null) clearTimeout(pendingTimer)
    if (syncTimer !== null) clearTimeout(syncTimer)
  })

  ctx.effect(() => {
    const timer = setInterval(() => {
      if (!vault.rotation.enabled) return
      if (Date.now() < globalRateLimitedUntil) return
      if (Date.now() - lastPollAt < Number(vault.rotation.pollMs)) return
      lastPollAt = Date.now()
      pollBalances().catch((error) => logger.warn(`account-switcher: balance poll failed: ${String(error)}`))
    }, 30000)
    return () => clearInterval(timer)
  })
}
