/**
 * Account vault: the list of saved DeepSeek grants plus the active pointer and
 * rotation policy.
 *
 * The file is intentionally separate from `~/.dsh/.credentials.yaml`: the
 * credentials store owns the *active* grant, while this store owns the pool.
 * It is written atomically with mode 0600 and never stores anything except
 * account grants, display metadata, and a short rotation log.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { defaultPolicy, normalizePolicy } from './rotation.js'

/** Vault schema version written to every new file. */
export const VAULT_VERSION = 1

/**
 * Resolve the Harness home without importing DSH internals.
 * @returns {string} absolute `$DSH_HOME` or `~/.dsh`.
 */
export function resolveHome() {
  const configured = process.env.DSH_HOME?.trim()
  return configured === undefined || configured === '' ? join(homedir(), '.dsh') : configured
}

/**
 * Resolve the default vault path.
 * @param {string} [configured] - explicit path from plugin config.
 * @returns {string} absolute vault filename.
 */
export function resolveVaultPath(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return join(resolveHome(), 'account-switcher', 'accounts.json')
}

/**
 * Short stable hash of a token; never reversible and safe to expose.
 * @param {string} token - grant token.
 * @returns {string} first 16 hex characters of SHA-256.
 */
export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex').slice(0, 16)
}

/**
 * Mask a token for display.
 * @param {string} token - grant token.
 * @returns {string} a short prefix and suffix, never the whole token.
 */
