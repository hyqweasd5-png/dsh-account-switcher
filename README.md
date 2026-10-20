# DSH 账号切换器

在 DeepSeek Harness 里管理多个 DeepSeek 官方账号，并在不重启 GUI、不撤销 token 的前提下切换。可选地按鉴权失效、额度耗尽、限流或低余额自动轮换。

> 适用版本：DeepSeek Harness Desktop `0.2.1-rc.2`（源码 tag 同版本）。插件只使用 Cordis 服务与 Node 内置模块，不依赖任何 `@deepseek-ai/*` 运行时包；升级 DSH 后若设置页不出现，请先检查 Host 日志中的 `account-switcher` 前缀。

## 与登录插件配合

本插件只做切换/轮换；登录、服务器 portal、SSH 隧道、token 缓存都在独立的
`dsh-account-login` 插件里。两个插件都安装后：

```text
登录管理（登录插件） → 登录新账号 → grant 写入 ~/.dsh/account-login/accounts.json
账号切换（本插件）   → 同步登录账号 → 导入 grant → 切换/轮换
```

## 安装

### 命令行安装（源码）

```bash
dsh plugin --profile web add github:hyqweasd5-png/dsh-account-switcher
```

安装后重启一次 DeepSeek Harness。

### 本地路径安装

1. 打开 DSH，进入 **插件** 页。
2. 点 **添加插件** → **安装第三方插件**。
3. 在包名/路径输入框中填本目录的绝对路径：

   ```text
   /path/to/dsh-account-switcher
   ```

   （替换成你本机的实际路径）

4. 安装完成后按提示 **立即启用**，然后重启一次 DeepSeek Harness。
5. 打开 **设置**，左侧应出现 **账号切换**。

安装只需要重启这一次；之后所有切换都是热生效。

## 使用

- **保存当前账号**：把当前登录的账号存入账号库，可附带备注名。
- **添加账号**：调用官方浏览器登录流程新增一个账号。登录成功后会自动入库并设为当前账号，**不会撤销原账号的 token**。
- **导入 token**：粘贴一个已有的 **platform.deepseek.com DSH 账号 grant**（`x-dsh-auth-token` 的值）。会先请求平台校验身份，失败则拒绝写入。
  - `chat.deepseek.com` 的网页会话 token **不能直接导入**：它是另一套服务的凭证，平台接口会返回 `code 40003`。这类账号请用「添加账号」走一次平台浏览器登录。
  - 需要平台 token 时，最可靠的来源是另一个已登录 DSH 的 `~/.dsh/.credentials.yaml` 中 `deepseek-account-platform/default` 的 `payload.token`。
- **用网页 token 交换**：如果已经登录 `platform.deepseek.com`，可以从浏览器 DevTools 的任一平台请求复制 `Authorization: Bearer ...` 的 token。插件会按平台授权页相同的 `auth_init → auth_approve → auth_exchange` 流程换取 DSH grant，并导入/切换。
  - 只支持 **platform.deepseek.com** 的登录 token；`chat.deepseek.com` 的网页 token 会被平台拒绝（`40003`）。
  - 网页 token 只用于这一次交换，不会写入账号库或日志。
  - 这是平台自己的授权入口，但仍属于未公开接口；如果平台改版导致失败，请改用「添加账号」。
- **切换**：把目标账号的 grant 写入凭证存储。官方账号页和后续模型请求会在约 1 秒内使用新账号。
- **同步登录账号**：登录由独立插件 `dsh-account-login` 负责；登录后在本页点「同步登录账号」，从 `~/.dsh/account-login/accounts.json` 导入 grant。
- **余额**：启动同步、切换、保存/导入后都会在后台拉取资料和余额；打开设置页时如果发现余额为空，会自动刷新一次，也可以点「刷新」手动更新。显示为「余额 X CNY」，赠金已并入同一个总额（按币种合计）；低余额轮换也按这个总额比较。
- **删除**：只从本地账号库移除。删除当前账号时会先切到下一个；没有下一个则只做本地登出，不向平台发 logout。

### ⚠️ 不要用官方「退出登录」切号

官方账号页的「退出登录」会调用 `POST /auth-api/v0/users/logout`，在服务器端撤销 token。一旦撤销，账号库里保存的副本也会失效。切换请始终使用本页的「切换」。

## 自动轮换

默认关闭。开启后按以下信号切换：

| 信号 | 来源 | 行为 |
|---|---|---|
| 登录态失效（401 / 40003） | 账号事件、模型错误 | 当前号标记失效，切下一个 |
| 额度耗尽（402 / `QUOTA`） | 模型错误 | 当前号冷却，切下一个 |
| 限流（429 / `RATE_LIMIT`） | 模型错误 | 当前号冷却，切下一个；连续两个号都被限流时暂停 5 分钟 |
| 余额低于阈值 | 定时轮询 | 仅在无运行中会话时切换 |

