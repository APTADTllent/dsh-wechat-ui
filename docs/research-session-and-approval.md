# DSH 会话 / 注入 / 权限 —— 技术调研笔记

> 来源：只读调研（2026-09-17），核对了 `~/.dsh/profiles/node_modules/@deepseek-ai/` 下各包的
> `lib/types/*.d.ts` 与 `lib/index.js`，并实读了本机 37 个会话文件。
> 这份笔记是「桌面通知 / 权限批准 / 自动 NEXT / 历史同步」几个阶段的设计依据。

---

## 1. 会话数据在哪、长什么样

**位置**：`~/.dsh/sessions/--<规范化 cwd>--/<encoded-session-id>/session.v3.jsonl.zstd`
（历史会话是 `session.jsonl.zstd`，v0 格式）

**物理格式**：多帧 Zstandard 拼接。第一帧只有 header 行，之后每次 append 一批一帧。
→ **读它必须先解 zstd**，Node 内置没有 zstd 解压，需要 `zlib.zstdDecompressSync`（Node 22+ 才有）
或第三方包。这是实现"历史同步"时要先解决的问题。

**当前格式版本**：`SESSION_FORMAT_VERSION = 3`

Header 行示例：
```json
{"type":"session","version":3,"id":"session-...","createdAt":...,"cwd":"...","agentPreset":"standard"}
```

事件信封：`{ type, seq, time, data, ignorable? }`，`seq` 单调递增。

**只有 4 种事件会产生 LLM 消息（surface event）**：
`system/message` · `user/message` · `assistant/message` · `tool/result`

**关心的内容落在哪**：

| 内容 | 事件 | 位置 |
|---|---|---|
| 用户消息 | `user/message` | `data.content[] = [{type:'text',text},...]` |
| 助手消息 | `assistant/message` | `data.message.content[]` |
| **思考过程** | `assistant/message` | `message.content[]` 里 `{type:'reasoning',text}` |
| 工具调用 | `tool/call` + `tool/result` | `arguments` 是**未解析的 JSON 字符串** |
| 权限请求 | `approval/asked` / `approval/decided` | `{id, toolName, callId?, reason?}` / `{id, outcome}` |
| 权限策略 | `approval/policy` | — |
| **ask_user_question** | **没有专属事件** | 就是普通 `tool/call` + `tool/result`，问答都在里面 |

`ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`，策略 `ask | never`。

---

## 2. 外部注入一条用户消息 —— 可行

**等价于"输入框打字并回车"的官方接口**：`session/prompt`（Gateway 的 unary Remote 方法）。

```
POST http://127.0.0.1:3080/api/session/prompt
content-type: application/json
cookie: dsh-auth-<base64url(sha256(authority))>=v1.<payload>.<hmac>

{"type":"client-request","rpcId":"<uuid>","method":"session/prompt",
 "payload":{"args":{"request":{
   "requestId":"<uuid>",              // 客户端自铸的幂等身份
   "sessionId":"session-...",
   "mode":"queue",                    // queue=排队新回合 | steer=打断当前回合
   "content":[{"type":"text","text":"NEXT"}]}}}}
```

**鉴权**（唯一门槛，实测未带 cookie 返回 401 而非 404 ⇒ 路由确实在）：
- cookie 名 = `dsh-auth-` + base64url(sha256(`"127.0.0.1:3080"`))
- cookie 值 = `v1.<body>.<base64url(hmac_sha256(secret, body))>`，body 内含 `expiresAt`
- **secret 持久化**在 `~/.credentials.yaml` → `records["client-connection/browser-session"].payload.secret`
  （32 字节 base64url）→ **外部进程可以自己铸 cookie，不需要浏览器配合**

⚠️ `~/.dsh/dsh-web.log` 里那行 `?token=...` **不可靠**：进程启动 token 存在内存 WeakMap 里，
日志那条往往是旧进程留下的（实测拿它换 cookie 得到 401）。**不要依赖它。**

**进程内等价物**（宿主插件可直接用）：`SessionController.prompt` → `agent.followup()` / `agent.steer()`。
- `followup` = 排队一个普通回合并唤醒 driver
- `steer` = 送到最近一个 step 边界（运行中=插话，空闲=开新回合）
- `inject` = 只投喂上下文，**不唤醒**（不适合"发 NEXT"）