export function maskToken(token) {
  const value = String(token)
  if (value.length <= 12) return '…'
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

/** Fresh empty vault. */
export function emptyVault() {
  return {
    version: VAULT_VERSION,
    activeId: null,
    accounts: [],
    rotation: defaultPolicy(),
    log: [],
  }
}

/** Append one bounded log entry. */
export function pushLog(vault, entry) {
  const record = {
    at: Date.now(),
    level: entry.level ?? 'info',
    event: String(entry.event ?? 'event'),
    message: String(entry.message ?? ''),
    ...(entry.from === undefined ? {} : { from: entry.from }),
    ...(entry.to === undefined ? {} : { to: entry.to }),
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
  }
  vault.log.push(record)
  if (vault.log.length > 50) vault.log.splice(0, vault.log.length - 50)
  return record
}

/** Normalize one stored account, dropping anything that cannot be interpreted. */
function normalizeAccount(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const grant = raw.grant
  if (grant === null || typeof grant !== 'object') return null
  if (typeof grant.token !== 'string' || grant.token.length === 0) return null
  const tokenHash = hashToken(grant.token)
  const id = typeof raw.id === 'string' && /^[a-z][a-z0-9-]*$/.test(raw.id) ? raw.id : `acct-${tokenHash}`
  return {
    id,
    label: typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label : '账号',
    tokenHash,
    grant: {
      version: 1,
      token: grant.token,
      issuer: typeof grant.issuer === 'string' ? grant.issuer : 'https://platform.deepseek.com',
    },
    uid: typeof raw.uid === 'string' ? raw.uid : null,
    name: typeof raw.name === 'string' ? raw.name : null,
    contact: typeof raw.contact === 'string' ? raw.contact : null,
    avatarUrl: typeof raw.avatarUrl === 'string' ? raw.avatarUrl : null,
    balance: raw.balance !== null && typeof raw.balance === 'object' ? {
      checkedAt: Number(raw.balance.checkedAt ?? 0),
      normal: Array.isArray(raw.balance.normal) ? raw.balance.normal.filter(isWallet) : [],
      bonus: Array.isArray(raw.balance.bonus) ? raw.balance.bonus.filter(isWallet) : [],
    } : { checkedAt: 0, normal: [], bonus: [] },
    state: ['idle', 'active', 'cooldown', 'dead'].includes(raw.state) ? raw.state : 'idle',
    cooldownUntil: Number(raw.cooldownUntil ?? 0),
    addedAt: Number(raw.addedAt ?? Date.now()),
    lastUsedAt: Number(raw.lastUsedAt ?? 0),
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
  }
}

/** Whether a stored wallet row has the Platform shape. */
function isWallet(value) {
  return value !== null && typeof value === 'object'
    && (value.currency === 'CNY' || value.currency === 'USD')
    && typeof value.balance === 'string'
}

/** Normalize a parsed document, tolerating a partially damaged vault. */
function normalizeVault(data) {
  const vault = emptyVault()
  if (data === null || typeof data !== 'object') return vault
  if (Array.isArray(data.accounts)) {
    const seen = new Set()
    for (const raw of data.accounts) {
      const account = normalizeAccount(raw)
      if (account === null) continue
      if (seen.has(account.id)) continue
      seen.add(account.id)
      vault.accounts.push(account)
    }
  }
  if (typeof data.activeId === 'string' && vault.accounts.some((account) => account.id === data.activeId)) {
    vault.activeId = data.activeId
    const active = vault.accounts.find((account) => account.id === data.activeId)
    if (active !== undefined && active.state !== 'dead') active.state = 'active'
  }
  for (const account of vault.accounts) {
    if (account.id !== vault.activeId && account.state === 'active') account.state = 'idle'
  }
  try {
    vault.rotation = normalizePolicy(defaultPolicy(), data.rotation ?? {})
  } catch (_error) {
    vault.rotation = defaultPolicy()
  }
  if (Array.isArray(data.log)) {
    vault.log = data.log.filter((entry) => entry !== null && typeof entry === 'object').slice(-50)
  }
  return vault
}

/**
 * Load the vault, moving an unreadable file aside instead of overwriting it.
 * @param {string} filename - vault path.
 * @param {{warn: Function, info: Function}} [logger] - optional diagnostics sink.
 * @returns {Promise<object>} a normalized vault.
 */
export async function loadVault(filename, logger) {
  let text
  try {
    text = await readFile(filename, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyVault()
    throw error
  }
  try {
    return normalizeVault(JSON.parse(text))
  } catch (error) {
    const corrupt = `${filename}.corrupt-${Date.now()}`
    try {
      await rename(filename, corrupt)
      logger?.warn?.(`account-switcher: vault unreadable, moved to ${corrupt}`)
    } catch (renameError) {
      logger?.warn?.(`account-switcher: vault unreadable and could not be moved: ${String(renameError)}`)
    }
    logger?.warn?.(`account-switcher: vault parse failed: ${String(error)}`)
    return emptyVault()
  }
}

/**
 * Persist the vault atomically with owner-only permissions.
 * @param {string} filename - vault path.
 * @param {object} vault - normalized vault.
 * @returns {Promise<void>}
 */
export async function saveVault(filename, vault) {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
  const text = `${JSON.stringify(vault, null, 2)}\n`
  const temp = `${filename}.${randomUUID()}.tmp`
  await writeFile(temp, text, { mode: 0o600, flag: 'wx' })
  try {
    await rename(temp, filename)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Find an account by token hash.
 * @param {object} vault - vault.
 * @param {string} token - grant token.
 * @returns {object|undefined} the matching account.
 */
export function findByToken(vault, token) {
  const hash = hashToken(token)
  return vault.accounts.find((account) => account.tokenHash === hash)
}

/**
 * Find an account by id.
 * @param {object} vault - vault.
 * @param {string} id - account id.
 * @returns {object|undefined} the matching account.
 */
export function findById(vault, id) {
  return vault.accounts.find((account) => account.id === id)
}

/**
 * Insert or update one account, deduplicating by token then by stable account id.
 * @param {object} vault - vault to mutate.
 * @param {object} input - grant plus optional profile/label.
 * @returns {object} the upserted account.
 */
export function upsertAccount(vault, input) {
  const { grant, profile, label } = input
  const tokenHash = hashToken(grant.token)
  const uid = typeof profile?.uid === 'string' && profile.uid !== '' ? profile.uid : null
  let account = vault.accounts.find((candidate) => candidate.tokenHash === tokenHash)
  if (account === undefined && uid !== null) {
    account = vault.accounts.find((candidate) => candidate.uid === uid)
  }
  if (account === undefined) {
    account = normalizeAccount({
      id: `acct-${tokenHash}`,
      label: typeof label === 'string' && label.trim() !== '' ? label.trim() : '账号',
      grant,
      uid,
      name: profile?.name ?? null,
      contact: profile?.contact ?? null,
      avatarUrl: profile?.avatarUrl ?? null,
      state: 'idle',
      addedAt: Date.now(),
    })
    vault.accounts.push(account)
    return account
  }
  account.grant = { version: 1, token: grant.token, issuer: grant.issuer }
  account.tokenHash = tokenHash
  if (typeof label === 'string' && label.trim() !== '') account.label = label.trim()
  if (uid !== null) account.uid = uid
  if (profile !== undefined && profile !== null) {
    account.name = profile.name ?? account.name
    account.contact = profile.contact ?? account.contact
    account.avatarUrl = profile.avatarUrl ?? account.avatarUrl
  }
  if (account.state === 'dead') account.state = 'idle'
  account.lastError = null
  return account
}

/** Public account projection; deliberately excludes the grant token. */
export function publicAccount(account) {
  return {
    id: account.id,
    label: account.label,
    uid: account.uid,
    name: account.name,
    contact: account.contact,
    avatarUrl: account.avatarUrl,
    balance: account.balance,
    state: account.state,
    cooldownUntil: account.cooldownUntil,
    addedAt: account.addedAt,
    lastUsedAt: account.lastUsedAt,
    lastError: account.lastError,
    tokenHash: account.tokenHash,
    maskedToken: maskToken(account.grant.token),
  }
}

/**
 * Build the client-facing snapshot.
 * @param {object} vault - vault.
 * @param {object} [extra] - fields merged into the response.
 * @returns {object} a token-free snapshot.
 */
export function publicState(vault, extra = {}) {
  const current = vault.activeId === null ? null : findById(vault, vault.activeId)
  return {
    version: VAULT_VERSION,
    activeId: vault.activeId,
    current: current === undefined || current === null ? null : publicAccount(current),
    accounts: vault.accounts.map(publicAccount),
    rotation: vault.rotation,
    log: vault.log.slice(-20),
    ...extra,
  }
}
