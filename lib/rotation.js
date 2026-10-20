/**
 * Pure rotation decisions for the account switcher.
 *
 * Everything here is side-effect free so `node --test` can exercise it without
 * a DSH host. The Host half owns persistence and HTTP; this module only ranks
 * accounts, classifies provider failures, and validates the policy shape.
 */

/** Rotation reasons the Host can act on. */
export const REASONS = Object.freeze(['auth', 'quota', 'rateLimit', 'balance'])

/** Trigger key per reason. `auth` covers expired and signed-out credentials. */
const TRIGGER_BY_REASON = Object.freeze({
  auth: 'authInvalid',
  quota: 'quota',
  rateLimit: 'rateLimit',
  balance: 'lowBalance',
})

/** Decimal grammar the Platform returns for wallet balances. */
const DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i

/**
 * Parse one Platform decimal string.
 * @param {unknown} value - wallet balance text.
 * @returns {number} the numeric value, or NaN when the text is not a decimal.
 */
export function parseDecimal(value) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return NaN
  return Number(value)
}

/**
 * Compare one balance string against a configured threshold.
 * Missing thresholds never trigger; malformed values compare false.
 * @param {string} balance - Platform decimal string.
 * @param {string} threshold - configured decimal string.
 * @returns {boolean} whether the balance is strictly below the threshold.
 */
export function belowThreshold(balance, threshold) {
  const left = parseDecimal(balance)
  const right = parseDecimal(threshold)
  if (Number.isNaN(left) || Number.isNaN(right)) return false
  return left < right
}

/**
 * Whether any wallet of one account falls below its currency threshold.
 * @param {object} account - vault account with a balance snapshot.
 * @param {Record<string, string>} minBalance - threshold per currency.
 * @returns {boolean} true when at least one configured wallet is low.
 */
export function isLowBalance(account, minBalance) {
  const snapshot = account?.balance
  if (snapshot === undefined || snapshot === null) return false
  const wallets = [...(snapshot.normal ?? []), ...(snapshot.bonus ?? [])]
  const totals = new Map()
  for (const wallet of wallets) {
    const value = parseDecimal(wallet.balance)
    if (Number.isNaN(value)) continue
    totals.set(wallet.currency, (totals.get(wallet.currency) ?? 0) + value)
  }
  for (const [currency, threshold] of Object.entries(minBalance ?? {})) {
    const total = totals.get(currency)
    const floor = parseDecimal(threshold)
    if (total === undefined || Number.isNaN(floor)) continue
    if (total < floor) return true
  }
  return false
}

/**
 * Total known balance across currencies. Only used as a tie-breaker; amounts in
 * different currencies are not converted, so this is a ranking heuristic.
 * @param {object} account - vault account.
 * @returns {number} sum of parsed wallet amounts.
 */
export function knownBalanceTotal(account) {
  const snapshot = account?.balance
  if (snapshot === undefined || snapshot === null) return 0
  const wallets = [...(snapshot.normal ?? []), ...(snapshot.bonus ?? [])]
  let total = 0
  for (const wallet of wallets) {
    const value = parseDecimal(wallet.balance)
    if (!Number.isNaN(value)) total += value
  }
  return total
}

/**
 * Classify one provider or account failure into a rotation reason.
 * @param {unknown} error - thrown value from an LLM or account operation.
 * @returns {'auth'|'quota'|'rateLimit'|null} rotation reason, or null when the
 * failure is unrelated to the account.
 */
export function classifyError(error) {
  const code = String(error?.code ?? error?.cause?.code ?? '')
  const status = Number(error?.status ?? error?.cause?.status ?? 0)
  if (code === 'ACCOUNT_TOKEN_INVALID' || code === 'AUTH' || code === 'ACCOUNT_SIGN_IN_REQUIRED') return 'auth'
  if (code === 'QUOTA') return 'quota'
  if (code === 'RATE_LIMIT') return 'rateLimit'
  if (status === 401 || status === 403) return 'auth'
  if (status === 402) return 'quota'
  if (status === 429) return 'rateLimit'
  return null
}

/**
 * Whether the policy enables one reason.
 * @param {object} policy - rotation policy.
 * @param {'auth'|'quota'|'rateLimit'|'balance'} reason - candidate reason.
 * @returns {boolean} true when rotation is enabled and the reason's trigger is on.
 */
