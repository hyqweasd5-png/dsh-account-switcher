import assert from 'node:assert/strict'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  emptyVault, hashToken, loadVault, maskToken, publicState, saveVault, upsertAccount,
} from '../lib/vault.js'

const grant = (token) => ({ version: 1, token, issuer: 'https://platform.deepseek.com' })

test('maskToken never returns the full token', () => {
  const token = 'mock-token-abcdefghijklmnop'
  const masked = maskToken(token)
  assert.notEqual(masked, token)
  assert.equal(masked, 'mock-t…mnop')
  assert.equal(maskToken('short'), '…')
})

test('hashToken is stable and short', () => {
  assert.equal(hashToken('abc'), hashToken('abc'))
  assert.equal(hashToken('abc').length, 16)
  assert.notEqual(hashToken('abc'), hashToken('abd'))
})

test('upsertAccount deduplicates by token and by stable uid', () => {
  const vault = emptyVault()
  const first = upsertAccount(vault, { grant: grant('one'), profile: { uid: 'u1', name: 'A', contact: null, avatarUrl: null }, label: '个人' })
  assert.equal(vault.accounts.length, 1)
  assert.equal(first.label, '个人')

  const sameToken = upsertAccount(vault, { grant: grant('one'), profile: { uid: 'u1', name: 'A2', contact: null, avatarUrl: null } })
  assert.equal(vault.accounts.length, 1)
  assert.equal(sameToken.id, first.id)
  assert.equal(sameToken.name, 'A2')

  const newToken = upsertAccount(vault, { grant: grant('two'), profile: { uid: 'u1', name: 'A3', contact: null, avatarUrl: null } })
  assert.equal(vault.accounts.length, 1)
  assert.equal(newToken.id, first.id)
  assert.equal(newToken.grant.token, 'two')
})

test('publicState excludes grants and exposes masked tokens', () => {
  const vault = emptyVault()
  const account = upsertAccount(vault, { grant: grant('token-0123456789'), profile: { uid: 'u1', name: 'A', contact: null, avatarUrl: null } })
  vault.activeId = account.id
  const state = publicState(vault)
  assert.equal(state.current.id, account.id)
  assert.equal('grant' in state.current, false)
  assert.equal('token' in state.current, false)
  assert.match(state.current.maskedToken, /…/)
  assert.equal(JSON.stringify(state).includes('token-0123456789'), false)
})

test('publicState reports a null current when signed out', () => {
  const state = publicState(emptyVault())
  assert.equal(state.current, null)
  assert.deepEqual(state.accounts, [])
})

test('saveVault writes 0600 and loadVault round-trips', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-switcher-vault-'))
  const file = join(dir, 'accounts.json')
  const vault = emptyVault()
  const account = upsertAccount(vault, { grant: grant('round-trip'), profile: { uid: 'u1', name: 'A', contact: null, avatarUrl: null } })
  vault.activeId = account.id
  await saveVault(file, vault)
  const mode = (await stat(file)).mode & 0o777
  assert.equal(mode, 0o600)
  const loaded = await loadVault(file)
  assert.equal(loaded.accounts.length, 1)
  assert.equal(loaded.activeId, account.id)
  assert.equal(loaded.accounts[0].grant.token, 'round-trip')
})

test('loadVault moves an unreadable file aside instead of overwriting it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'account-switcher-corrupt-'))
  const file = join(dir, 'accounts.json')
  await saveVault(file, emptyVault())
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, '{ not json', 'utf8')
  const warnings = []
  const loaded = await loadVault(file, { warn: (message) => warnings.push(message) })
  assert.equal(loaded.accounts.length, 0)
  assert.equal(warnings.length >= 1, true)
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(dir)
  assert.equal(entries.some((entry) => entry.includes('.corrupt-')), true)
})
