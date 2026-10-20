import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('package manifest declares a bundle and a web client half', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@local/dsh-account-switcher')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, 'lib/index.js')
  assert.equal(manifest.exports['.'], './lib/index.js')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-settings'])
})

test('bundle patch inserts the row with the package name', async () => {
  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /insert:/)
  assert.match(patch, /id: account-switcher/)
  assert.match(patch, /name: '@local\/dsh-account-switcher'/)
})

test('locale metadata and package description are Chinese', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.match(manifest.description, /DeepSeek/)
  assert.match(manifest.description, /账号/)
  for (const file of ['locale/en.json', 'locale/zh.json']) {
    const parsed = JSON.parse(await readFile(join(root, file), 'utf8'))
    assert.equal(parsed.meta.title, '账号切换')
    assert.match(parsed.meta.description, /DeepSeek/)
  }
})

test('host half exports a Cordis plugin', async () => {
  const module = await import('../lib/index.js')
  assert.equal(module.name, 'account-switcher')
  assert.deepEqual(module.inject, ['credentials'])
  assert.equal(typeof module.apply, 'function')
})

test('client half registers a lazy-CJS factory and a settings section', async () => {
  const code = await readFile(join(root, 'lib/client.js'), 'utf8')
  let registration
  const React = {
    createElement: (...args) => ({ type: args[0], props: args[1], children: args.slice(2) }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => undefined],
    useEffect: () => undefined,
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  }
  const primitives = { Button: 'Button', Switch: 'Switch', Tag: 'Tag', Input: 'Input' }
  const requireFn = (id) => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected client dependency: ${id}`)
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { registration = value } } },
    navigator: { language: 'zh-CN' },
  }
  vm.runInNewContext(code, sandbox, { filename: 'lib/client.js' })
  assert.equal(registration.id, '@local/dsh-account-switcher')
  const exports = registration.factory(requireFn)
  assert.equal(exports.inject.length, 1)
  assert.equal(exports.inject[0], 'slots')
  assert.equal(typeof exports.apply, 'function')

  let section
  const ctx = {
    slots: {
      inject: (name, factory) => { section = factory() },
      register: (spec, component) => ({ spec, component }),
    },
  }
  exports.apply(ctx)
  assert.equal(section.spec.name, 'settings.section')
  assert.equal(section.spec.id, 'account-switcher')
  assert.equal(section.spec.order, 20)
  assert.equal(section.spec.label(), '账号切换')
  assert.equal(typeof section.component, 'function')
})