export function triggerEnabled(policy, reason) {
  if (policy?.enabled !== true) return false
  const key = TRIGGER_BY_REASON[reason]
  return key !== undefined && policy?.triggers?.[key] === true
}

/**
 * Rank the next account to try.
 *
 * Candidates must hold a grant, are not the current account, are not marked
 * dead, and are not cooling down. Least-recently-used wins; a larger known
 * balance breaks ties so a funded account is preferred.
 * @param {object[]} accounts - vault accounts.
 * @param {string|null} currentId - currently active account id.
 * @param {number} now - epoch milliseconds.
 * @returns {object|null} the selected account, or null when none is eligible.
 */
export function selectTarget(accounts, currentId, now = Date.now()) {
  if (!Array.isArray(accounts)) return null
  const candidates = accounts.filter((account) => {
    if (account === null || typeof account !== 'object') return false
    if (account.id === currentId) return false
    if (account.state === 'dead') return false
    if (!account.grant || typeof account.grant.token !== 'string' || account.grant.token.length === 0) return false
    const cooldownUntil = Number(account.cooldownUntil ?? 0)
    return !(cooldownUntil > now)
  })
  candidates.sort((left, right) => {
    const used = Number(left.lastUsedAt ?? 0) - Number(right.lastUsedAt ?? 0)
    if (used !== 0) return used
    const balance = knownBalanceTotal(right) - knownBalanceTotal(left)
    if (balance !== 0) return balance
    return String(left.id).localeCompare(String(right.id))
  })
  return candidates[0] ?? null
}

/** Default rotation policy. Automatic switching stays off until the user opts in. */
export function defaultPolicy() {
  return {
    enabled: false,
    triggers: { authInvalid: true, quota: true, rateLimit: true, lowBalance: false },
    minBalance: { CNY: '1', USD: '0.2' },
    minIntervalMs: 30000,
    cooldownMs: 600000,
    maxSwitchesPer10Min: 3,
    deferWhileRunning: true,
    pollMs: 300000,
  }
}

/** Bounds for validated numeric policy fields. */
const LIMITS = Object.freeze({
  minIntervalMs: [5000, 3600000],
  cooldownMs: [60000, 86400000],
  maxSwitchesPer10Min: [1, 20],
  pollMs: [60000, 3600000],
})

/**
 * Validate and merge a rotation-policy patch over a base policy.
 * @param {object} base - current policy.
 * @param {unknown} patch - caller-supplied partial policy.
 * @returns {object} a fresh validated policy.
 * @throws {Error} when a field is invalid.
 */
export function normalizePolicy(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('轮换策略必须是对象')
  const next = structuredClone({ ...defaultPolicy(), ...(base ?? {}) })
  if ('enabled' in patch) {
    if (typeof patch.enabled !== 'boolean') throw new Error('enabled 必须是布尔值')
    next.enabled = patch.enabled
  }
  if ('deferWhileRunning' in patch) {
    if (typeof patch.deferWhileRunning !== 'boolean') throw new Error('deferWhileRunning 必须是布尔值')
    next.deferWhileRunning = patch.deferWhileRunning
  }
  if ('triggers' in patch) {
    if (patch.triggers === null || typeof patch.triggers !== 'object' || Array.isArray(patch.triggers)) throw new Error('triggers 必须是对象')
    for (const key of Object.keys(next.triggers)) {
      if (!(key in patch.triggers)) continue
      if (typeof patch.triggers[key] !== 'boolean') throw new Error(`triggers.${key} 必须是布尔值`)
      next.triggers[key] = patch.triggers[key]
    }
  }
  if ('minBalance' in patch) {
    if (patch.minBalance === null || typeof patch.minBalance !== 'object' || Array.isArray(patch.minBalance)) throw new Error('minBalance 必须是对象')
    for (const [currency, value] of Object.entries(patch.minBalance)) {
      if (currency !== 'CNY' && currency !== 'USD') throw new Error(`不支持的币种：${currency}`)
      if (typeof value !== 'string' || Number.isNaN(parseDecimal(value)) || parseDecimal(value) < 0) {
        throw new Error(`minBalance.${currency} 必须是非负十进制字符串`)
      }
      next.minBalance[currency] = value
    }
  }
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    if (!(key in patch)) continue
    const value = Number(patch[key])
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} 必须是 ${min}–${max} 的整数`)
    next[key] = value
  }
  return next
}