守卫：最小切换间隔 30 秒、10 分钟最多 3 次、账号冷却 10 分钟。没有可用账号时只告警，不删除当前 grant。所有切换写入轮换日志。

余额按币种比较，不跨币种换算。轮询间隔默认 5 分钟。

## 工作原理

DSH 的官方账号状态就是凭证存储中的一条记录：

```text
~/.dsh/.credentials.yaml
  deepseek-account-platform/default:
    kind: grant
    payload: { version: 1, token, issuer }
```

切换时插件用 `ctx.credentials.modifyRecord` 原子替换这条记录。凭证存储监听文件变化并发出 `credentials/record-updated`，账号插件收到后清空缓存的资料/余额；推理侧的 `resolveToken` 每个请求现读记录。因此不需要重启，也不存在“内存里的旧 token”。

账号库保存在独立文件中：

```text
~/.dsh/account-switcher/accounts.json   # 0600，目录 0700
```

只存 grant、显示资料、余额快照和最近 50 条轮换日志。文件损坏时会改名为 `accounts.json.corrupt-<时间戳>`，不会静默覆盖。

## 界面语言

插件卡片、设置分区和页面文案固定为中文。Electron 的 `navigator.language` 经常是 `en-US`，如果按它判断，中文界面里会出现英文；因此本插件不跟随浏览器语言。`locale/en.json` 与 `locale/zh.json` 都填了中文标题和说明，插件卡片在两种 locale 下都显示中文。

## 安全

- 账号库文件权限 0600；目录 0700。
- 浏览器 API 不返回 token，只返回 `maskedToken`（前 6 + 后 4）。
- API 仅接受 loopback 请求，并要求 `x-account-switcher: 1`；写请求如果带了 `Origin`，该 Origin 必须是 loopback（`localhost`、`127.0.0.1`、`[::1]`，端口不限）。Electron 有时不发 `Origin`，此时以自定义头作为 CSRF 门。
- 平台请求 `redirect: 'error'`、30 秒超时、响应体上限 64 KiB；日志不记录 token 或响应正文。

## 配置

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 中覆盖 bundle patch 的 config：

```yaml
- id: account-switcher
  config:
    platformOrigin: https://platform.deepseek.com
    debug: false
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `platformOrigin` | `https://platform.deepseek.com` | 官方平台源；开发时可配 loopback HTTP |
| `debug` | `false` | 开启 `POST /account-switcher/api/debug/trigger`，用于测试轮换 |
| `vaultPath` | `$DSH_HOME/account-switcher/accounts.json` | 账号库路径 |
| `clientVersion` | `0.2.1-rc.2` | 平台请求的 `x-client-version` |
| `locale` | 系统语言 | 平台请求的 `x-client-locale` |

## 故障排查

- **设置页没有「账号切换」**：确认插件已启用、App 已重启；查看 Host 日志中是否有 `account-switcher: ready`。
- **页面 403**：确认从 `http://127.0.0.1:<端口>` 打开 GUI；API 拒绝非 loopback 或缺少请求标记的调用。
- **切换失败并恢复原账号**：目标 token 可能已失效。看账号行上的 `token-invalid` 标记，重新登录或导入。
- **账号显示“已失效”**：平台拒绝了 token（401/40003）。插件不会删除条目，重新登录后覆盖即可。
- **官方退出登录后账号失效**：这是预期行为，远端 token 已被撤销。重新登录该账号。

## 卸载

在 **插件** 页移除 `@local/dsh-account-switcher`，重启 App。当前账号的 grant 仍在凭证存储中，不受影响；账号库文件保留，可手动删除：

```bash
rm -rf ~/.dsh/account-switcher
```

## 目录结构

```text
dsh-account-switcher/
├── package.json          # bundle + client manifest
├── cordis.patch.yml      # 插入 Host 插件行
├── lib/
│   ├── index.js          # Host 半：服务接线、切换、轮换
│   ├── vault.js          # 账号库读写
│   ├── platform.js       # 平台资料/余额查询
│   ├── rotation.js       # 轮换决策与策略校验
│   ├── routes.js         # 同源 JSON API
│   └── client.js         # 设置页 lazy-CJS bundle
└── test/                 # node --test
```

## 限制

- 官方账号 token 没有过期/刷新流程；失效后需要重新登录。
- 自动轮换只保证“下一次请求使用新账号”，不会自动重发失败的那一轮对话。
- 账号的模型目录按 token 区分；切换后若目标账号不支持当前模型，模型请求会失败，需要换模型或换号。
- 不管理第三方 provider 的 API Key（CPA、bai、opencode-go）。
- 账号库假设同一时间只有一个 Host 在写；同时运行 Desktop 和另一个安装了本插件的 profile 时，后写入者会覆盖先写入者的账号库快照。活动 grant 本身仍由凭证存储的跨进程锁保护。
- 多账号轮换若用于规避额度或平台风控，可能违反服务条款；请只管理你自己的账号。