**其他可用端点**：`session/list`（参数名是 `_request`）、`session/page`、`session/create`、
`session/fork`、`session/rename`、`session/cancel`、`session/selectModel`、`session/search`。
`session/follow` 与 `session/control` 是 stream，只能走 WebSocket `/api/remote.mux`。

**走不通的路**：`@deepseek-ai/dsh-sdk-jsonrpc-server`（stdio JSON-RPC）—— 它必须是 harness 进程的
stdio 所有者（要另起 profile），**无法挂到已在跑的 web 进程**，也不能接管 web 进程里 live 的会话。

---

## 3. 权限请求的完整链路 —— 以及那个洞

```
工具层 / sandbox 升级
   → ApprovalService.request()
   → session.append('approval/asked')
   → ctx.waterfall(agent, 'approval/request', req, fallback)
   → dsh-api-remotes 转发的白名单命中
   → WS /api/remote.mux 的 $events 流下行 {type:'waterfall', eventId, request}
   → 浏览器 UI 弹出面板，用户选择
   → POST /api/$events/result  {clientId, eventId, outcome}
   → waterfall 兑现
   → session.append('approval/decided')
```

转发白名单（`dsh-api-remotes`）：`approval/request` 与 `user-questions/request`，都是 waterfall 模式。

### ⚠️ 关键发现：不打开浏览器时，权限请求会**一直挂着**

`dsh-api-remotes` 是 `dsh-web-app` 的**常驻插件**，且它的 `queue` 生命周期是**插件生命周期**，
不是每连接一个。于是 `queue.push` 永远返回 true ⇒ 后面的 listener（含默认 fallback）永远轮不到。
新客户端连上时会补投历史 pending（所以打开浏览器就能看到之前的请求）。

**这意味着**：
- 用户"桌面不打开 DSH 也能批准权限"的需求，补的是一个**真实存在的洞**，不是自造需求；
- 但同时说明：**只要有一个客户端应答，waterfall 就结束** —— 我们的桌面批准器是以
  「另一个 remote event client」的身份接入，和浏览器是并列关系，谁先答谁生效。
- 接入方式不是自己写瀑布，而是**订阅 `$events` 流 + `POST /api/$events/result`**（与浏览器完全同构）。

---

## 4. 给各阶段的结论

| 阶段 | 能力 | 可行性 | 实现路径 |
|---|---|---|---|
| D | 自动发 NEXT | ✅ 可行 | `POST /api/session/prompt`，自铸 cookie；**必须加次数上限 + 一键停**（纯烧 token） |
| B | 外部批准权限 | ✅ 可行 | 连 WS `/api/remote.mux` 的 `$events` 流，收到 `approval/request` 后 `POST /api/$events/result` |
| B | 外部回答 ask_user_question | ✅ 可行 | 同上，走 `user-questions/request` 瀑布 |
| D | 历史增量同步 | ✅ 可行，有现成接口 | 首选 WS `session/follow` 长流（首帧 snapshot + 逐条增量）；一次性全量用 `GET /api/session.export`（返回**解压好的**规范 JSONL，正好绕开下面那个 zstd 坑） |

### 安全底线（不变）

- 权限一律**桌面点一下**才放行，不做静默自动同意；
- `$events/result` 的 `outcome` 只允许 `allowed-once` / `rejected`，**绝不发 `allowed-always`**；
- 所有外部写入都要有审计日志，且能一键停。

---

## 5. 补充调研（第 2/2 部分）：自写 provider、等待检测、历史同步

### 5.1 【重要纠正】zstd：Node 内置只能解第一帧

会话文件是**独立 zstd 帧的拼接**（第一帧只有 header，之后每批一帧）。
Node 24 的 `zlib.zstdDecompressSync` / `createZstdDecompress` **只解第一帧**（实测只解出 227 字节的 header）。
所以"直接读会话文件"实际要做的是：按 magic `28 B5 2F FD` 扫描 → 逐帧解压 → 拼接。
另外写侧是 append + fsync，**外部读取会遇到 torn tail**（不完整的最后一行/最后一帧），必须容忍。

