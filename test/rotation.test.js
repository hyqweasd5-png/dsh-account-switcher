import assert from 'node:assert/strict'
import test from 'node:test'

import {
  belowThreshold, classifyError, defaultPolicy, isLowBalance, normalizePolicy, parseDecimal,
  selectTarget, triggerEnabled,
} from '../lib/rotation.js'

test('parseDecimal accepts Platform wallet grammar', () => {
  assert.equal(parseDecimal('12.34'), 12.34)
  assert.equal(parseDecimal('0E-16'), 0)
  assert.equal(parseDecimal('.5'), 0.5)
  assert.equal(parseDecimal('5.'), 5)
  assert.equal(parseDecimal('1e+3'), 1000)
  assert.ok(Number.isNaN(parseDecimal('abc')))
  assert.ok(Number.isNaN(parseDecimal('')))
  assert.ok(Number.isNaN(parseDecimal(null)))
})

test('belowThreshold compares only valid decimals', () => {
  assert.equal(belowThreshold('0.5', '1'), true)
  assert.equal(belowThreshold('1', '1'), false)
  assert.equal(belowThreshold('abc', '1'), false)
  assert.equal(belowThreshold('0', 'abc'), false)
})

test('isLowBalance checks both wallet groups per currency', () => {
  const account = {
    balance: {
      normal: [{ currency: 'CNY', balance: '2' }],
      bonus: [{ currency: 'USD', balance: '0.1' }],
    },
  }
  assert.equal(isLowBalance(account, { CNY: '1' }), false)
  assert.equal(isLowBalance(account, { USD: '0.2' }), true)
  assert.equal(isLowBalance(account, {}), false)
  assert.equal(isLowBalance({}, { CNY: '1' }), false)

  const bonusFunded = {
    balance: {
      normal: [{ currency: 'CNY', balance: '0' }],
      bonus: [{ currency: 'CNY', balance: '5' }],
    },
  }
  assert.equal(isLowBalance(bonusFunded, { CNY: '1' }), false)
  assert.equal(isLowBalance(bonusFunded, { CNY: '10' }), true)
})

test('selectTarget skips current, dead, cooling, and empty grants', () => {
  const now = 10_000
  const accounts = [
    { id: 'a', state: 'active', lastUsedAt: 1, grant: { token: 'a' } },
    { id: 'b', state: 'idle', lastUsedAt: 2, grant: { token: 'b' } },
    { id: 'c', state: 'dead', lastUsedAt: 3, grant: { token: 'c' } },
    { id: 'd', state: 'cooldown', cooldownUntil: now + 1, lastUsedAt: 4, grant: { token: 'd' } },
    { id: 'e', state: 'idle', lastUsedAt: 5, grant: {} },
  ]
  assert.equal(selectTarget(accounts, 'a', now)?.id, 'b')
  assert.equal(selectTarget(accounts, 'b', now)?.id, 'a')
  assert.equal(selectTarget([{ id: 'x', state: 'dead', grant: { token: 'x' } }], null, now), null)
})

test('selectTarget prefers least recently used and uses balance as a tie-breaker', () => {
  const now = 10_000
  const accounts = [
    { id: 'newer', state: 'idle', lastUsedAt: 9, grant: { token: '1' }, balance: { normal: [{ currency: 'CNY', balance: '100' }], bonus: [] } },
    { id: 'older-poor', state: 'idle', lastUsedAt: 1, grant: { token: '2' }, balance: { normal: [{ currency: 'CNY', balance: '1' }], bonus: [] } },
    { id: 'older-rich', state: 'idle', lastUsedAt: 1, grant: { token: '3' }, balance: { normal: [{ currency: 'CNY', balance: '50' }], bonus: [] } },
  ]
  assert.equal(selectTarget(accounts, null, now)?.id, 'older-rich')
})

test('classifyError maps provider and HTTP failures', () => {
  assert.equal(classifyError({ code: 'ACCOUNT_TOKEN_INVALID' }), 'auth')
  assert.equal(classifyError({ code: 'ACCOUNT_SIGN_IN_REQUIRED' }), 'auth')
  assert.equal(classifyError({ code: 'QUOTA' }), 'quota')
  assert.equal(classifyError({ code: 'RATE_LIMIT' }), 'rateLimit')
  assert.equal(classifyError({ status: 401 }), 'auth')
  assert.equal(classifyError({ status: 402 }), 'quota')
  assert.equal(classifyError({ status: 429 }), 'rateLimit')
  assert.equal(classifyError({ code: 'SERVER' }), null)
  assert.equal(classifyError(null), null)
})

test('triggerEnabled requires both the master switch and the reason', () => {
  const policy = defaultPolicy()
  assert.equal(triggerEnabled(policy, 'auth'), false)
  policy.enabled = true
  assert.equal(triggerEnabled(policy, 'auth'), true)
  policy.triggers.rateLimit = false
  assert.equal(triggerEnabled(policy, 'rateLimit'), false)
})

test('normalizePolicy validates and merges', () => {
  const policy = normalizePolicy(defaultPolicy(), {
    enabled: true,
    triggers: { lowBalance: true },
    minBalance: { CNY: '0.5' },
    minIntervalMs: 60000,
  })
  assert.equal(policy.enabled, true)
  assert.equal(policy.triggers.lowBalance, true)
  assert.equal(policy.minBalance.CNY, '0.5')
  assert.equal(policy.minBalance.USD, '0.2')
  assert.equal(policy.minIntervalMs, 60000)

  assert.throws(() => normalizePolicy(defaultPolicy(), { enabled: 'yes' }))
  assert.throws(() => normalizePolicy(defaultPolicy(), { minBalance: { EUR: '1' } }))
  assert.throws(() => normalizePolicy(defaultPolicy(), { minIntervalMs: 1 }))
  assert.throws(() => normalizePolicy(defaultPolicy(), { maxSwitchesPer10Min: 100 }))
  assert.throws(() => normalizePolicy(defaultPolicy(), null))
})
