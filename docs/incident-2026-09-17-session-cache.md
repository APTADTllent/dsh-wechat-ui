# 事故记录：会话历史消失（2026-09-17）

> ⚠️ **重要更正（2026-09-18）**：本文件下面的"根因"判断**是错的**。
> 后来用隔离环境 + DSH 自己的 API 查清了真相，见文末「更正」一节。
> 保留错误版本是因为**排查过程本身**有价值 —— 它记下了两条我踩过的坑。

> 记录一次真实发生、已修复的事故。目的是下次再遇到时**五分钟内解决**，
> 而不是像这次一样排查两小时。

## 症状

- DSH 侧边栏里**以前的对话全部消失**，只剩当前这一个
- 无法打开/切换到历史会话
- **没有数据丢失**（事后核实）

## 数据安全结论（先让人安心的部分）

事故期间核实过，全部完好：

| 项 | 状态 |
|---|---|
| 会话文件 `~/.dsh/sessions/**` | **41 份全在**，逐份体检 `成功 41 / 失败 0` |
| 会话列表 `~/.dsh/storages/workspace.json` | 完好，当前工作区 `新建文件夹 (4)` 下有 **10 个会话** |
| 列表引用的会话 vs 磁盘实际文件 | 差异 **0** |
| 缓存备份 `session_projcache.json.bak-*` | JSON 完好，95KB，含 30 条记录 |

**结论：没有任何用户数据受损。丢的是「列表的支撑数据」。**

## 根因

`~/.dsh/storages/session_projcache.json`（会话投影缓存）在 **21:28:28** 被改名成
`session_projcache.json.bak-20260917-212828`，之后 **DSH 没有重建它**，
于是会话列表失去了支撑数据。

相关事实（从 DSH 源码读到）：

```js
// dsh-session-projection-cache/lib/index.js
const projectionCacheDomainSpec = defineDomain({
  name: "session_projcache",
  version: 7,
  compatibleVersions: [3, 4, 5, 6],      // 本机那份是 version 3 —— 在兼容范围内
  invalidRecords: "backup-and-skip",
  layout: "per-record",
});
```

> The cache is a **fold shortcut, never an authority** … serves the session as uncached
> (a **cold read rebuilds and rewrites it**).

**即：缓存只是加速用的，理论上丢了也能从会话文件重建。** 但这次重建没有发生。

## 未解之处（老实记下来）

1. **那个 `.bak-<时间戳>`（横线）不是这个域层写的。** 域层文档里写的是
   `<key>.json.bak.<stamp>`（点）。命名不符，说明出自另一条代码路径 —— 最终没定位到。
2. **为什么没有冷读重建。** 按设计它应该发生。
3. **是否与当时正在装插件有关。** 时间上重合（21:28 前后在反复 install 插件，
   会触发 DSH 的 HMR 重载），但缓存版本 v3 明明在兼容列表里，按逻辑不该被备份。
   **无法证实也无法排除。**

## 修复（已验证有效）

```powershell
# 一条命令
node "C:\Users\Lenovo\Desktop\新建文件夹 (4)\plugin\fix-session-cache.mjs"

# 然后重启 DSH
```

脚本做的事：把最新的 `session_projcache.json.bak-*` **复制**回
`session_projcache.json`，**不删任何东西**。`--dry` 可以只看不动手。

手工等价操作：

```powershell
$s = "$env:USERPROFILE\.dsh\storages"
Copy-Item "$s\session_projcache.json.bak-20260917-212828" "$s\session_projcache.json" -Force
```

**实测结果：复制回去 + 重启 DSH，历史会话全部恢复。**

## 预防

1. **不要删 `.bak-*` 文件** —— 它是恢复的唯一钥匙。
2. 缓存文件一旦"消失"，先跑 `fix-session-cache.mjs`，别急着重装或清数据。
3. 动插件（install / 重启）之后，若发现侧边栏历史空了，
   **第一件事就是看 `~/.dsh/storages/` 有没有多出 `session_projcache.json.bak-*`**。
4. 排查这类问题时**用 Node 读 JSON，不要用 PowerShell**：
   `Get-Content -Raw | ConvertFrom-Json` 会按系统 ANSI 代码页解码 UTF-8，
   中文路径被破坏后连 JSON 都解析不了，会误判成"文件损坏"
   （本次就差点误判）。

## 时间线