→ **结论：别自己解压。** 用 `session/follow`（宿主已在内存里）或 `session.export`（官方导出解压好的 JSONL）。

### 5.2 权限与提问：能不能自写 provider —— 能，但必须 `prepend`

`ctx.userQuestions` 是标准 Cordis service，底层是 Agent 作用域的 **waterfall** `user-questions/request`。
任何插件 `ctx.on('user-questions/request', handler, true)` 就能接管；`approval/request` 同理。

**坑（核心）**：`dsh-api-remotes` 一旦挂载就会**永久**接管这两个 waterfall（它的 queue 是插件生命周期，
`queue.push` 恒为 true ⇒ 后面的 listener 永远轮不到）。而**用户 patch 层只能追加到 entry 列表末尾，
没有 before/after**（`dsh-app-boot`），所以**靠加载顺序抢不过来**。

**唯一解法**：Cordis 的 prepend —— `ctx.on(name, listener, true)`
（内部 `unshift` 到最前，waterfall 按列表顺序执行）。
建议配合 `{ prepend: true, global: true }` 以确保收到所有 agent 的事件。

设计上用一个「桌面伴随进程是否在线」的标志决定 **claim** 还是 `return next()` 让给 GUI ——
两边都能答，谁先答谁生效，不会互相抢死。

### 5.3 怎么知道「模型正在等用户输入」

**没有专门的事件，也没有这种 projection。** 只能组合推断：

| 信号 | 含义 | 来源 |
|---|---|---|
| `approval/request` 到达 | 正好在等权限决定 | waterfall（进程内，最准） |
| `user-questions/request` 到达 | 正好在等人答问题 | waterfall（进程内，最准） |
| `agent/status` idle ⇄ running | 是否在跑 | 进程内 |
| `agent/turn-stopping` | 回合准备关闭前（"再塞一句"的抓手，auto-continue 用它） | 进程内 |
| `approval/asked` 无配对 `approval/decided` | 正在等权限（外部进程只能用这个） | 日志折叠 |
| `tool/call`(ask_user_question) 无配对 `tool/result` | 正在等回答 | 日志折叠 |

现有 projection 只有 `permissions` / `inbox` / `turnBoundary` / `modelSelection` / `sessionListMetadata` / `imageLimits`
—— 没有"等待态"。但 `SessionProjectionRegistry.register()` 允许插件**自己造一个**。

### 5.4 历史同步的四条路（按推荐度）

1. **WS `/api/remote.mux` → `session/follow`**（首选）
   首帧 `{type:'snapshot', header, cursor, records, projections, hasMore}`，之后逐条 `{type:'event', event}`。
   断线用 `session/page`（带 `throughSeq`）补齐。
2. **`GET /api/session.export?sessionId=…&includeDescendants=true`** → ZIP
   里面是**解压好的规范 JSONL** + 附件 —— 一次性全量、绕开 zstd 多帧与 v0/v1 迁移，最省事。
3. **宿主插件内**：`ctx.on('session/event', …)` 实时 + `ctx.sessionQuery.readSession/listEvents` 冷读。
4. 纯文件系统读 `.zstd`：不推荐（见 5.1）。

### 5.5 落地路线（后面几个阶段照这个走）

宿主半做三件事：

1. `ctx.webServer.register` 一条**不经过 `/api` 鉴权**的回环路由，当作与桌面伴随进程的桥；
   路由里直接 `ctx.agents.get(sessionId).followup(createUserMessage(...))`。
   —— 这条同时解决「等价于用户回车」和「外部进程过不了 cookie」两个问题。
2. 用 **`prepend: true`** 注册 `approval/request` 与 `user-questions/request` 的答案器
   （伴随进程在线时 claim，否则 `next()` 让给 GUI）。
3. 用 `ctx.on('session/event')` / `agent/status` / `agent/turn-stopping` 驱动
   「定时截屏 → `agent.followup(...)`」与「自动 NEXT」。

**注意**：`plan-review` 类提问的 `approve` label 必须真的是它的 option 之一，否则 `BAD_INTENT` ——
自写弹窗若调换选项顺序，判定会跟着错。
子代理里的提问拿不到人工答复是设计使然（`CALLER_NOT_LIVE` / `DELEGATED_CALLER`），不是 bug。
