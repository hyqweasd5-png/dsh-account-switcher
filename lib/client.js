window.__ModuleLoader__.load({
  id: '@local/dsh-account-switcher',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { Button, Switch, Tag, Input } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/account-switcher/api'

    const zh = {
      title: '账号切换',
      subtitle: '在多个 DeepSeek 官方账号之间切换；自动轮换默认关闭。',
      warning: '请勿使用官方账号页的「退出登录」来切号：它会向服务器撤销 token。请用本页的「切换」，或在账号库中删除。',
      refresh: '刷新',
      sync: '同步当前',
      syncLogin: '同步登录账号',
      saveCurrent: '保存当前账号',
      addAccount: '添加账号',
      importToken: '导入 token',
      tokenPlaceholder: '粘贴 platform.deepseek.com 的 DSH 账号 token',
      importHint: '只接受 platform.deepseek.com 的 DSH 账号 grant。chat.deepseek.com 的网页 token 不能直接导入，请改用「添加账号」走一次平台登录。',
      exchangeTitle: '用网页 token 交换',
      exchangeHint: '仅支持 platform.deepseek.com 的登录 token（浏览器 DevTools → Network → 请求头 Authorization: Bearer 后面的部分）。chat.deepseek.com 的网页 token 无效；没有平台 token 时请用「添加账号」。',
      exchangePlaceholder: '粘贴 platform.deepseek.com 的 Bearer token',
      exchange: '交换并导入',
      labelPlaceholder: '备注名（可选）',
      import: '导入并切换',
      cancel: '取消',
      current: '当前账号',
      noCurrent: '当前未登录任何账号。先在官方账号页登录，或点击「添加账号」。',
      accounts: '账号库',
      empty: '账号库为空。登录后点「保存当前账号」，或导入一个 token。',
      balanceUnknown: '余额未知',
      balanceNone: '余额为 0',
      balanceLabel: '余额',
      statusIdle: '空闲',
      statusActive: '当前',
      statusCooldown: '冷却中',
      statusDead: '已失效',
      switch: '切换',
      remove: '删除',
      refreshOne: '刷新',
      autoRotation: '自动轮换',
      autoRotationHint: '开启后，遇到鉴权失效、额度耗尽、限流或低余额时自动切到下一个账号。',
      enabled: '启用自动轮换',
      triggerAuth: '登录态失效（401/40003）',
      triggerQuota: '额度耗尽（402/QUOTA）',
      triggerRate: '限流（429/RATE_LIMIT）',
      triggerBalance: '余额低于阈值',
      minBalanceCny: '最低余额（CNY）',
      minBalanceUsd: '最低余额（USD）',
      minInterval: '最小切换间隔（毫秒）',
      cooldown: '账号冷却（毫秒）',
      maxSwitches: '10 分钟最多切换次数',
      pollMs: '余额轮询间隔（毫秒）',
      savePolicy: '保存策略',
      policySaved: '策略已保存',
      log: '轮换日志',
      loginWaiting: '等待浏览器完成授权…完成后本页会自动刷新。',
      openLogin: '重新打开授权页',
      cancelLogin: '取消登录',
      loginStarted: '已打开浏览器授权页',
      importDone: '已导入',
      switchDone: '已切换',
      saveDone: '已保存',
      removeConfirm: '确定从账号库删除该账号？只删除本地记录，不会撤销远端 token。',
      uid: 'UID',
      token: '令牌',
      profileUnavailable: '资料暂不可用',
      busy: '处理中…',
      errTokenInvalid: '登录态已失效',
      errSignedOut: '已退出登录',
      errSwitchFailed: '切换失败',
      errProfileUnavailable: '资料暂不可用',
      errRefreshFailed: '刷新失败',
      errQuota: '额度不足',
      errRateLimit: '触发限流',
      errAuth: '登录态失效',
      errBalance: '余额不足',
      errGeneric: '处理失败',
    }


    // The switcher ships Chinese copy. DSH's active UI locale can be English
    // (Electron often reports en-US even when the user reads Chinese), so the
    // page does not key its text off navigator.language.
    const t = (key) => zh[key] ?? key

    const styles = {
      root: {
        display: 'flex', flexDirection: 'column', gap: 16, padding: '8px 0 24px',
        color: 'var(--dsw-alias-text-primary, inherit)', fontSize: 13, lineHeight: 1.5,
      },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
      title: { fontSize: 16, fontWeight: 600, margin: 0 },
      subtitle: { color: 'var(--dsw-alias-text-tertiary, #888)', marginTop: 4, maxWidth: 620 },
      actions: { display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' },
      card: {
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.28))', borderRadius: 12,
        padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
        background: 'var(--dsw-alias-bg-elevated, transparent)',
      },
      warning: {
        border: '1px solid var(--dsw-alias-border-warning, rgba(214,158,46,.45))',
        color: 'var(--dsw-alias-text-warning, #8a6d1f)',
        background: 'var(--dsw-alias-bg-warning, rgba(214,158,46,.08))',
        borderRadius: 10, padding: '10px 12px',
      },
      row: { display: 'flex', alignItems: 'center', gap: 12 },
      grow: { flex: 1, minWidth: 0 },
      nameLine: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      muted: { color: 'var(--dsw-alias-text-tertiary, #888)', fontSize: 12, marginTop: 2, overflowWrap: 'anywhere' },
      rowActions: { display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' },
      accountRow: {
        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0',
        borderTop: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.18))',
      },
      accountRowFirst: { borderTop: 'none' },
      avatar: {
        width: 36, height: 36, borderRadius: 18, flexShrink: 0, overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600,
        background: 'var(--dsw-alias-bg-secondary, rgba(128,128,128,.16))',
      },
      cardTitle: { fontWeight: 600, fontSize: 13 },
      fieldGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 },
      field: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 },
      fieldLabel: { color: 'var(--dsw-alias-text-tertiary, #888)' },
      switchRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
      switchText: { display: 'flex', flexDirection: 'column', gap: 2 },
      hint: { color: 'var(--dsw-alias-text-tertiary, #888)', fontSize: 12 },
      error: {
        border: '1px solid var(--dsw-alias-border-danger, rgba(214,67,67,.45))',
        color: 'var(--dsw-alias-text-danger, #c33)',
        background: 'var(--dsw-alias-bg-danger, rgba(214,67,67,.07))',
        borderRadius: 10, padding: '8px 12px', whiteSpace: 'pre-wrap',
      },
      link: { color: 'var(--dsw-alias-text-link, #4a7dff)', overflowWrap: 'anywhere', fontSize: 12 },
      logLine: { fontSize: 12, padding: '3px 0', borderTop: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.14))' },
      summary: { cursor: 'pointer', fontWeight: 600, fontSize: 13 },
    }

    async function api(path, body) {
      const init = { method: body === undefined ? 'GET' : 'POST', headers: { 'x-account-switcher': '1' } }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      const response = await fetch(`${API}${path}`, init)
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data.ok === false) {
        const error = new Error(data?.error?.message ?? `请求失败（HTTP ${response.status}）`)
        error.code = data?.error?.code
        throw error
      }
      return data
    }

    function statusTag(state) {
      const map = {
        active: ['success', t('statusActive')],
        idle: ['neutral', t('statusIdle')],
        cooldown: ['warning', t('statusCooldown')],
        dead: ['danger', t('statusDead')],
      }
      const [tone, label] = map[state] ?? ['neutral', state]
      return h(Tag, { tone, key: `tag-${state}` }, label)
    }

    function formatAmount(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return String(value)
      return number.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    }

    function balanceText(account) {
      const snapshot = account?.balance
      if (snapshot === undefined || snapshot === null || snapshot.checkedAt === 0) return t('balanceUnknown')
      const totals = new Map()
      for (const wallet of [...(snapshot.normal ?? []), ...(snapshot.bonus ?? [])]) {
        const value = Number(wallet.balance)
        if (!Number.isFinite(value)) continue
        totals.set(wallet.currency, (totals.get(wallet.currency) ?? 0) + value)
      }
      if (totals.size === 0) return t('balanceNone')
      const amounts = [...totals].map(([currency, value]) => `${formatAmount(value)} ${currency}`).join(' / ')
      return `${t('balanceLabel')} ${amounts}`
    }

    const ERROR_TEXT = {
      'token-invalid': 'errTokenInvalid',
      'signed-out': 'errSignedOut',
      'switch-failed': 'errSwitchFailed',
      'profile-unavailable': 'errProfileUnavailable',
      'refresh-failed': 'errRefreshFailed',
      quota: 'errQuota',
      rateLimit: 'errRateLimit',
      auth: 'errAuth',
      balance: 'errBalance',
    }

    function errorText(code) {
      if (code === null || code === undefined || code === '') return ''
      const key = ERROR_TEXT[code]
      return key === undefined ? `${t('errGeneric')}（${code}）` : t(key)
    }

    function Avatar({ account }) {
      const initial = String(account?.name ?? account?.label ?? '?').trim().slice(0, 1).toUpperCase()
      return h('div', { style: styles.avatar }, account?.avatarUrl
        ? h('img', {
          src: account.avatarUrl, alt: '', style: { width: '100%', height: '100%', objectFit: 'cover' },
          referrerPolicy: 'no-referrer',
          onError: (event) => { event.currentTarget.style.display = 'none' },
        })
        : initial)
    }

    function Field({ label, children }) {
      return h('label', { style: styles.field }, h('span', { style: styles.fieldLabel }, label), children)
    }

    function ToggleRow({ label, hint, checked, onChange }) {
      return h('div', { style: styles.switchRow },
        h('div', { style: styles.switchText },
          h('div', null, label),
          hint === undefined ? null : h('div', { style: styles.hint }, hint)),
        h(Switch, { checked, onChange, label }))
    }

    function Page() {
      const [snapshot, setSnapshot] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState('')
      const [token, setToken] = useState('')
      const [webToken, setWebToken] = useState('')
      const [label, setLabel] = useState('')
      const [policy, setPolicy] = useState(null)
      const [login, setLogin] = useState(null)
      const mounted = useRef(true)
      const loginBaseline = useRef(null)
      const bootstrapped = useRef(false)

      useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
      }, [])

      const load = useCallback(async () => {
        try {
          const data = await api('/state')
          if (!mounted.current) return null
          setSnapshot(data)
          setError(null)
          return data
        } catch (cause) {
          if (mounted.current) setError(cause.message)
          return null
        }
      }, [])

      useEffect(() => {
        load()
        const timer = setInterval(load, 2000)
        return () => clearInterval(timer)
      }, [load])

      useEffect(() => {
        if (snapshot?.rotation !== undefined && policy === null) setPolicy(snapshot.rotation)
      }, [snapshot, policy])

      useEffect(() => {
        if (login === null || snapshot === null) return
        const currentHash = snapshot.current?.tokenHash ?? null
        if (currentHash !== loginBaseline.current) {
          setLogin(null)
          setBusy('')
        }
      }, [snapshot, login])

      const act = useCallback(async (name, operation) => {
        setBusy(name)
        setError(null)
        try {
          const data = await operation()
          if (!mounted.current) return data
          if (data?.accounts !== undefined) setSnapshot(data)
          else await load()
          return data
        } catch (cause) {
          if (mounted.current) setError(cause.message)
          return null
        } finally {
          if (mounted.current) setBusy('')
        }
      }, [load])

      useEffect(() => {
        if (bootstrapped.current || snapshot === null) return
        bootstrapped.current = true
        const stale = (snapshot.accounts ?? []).some((account) => Number(account.balance?.checkedAt ?? 0) === 0)
        if (stale) act('refresh', () => api('/refresh', {}))
      }, [snapshot, act])

      const switchTo = (id) => act('switch', () => api('/switch', { id }))
      const saveCurrent = () => act('save', () => api('/save-current', { label: label.trim() || undefined }))
      const refreshAll = () => act('refresh', () => api('/refresh', {}))
      const refreshOne = (id) => act('refresh', () => api('/refresh', { id }))
      const syncCurrent = () => act('sync', () => api('/sync', {}))
      const syncLogin = () => act('sync-login', () => api('/sync-login', {}))
      const removeAccount = async (account) => {
        if (!window.confirm(t('removeConfirm'))) return
        await act('remove', () => api('/remove', { id: account.id }))
      }

      const importToken = async () => {
        const value = token.trim()
        if (value === '') return
        const data = await act('import', () => api('/import', { token: value, label: label.trim() || undefined, switch: true }))
        if (data !== null) {
          setToken('')
          setLabel('')
        }
      }

      const exchangeToken = async () => {
        const value = webToken.trim()
        if (value === '') return
        const data = await act('exchange', () => api('/exchange', {
          token: value,
          label: label.trim() || undefined,
          switch: true,
        }))
        if (data !== null) setWebToken('')
      }

      const startLogin = async () => {
        const data = await act('login', () => api('/login/start', {
          locale: navigator.language,
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        }))
        if (data?.url) {
          loginBaseline.current = snapshot?.current?.tokenHash ?? null
          setLogin({ url: data.url, attemptId: data.attemptId })
          window.open(data.url, '_blank', 'noopener,noreferrer')
        }
      }

      const cancelLogin = async () => {
        if (login?.attemptId) await act('cancel-login', () => api('/login/cancel', { attemptId: login.attemptId }))
        setLogin(null)
      }

      const savePolicy = async () => {
        if (policy === null) return
        const data = await act('policy', () => api('/policy', { rotation: policy }))
        if (data !== null) setError(null)
      }

      const current = snapshot?.current ?? null
      const accounts = snapshot?.accounts ?? []

      return h('div', { style: styles.root },
        h('div', { style: styles.header },
          h('div', null,
            h('div', { style: styles.title }, t('title')),
            h('div', { style: styles.subtitle }, t('subtitle'))),
          h('div', { style: styles.actions },
            h(Button, { size: 'sm', variant: 'ghost', disabled: busy !== '', onClick: refreshAll }, t('refresh')),
            h(Button, { size: 'sm', variant: 'ghost', disabled: busy !== '', onClick: syncCurrent }, t('sync')),
            h(Button, { size: 'sm', variant: 'ghost', disabled: busy !== '', onClick: syncLogin }, t('syncLogin')),
            h(Button, { size: 'sm', variant: 'outline', disabled: busy !== '', onClick: saveCurrent }, t('saveCurrent')),
            h(Button, { size: 'sm', variant: 'primary', disabled: busy !== '', onClick: startLogin }, t('addAccount')))),

        h('div', { style: styles.warning }, t('warning')),
        error === null ? null : h('div', { style: styles.error }, error),
        busy === '' ? null : h('div', { style: styles.hint }, t('busy')),

        login === null ? null : h('div', { style: styles.card },
          h('div', { style: styles.cardTitle }, t('loginStarted')),
          h('div', { style: styles.hint }, t('loginWaiting')),
          h('a', { style: styles.link, href: login.url, target: '_blank', rel: 'noreferrer' }, login.url),
          h('div', { style: styles.rowActions },
            h(Button, { size: 'sm', variant: 'ghost', onClick: () => window.open(login.url, '_blank', 'noopener,noreferrer') }, t('openLogin')),
            h(Button, { size: 'sm', variant: 'ghost', disabled: busy !== '', onClick: cancelLogin }, t('cancelLogin')))),

        h('div', { style: styles.card },
          h('div', { style: styles.cardTitle }, t('current')),
          current === null
            ? h('div', { style: styles.hint }, t('noCurrent'))
            : h('div', { style: styles.row },
              h(Avatar, { account: current }),
              h('div', { style: styles.grow },
                h('div', { style: styles.nameLine },
                  h('strong', null, current.label),
                  statusTag(current.state),
                  current.name === null ? null : h('span', { style: styles.hint }, current.name)),
                h('div', { style: styles.muted }, [
                  current.uid === null ? null : `${t('uid')} ${current.uid}`,
                  `${t('token')} ${current.maskedToken}`,
                ].filter(Boolean).join(' · ')),
                h('div', { style: styles.muted }, balanceText(current))))),

        h('div', { style: styles.card },
          h('div', { style: styles.cardTitle }, t('accounts')),
          accounts.length === 0
            ? h('div', { style: styles.hint }, t('empty'))
            : accounts.map((account, index) => h('div', {
              key: account.id,
              style: index === 0 ? { ...styles.accountRow, ...styles.accountRowFirst } : styles.accountRow,
            },
            h(Avatar, { account }),
            h('div', { style: styles.grow },
              h('div', { style: styles.nameLine },
                h('strong', null, account.label),
                statusTag(account.state),
                account.name === null ? null : h('span', { style: styles.hint }, account.name)),
              h('div', { style: styles.muted }, [
                account.uid === null ? null : `${t('uid')} ${account.uid}`,
                `${t('token')} ${account.maskedToken}`,
              ].filter(Boolean).join(' · ')),
              h('div', { style: styles.muted }, account.lastError === null ? balanceText(account) : `${balanceText(account)} · ${errorText(account.lastError)}`)),
            h('div', { style: styles.rowActions },
              h(Button, {
                size: 'sm', variant: account.id === current?.id ? 'primary' : 'outline',
                disabled: busy !== '' || account.id === current?.id || account.state === 'dead',
                onClick: () => switchTo(account.id),
              }, account.id === current?.id ? t('current') : t('switch')),
              h(Button, { size: 'sm', variant: 'ghost', disabled: busy !== '', onClick: () => refreshOne(account.id) }, t('refreshOne')),
              h(Button, { size: 'sm', variant: 'ghost', disabled: busy !== '', onClick: () => removeAccount(account) }, t('remove')))))),

        h('div', { style: styles.card },
          h('div', { style: styles.cardTitle }, t('importToken')),
          h('div', { style: styles.hint }, t('importHint')),
          h(Input, {
            value: token, onChange: (event) => setToken(event.target.value),
            placeholder: t('tokenPlaceholder'), autoComplete: 'off', spellCheck: false,
          }),
          h(Input, {
            value: label, onChange: (event) => setLabel(event.target.value),
            placeholder: t('labelPlaceholder'), autoComplete: 'off',
          }),
          h('div', { style: styles.rowActions },
            h(Button, { size: 'sm', variant: 'primary', disabled: token.trim() === '' || busy !== '', onClick: importToken }, t('import')))),

        h('div', { style: styles.card },
          h('div', { style: styles.cardTitle }, t('exchangeTitle')),
          h('div', { style: styles.hint }, t('exchangeHint')),
          h(Input, {
            value: webToken, onChange: (event) => setWebToken(event.target.value),
            placeholder: t('exchangePlaceholder'), autoComplete: 'off', spellCheck: false,
          }),
          h(Input, {
            value: label, onChange: (event) => setLabel(event.target.value),
            placeholder: t('labelPlaceholder'), autoComplete: 'off',
          }),
          h('div', { style: styles.rowActions },
            h(Button, { size: 'sm', variant: 'primary', disabled: webToken.trim() === '' || busy !== '', onClick: exchangeToken }, t('exchange')))),

        policy === null ? null : h('div', { style: styles.card },
          h('div', { style: styles.cardTitle }, t('autoRotation')),
          h('div', { style: styles.hint }, t('autoRotationHint')),
          h(ToggleRow, {
            label: t('enabled'), checked: policy.enabled === true,
            onChange: (value) => setPolicy({ ...policy, enabled: value }),
          }),
          h(ToggleRow, {
            label: t('triggerAuth'), checked: policy.triggers?.authInvalid === true,
            onChange: (value) => setPolicy({ ...policy, triggers: { ...policy.triggers, authInvalid: value } }),
          }),
          h(ToggleRow, {
            label: t('triggerQuota'), checked: policy.triggers?.quota === true,
            onChange: (value) => setPolicy({ ...policy, triggers: { ...policy.triggers, quota: value } }),
          }),
          h(ToggleRow, {
            label: t('triggerRate'), checked: policy.triggers?.rateLimit === true,
            onChange: (value) => setPolicy({ ...policy, triggers: { ...policy.triggers, rateLimit: value } }),
          }),
          h(ToggleRow, {
            label: t('triggerBalance'), checked: policy.triggers?.lowBalance === true,
            onChange: (value) => setPolicy({ ...policy, triggers: { ...policy.triggers, lowBalance: value } }),
          }),
          h('div', { style: styles.fieldGrid },
            h(Field, { label: t('minBalanceCny') }, h(Input, {
              value: String(policy.minBalance?.CNY ?? ''), inputMode: 'decimal',
              onChange: (event) => setPolicy({ ...policy, minBalance: { ...policy.minBalance, CNY: event.target.value } }),
            })),
            h(Field, { label: t('minBalanceUsd') }, h(Input, {
              value: String(policy.minBalance?.USD ?? ''), inputMode: 'decimal',
              onChange: (event) => setPolicy({ ...policy, minBalance: { ...policy.minBalance, USD: event.target.value } }),
            })),
            h(Field, { label: t('minInterval') }, h(Input, {
              value: String(policy.minIntervalMs ?? ''), inputMode: 'numeric',
              onChange: (event) => setPolicy({ ...policy, minIntervalMs: event.target.value }),
            })),
            h(Field, { label: t('cooldown') }, h(Input, {
              value: String(policy.cooldownMs ?? ''), inputMode: 'numeric',
              onChange: (event) => setPolicy({ ...policy, cooldownMs: event.target.value }),
            })),
            h(Field, { label: t('maxSwitches') }, h(Input, {
              value: String(policy.maxSwitchesPer10Min ?? ''), inputMode: 'numeric',
              onChange: (event) => setPolicy({ ...policy, maxSwitchesPer10Min: event.target.value }),
            })),
            h(Field, { label: t('pollMs') }, h(Input, {
              value: String(policy.pollMs ?? ''), inputMode: 'numeric',
              onChange: (event) => setPolicy({ ...policy, pollMs: event.target.value }),
            }))),
          h('div', { style: styles.rowActions },
            h(Button, { size: 'sm', variant: 'primary', disabled: busy !== '', onClick: savePolicy }, t('savePolicy')))),

        h('details', { style: styles.card },
          h('summary', { style: styles.summary }, t('log')),
          (snapshot?.log ?? []).slice().reverse().map((entry, index) => h('div', {
            key: `${entry.at}-${index}`, style: styles.logLine,
          }, `${new Date(entry.at).toLocaleTimeString()}  ${entry.message}`))))
    }

    exports.inject = ['slots']
    exports.apply = function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'account-switcher',
        order: 20,
        label: () => t('title'),
      }, Page))
    }

    return module.exports
  },
})