| 时间 | 事件 |
|---|---|
| 21:28:28 | `session_projcache.json` 被改名为 `.bak-20260917-212828` |
| 21:37:18 | DSH 启动（插件 v0.3.3 生效） |
| 21:37:27 | `workspace.json` 更新 |
| — | 用户报告历史会话消失 |
| — | 核实：41 份会话文件 0 失败；`.bak` JSON 完好 |
| — | 恢复 `.bak` → `session_projcache.json` |
| — | 重启 DSH → **历史恢复** |

---

# 更正（2026-09-18）：上面的根因判断是错的

第二天问题复现，于是搭了隔离环境重新查。结论如下。

## 真相

**`session_projcache.json` 是「旧布局」的遗留物，DSH 现在根本不用它。**

从 DSH 源码读到：

```js
const projectionCacheDomainSpec = defineDomain({
  name: "session_projcache",
  version: 7,
  compatibleVersions: [3, 4, 5, 6],
  layout: "per-record",       // ← 关键
  ...
});
// "the shipped json backend stores one document per session under its root"
```

- **旧布局**：一个总表 `storages/session_projcache.json`（`unit.version: 3`，条目形如 `{identity, rows}`）
- **现布局**：`storages/session_projcache/sessions/<sessionId>.json`，每个形如
  `{"version":7,"record":{"identity":{...},"rows":{title, sessionListMetadata, ...}}}`

**所以那个总表被移走之后不会重建 —— 因为已经不需要它了。它的缺失不是故障原因。**

## 实际数据状态（复核）

| 项 | 实测 |
|---|---|
| 会话文件 | 39 个 |
| per-record 缓存 | **39 个，全部 `version: 7`** |
| 缓存里的投影 | 13~23 个/会话，含 `title`、`sessionListMetadata`、`sessionStats` 等 |
| `workspace.json` | 完好，4 个工作区共 16 个会话 ID + 5 个归档 |

**全部完好。**

## 决定性的排查手段（这才是本文件最有价值的部分）

搭一个隔离实例，用 DSH 自己的 API 直接问它：

```powershell
# 1. 复制数据到隔离目录
robocopy "$env:USERPROFILE\.dsh\sessions" "D:\dsh-lab\dotdsh\sessions" /E
Copy-Item "$env:USERPROFILE\.dsh\storages" "D:\dsh-lab\dotdsh\storages" -Recurse
New-Item -ItemType Junction -Path "D:\dsh-lab\dotdsh\profiles" -Target "$env:USERPROFILE\.dsh\profiles"

# 2. 起隔离实例（注意：用 .cmd，.ps1 会被执行策略拦）
$env:DSH_HOME = "D:\dsh-lab\dotdsh"
& "$env:APPDATA\npm\dsh.cmd" web --port 3081 --no-open

# 3. 用 token 换 cookie，直接查 API
node probe-dsh-api.mjs 3081 "<日志里的 token>"
```

结果：**39 个会话全部返回，每个都带完整投影**（标题、`sessionStats`、`turnOutline`…）。
→ 一次性证明「数据是好的、DSH 逻辑也是好的」，问题不在后端。

**没有这个隔离环境，就会一直不敢动真身、也分不清是数据坏了还是实例状态坏了。**

## 三条教训

1. **不要用 PowerShell 读 JSON。**
   `Get-Content -Raw | ConvertFrom-Json` 会按系统 ANSI 代码页解码 UTF-8，
   中文路径被破坏后连 JSON 都解析不了（本次差点误判成"文件损坏"）；
   而且它把嵌套对象打成 `@{asOfSeq=1753; values=}` 这种字符串，
   **害我把"有内容"读成了"空空如也"**，白查了一轮。**用 Node 读。**

2. **"恢复备份"之前，先确认那个文件现在还用不用。**
   我两次把旧布局的总表当救命稻草复制回去 —— 都是无用功，
   而且用旧格式文件去干扰新逻辑，方向完全错了。

3. **别在真身上试。** 隔离环境（`DSH_HOME` + 另一个端口）成本极低，
   却能安全地反复实验、自由对比。这次正是它定位了问题。

## 留下的工具

| 脚本 | 用途 |
|---|---|
| `probe-dsh-api.mjs` | 用 token 换 cookie，直接问 DSH 的 API，看**原始 JSON** |
| `diagnose-session-index.mjs` | 磁盘会话 vs 缓存索引 的差异对比 |
| `analyze-projc-rows.mjs` | 统计 per-record 缓存里存了哪些投影、版本是多少 |
| `fix-session-cache.mjs` | 恢复旧总表的备份（**注意：多数情况下用不上**） |
| `D:\dsh-lab\dotdsh` | 隔离实验环境（数据副本，可随时重建） |
