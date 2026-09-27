/**
 * dsh-wechat-ui —— 宿主半 v0.3.3
 *
 * 四件事：
 *   1) 给浏览器半供图（头像 + 表情包）：只读、防目录穿越。
 *   2) 【桌面确认】拦截权限请求与提问，弹原生窗口，不经过浏览器。
 *   3) 诊断 / 自检 / 开关 / 错误上报路由。
 *   4) 【v0.3.3 新增】浏览器在线检测：你在用 DSH 时不弹窗，只有你离开了才弹。
 *
 * 为什么能抢到（关键）：
 *   `dsh-api-remotes` 一旦挂载就永久接管 `approval/request` 与 `user-questions/request`
 *   这两个 waterfall（队列是插件生命周期，push 恒为 true，后面的 listener 永远轮不到）。
 *   而用户 patch 层只能把插件追加到列表末尾，**没有 before/after**。
 *   所以必须同时用两个选项：
 *     · prepend: true —— unshift 到最前
 *     · global:  true —— 跳过 context filter，否则收不到 agent 作用域的事件
 *
 * 让位而不是独占：桌面窗口超时/关掉 → `next()` 交回浏览器。
 *
 * 安全：
 *   · 结果只接受白名单取值，非法值一律交回浏览器。
 *   · 不做静默自动同意 —— 桌面端也必须真的点一下。
 *   · 所有异常都捕获后 `next()`，绝不让异常冒泡影响宿主。
 */

import { readFile, writeFile, mkdtemp, rm, readdir, stat } from 'node:fs/promises'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, extname, basename, resolve, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { defineTool } from '@deepseek-ai/dsh-tools'

const VERSION = '0.8.6'

const name = 'wechat-ui'
const inject = ['webServer', 'agents', 'tools', 'attachments', 'llm']

const HERE = dirname(fileURLToPath(import.meta.url))
const TAGS_FILE = join(HERE, '..', 'assets', 'stickers.json')
const CONFIG_FILE = join(HERE, '..', 'assets', 'desktop.json')
const DIALOG_SCRIPT = join(HERE, '..', 'scripts', 'desktop-approval.ps1')
const SHOT_SCRIPT = join(HERE, '..', 'scripts', 'screenshot.ps1')
const TOAST_SCRIPT = join(HERE, '..', 'scripts', 'desktop-toast.ps1')

/* 桌面通知：把每条回答按段弹到屏幕顶部（微信风格小卡片）
   threshold 是"要不要截断"的分界；超过就用 前 head 字 + … + 后 tail 字 */
const TOAST = {
  enabled: process.env.DSH_WECHAT_TOAST !== '0',
  threshold: 20,
  head: 11,
  tail: 8,
  duration: 6,
  maxPerMessage: 3,
}

/* ==================== 定位「这个实例自己的」运行目录 ====================
   为什么不能用 USERPROFILE：一台机器上可能同时跑着多个 DSH 实例
   （例如 3080 用 C:\Users\X\.dsh，3081 用 D:\dsh-lab\dotdsh）。
   用 USERPROFILE 拼出来的永远是同一个目录，于是两个实例互相覆盖 state.json、
   抢同一个截图目录 —— 表现成「设置自己变了」。

   优先级（和 DSH 自己的 @deepseek-ai/dsh-home-paths 保持一致）：
     1) DSH_WECHAT_HOME —— 本插件专用，强制指定（做隔离/测试时用）
     2) DSH_HOME        —— DSH 自己的约定，纯空白视为未设置
     3) ~/.dsh          —— 默认
   解析结果会写进诊断路由，方便核对到底用了哪一份。 */
function expandHomeArg(p) {
  const s = String(p ?? '').trim()
  if (!s) return ''
  if (s === '~') return homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) return join(homedir(), s.slice(2))
  return resolve(s)
}

function resolveRuntimeDir() {
  const forced = expandHomeArg(process.env.DSH_WECHAT_HOME)
  if (forced) return forced
  const fromEnv = expandHomeArg(process.env.DSH_HOME)
  if (fromEnv) return join(fromEnv, 'wechat-ui')
  return join(homedir(), '.dsh', 'wechat-ui')
}

const RUNTIME_DIR = resolveRuntimeDir()
/* 旧版本用的是 USERPROFILE 拼出来的共享目录；读设置时兜底读它一次，别让设置白丢。
   ⚠ 设置存档必须和截图一样按实例分开（走 RUNTIME_DIR）。
   原来写成 USERPROFILE/.dsh/... 的后果：3080 和 3081 共用同一份设置 ——
   在实验室里调一下滑块，真实实例的设置也跟着变了。 */
const LEGACY_DIR = join(homedir(), '.dsh', 'wechat-ui')

/* 截图：目录、缩放、保留张数、超时 */
const SHOT_DIR = process.env.DSH_WECHAT_SHOTS
  || join(RUNTIME_DIR, 'shots')
const SHOT_MAX_WIDTH = Number(process.env.DSH_WECHAT_SHOT_WIDTH) || 1280
const SHOT_KEEP = Number(process.env.DSH_WECHAT_SHOT_KEEP) || 10
const SHOT_TIMEOUT_MS = 30_000

const STICKER_DIR = process.env.DSH_WECHAT_STICKERS
  || 'C:\\Users\\Lenovo\\Desktop\\图片&视频\\大肥鱼图片包'

const PREFIX = '/wechat-ui'
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp'])

/** 运行时状态：config 可变，便于用路由直接开关而不用重启 */
const STATE = { config: { approval: true, questions: true, timeoutSec: 30 } }

/** 诊断记录 */
const DIAG = {
  version: VERSION,
  startedAt: Date.now(),
  registered: [],
  events: [],
  dialogs: [],
  reports: [],
  services: {},
  browser: null,
  note: '',
}

function diagPush(list, item) {
  list.push(Object.assign({ at: Date.now() }, item))
  while (list.length > 30) list.shift()
}

function loadDesktopConfig() {
  const fallback = { approval: true, questions: true, timeoutSec: 30 }
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    return {
      approval: parsed.approval !== false,
      questions: parsed.questions !== false,
      timeoutSec: Math.max(5, Math.min(600, Number(parsed.timeoutSec) || 30)),
    }
  } catch (error) {
    console.error('[wechat-ui] 读 desktop.json 失败，用默认配置：', error?.message ?? error)
    return fallback
  }
}

/* ==================== 设置的持久化 ====================
   写在 DSH 目录下，不写在插件目录里 —— 插件目录每次部署都会被整个替换，
   写在那儿等于每次升级都丢设置。
   ⚠ 自动推进的 enabled 故意【不恢复】：它是唯一会持续花钱的开关，
     重启后一律回到关闭，必须有人手动打开。其余数值都恢复。 */
const STATE_FILE = join(RUNTIME_DIR, 'state.json')
/* 老版本写在共享目录（USERPROFILE/.dsh）里。第一次找不到自己的存档时读它一次，
   这样升级上来的人（比如 3080）不会莫名其妙丢掉之前的设置。 */
const LEGACY_STATE_FILE = join(LEGACY_DIR, 'state.json')

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function loadSavedState() {
  try {
    /* 先读自己的；没有就读老版本放在共享目录里那份（升级上来别丢设置） */
    let raw = null
    try { raw = readFileSync(STATE_FILE, 'utf8') } catch { raw = null }
    if (raw === null) {
      try { raw = readFileSync(LEGACY_STATE_FILE, 'utf8') } catch { raw = null }
    }
    if (raw === null) return false
    const parsed = JSON.parse(raw)
    const a = parsed && parsed.autoNext
    if (a && typeof a === 'object') {
      NEXTSTATE.idlePerHour = clampInt(a.idlePerHour, 0, 50, NEXTSTATE.idlePerHour)
      NEXTSTATE.activePerHour = clampInt(a.activePerHour, 0, 120, NEXTSTATE.activePerHour)
      NEXTSTATE.maxStreak = clampInt(a.maxStreak, 1, 100, NEXTSTATE.maxStreak)
      NEXTSTATE.maxContextTokens = clampInt(a.maxContextTokens, 0, 2_000_000, NEXTSTATE.maxContextTokens)
      NEXTSTATE.enabled = false
      NEXTSTATE.paused = false
      NEXTSTATE.pauseReason = ''
    }
    const w = parsed && parsed.watch
    if (w && typeof w === 'object') {
      WATCHSTATE.intervalSec = clampInt(w.intervalSec, WATCH.minIntervalSec, WATCH.maxIntervalSec, WATCHSTATE.intervalSec)
      WATCHSTATE.enabled = w.enabled === true
      WATCHSTATE.autoLookPerHour = clampInt(w.autoLookPerHour, AUTOLOOK.minPerHour, AUTOLOOK.maxPerHour, WATCHSTATE.autoLookPerHour)
      WATCHSTATE.autoLookMaxStreak = clampInt(w.autoLookMaxStreak, 1, 50, WATCHSTATE.autoLookMaxStreak)
      /* 和自动推进同理：会持续花钱的开关不自动恢复 */
      WATCHSTATE.autoLook = false
      WATCHSTATE.autoLookPaused = false
      WATCHSTATE.autoLookPauseReason = ''
    }
    return true
  } catch {
    return false
  }
}

function saveState() {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({
      autoNext: {
        idlePerHour: NEXTSTATE.idlePerHour,
        activePerHour: NEXTSTATE.activePerHour,
        maxStreak: NEXTSTATE.maxStreak,
        maxContextTokens: NEXTSTATE.maxContextTokens,
        enabled: NEXTSTATE.enabled,
      },
      watch: { intervalSec: WATCHSTATE.intervalSec, enabled: WATCHSTATE.enabled, autoLookPerHour: WATCHSTATE.autoLookPerHour, autoLookMaxStreak: WATCHSTATE.autoLookMaxStreak, autoLook: WATCHSTATE.autoLook },
      savedAt: Date.now(),
    }, null, 2), 'utf8')
    return true
  } catch (error) {
    console.error('[wechat-ui] 保存设置失败（不影响运行）：', error?.message ?? error)
    return false
  }
}

/* ==================== 浏览器在线检测 ==================== */

/* 方案：让浏览器自己报活（心跳），不去猜 DSH 的内部服务名。
   v0.3.3 试过用 ctx.get('apiGateway') 之类探测客户端连接表 —— 实测一个都拿不到，
   那是最不可靠的一条路。心跳完全可控：页面开着就有，关了就没有。 */
const HEARTBEAT = { lastAt: 0, count: 0, ua: '', timeoutMs: 90_000 }

function heartbeatOnline() {
  const ageMs = HEARTBEAT.lastAt === 0 ? -1 : Date.now() - HEARTBEAT.lastAt
  return {
    known: true,
    online: ageMs >= 0 && ageMs < HEARTBEAT.timeoutMs,
    via: 'heartbeat',
    ageMs,
    count: HEARTBEAT.count,
  }
}

const SERVICE_CANDIDATES = [
  'apiGateway', 'api-gateway', 'gateway',
  'apiRemotes', 'api-remotes', 'remoteEvents',
  'clientConnection', 'client-connection',
]
const CLIENT_BAGS = ['remoteEventClients', 'clients', 'connections', 'sockets', 'peers']

/** 探测哪些 gateway/连接类服务能拿到 —— 只作为诊断参考，判断逻辑不依赖它 */
function probeServices(ctx) {
  const found = {}
  for (const serviceName of SERVICE_CANDIDATES) {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined
      if (!service) continue
      const info = { keys: [] }
      try { info.keys = Object.keys(service).slice(0, 25) } catch { /* Proxy */ }
      for (const bag of CLIENT_BAGS) {
        try {
          const value = service[bag]
          if (value && typeof value.size === 'number') info.clients = `${bag}=${value.size}`
        } catch { /* ignore */ }
      }
      found[serviceName] = info
    } catch (error) {
      found[serviceName] = { error: String(error?.message ?? error).slice(0, 100) }
    }
  }
  return found
}

/**
 * 有没有浏览器连着？
 * 以心跳为准；从未收到过心跳就按「不在线」处理（于是会弹桌面窗）。
 * @returns {{known:boolean, online:boolean, via:string, ageMs:number, count:number}}
 */
function browserOnline() {
  return heartbeatOnline()
}

/* ==================== 去重 ==================== */

const RECENT = new Map()
const DEDUP_MS = 10 * 60 * 1000

function freshRequest(key) {
  const now = Date.now()
  for (const [k, t] of RECENT) if (now - t > DEDUP_MS) RECENT.delete(k)
  if (RECENT.has(key)) return false
  RECENT.set(key, now)
  return true
}

/* ==================== 图片通道 ==================== */

function safeResolve(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return null
  const base = basename(raw)
  if (base !== raw) return null
  if (raw.includes('..') || raw.includes('/') || raw.includes('\\') || raw.includes('\0')) return null
  if (!/^[A-Za-z0-9._-]+$/.test(raw)) return null
  if (!ALLOWED_EXT.has(extname(raw).toLowerCase())) return null

  const dir = resolve(STICKER_DIR)
  const full = resolve(join(dir, raw))
  if (full !== join(dir, basename(full))) return null
  if (!full.startsWith(dir + sep)) return null
  return full
}

function queryOf(req, key) {
  try {
    return new URL(req.url, 'http://127.0.0.1').searchParams.get(key)
  } catch {
    return null
  }
}

/** 按 UTF-8 读请求正文（request 流式读取，比 readBody 更明确字节语义） */
async function readTextBody(req) {
  if (req && typeof req[Symbol.asyncIterator] === 'function') {
    const chunks = []
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)))
    return Buffer.concat(chunks).toString('utf8')
  }
  return ''
}

function sendJson(res, status, payload) {  const body = Buffer.from(JSON.stringify(payload, null, 2), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendText(res, status, text) {
  const body = Buffer.from(text, 'utf8')
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length })
  res.end(body)
}

/** 读一点请求体（有上限，防止被灌爆） */
async function readBody(req, limit = 40000) {
  try {
    let text = ''
    for await (const chunk of req) {
      text += chunk
      if (text.length > limit) break
    }
    return text.slice(0, limit)
  } catch {
    return ''
  }
}

function registerRoutes(ctx, webServer) {
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${PREFIX}/stickers`,
    handler: async (req, res) => {
      try {
        const names = await readdir(STICKER_DIR)
        const files = names.filter((n) => ALLOWED_EXT.has(extname(n).toLowerCase())).sort()
        sendJson(res, 200, { dir: STICKER_DIR, count: files.length, files })
      } catch (error) {
        sendJson(res, 500, { error: 'sticker-dir-unreadable', message: String(error?.message ?? error) })
      }
    },
  }), 'wechat-ui: stickers 列表路由')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${PREFIX}/img`,
    handler: async (req, res) => {
      try {
        const full = safeResolve(queryOf(req, 'f'))
        if (full === null) { sendText(res, 404, 'not found'); return }
        const info = await stat(full).catch(() => null)
        if (info === null || !info.isFile()) { sendText(res, 404, 'not found'); return }
        const bytes = await readFile(full)
        res.writeHead(200, {
          'content-type': extname(full).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg',
          'content-length': bytes.length,
          'cache-control': 'public, max-age=86400',
        })
        res.end(bytes)
      } catch {
        sendText(res, 500, 'read failed')
      }
    },
  }), 'wechat-ui: 图片路由')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${PREFIX}/tags`,
    handler: async (req, res) => {
      try {
        const text = await readFile(TAGS_FILE, 'utf8')
        const body = Buffer.from(text, 'utf8')
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': body.length,
          'cache-control': 'no-store',
        })
        res.end(body)
      } catch {
        sendJson(res, 200, { items: [] })
      }
    },
  }), 'wechat-ui: 标签路由')

  /* ---- 客户端渲染错误上报（浏览器控制台我看不到） ---- */
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${PREFIX}/report`,
    handler: async (req, res) => {
      try {
        const text = await readBody(req)
        /* 空 body 一律不记：任何一次不带正文的 GET（探针、预取）都会走到这里，
           记下来就是一条 kind='?' message='' 的垃圾，还会刷一行 [undefined] 日志。 */
        if (!text || !String(text).trim()) { sendJson(res, 200, { ok: true, skipped: 'empty' }); return }
        const data = JSON.parse(text)
        if (!data || typeof data !== 'object' || (data.kind === undefined && data.message === undefined)) {
          sendJson(res, 200, { ok: true, skipped: 'no-fields' })
          return
        }
        diagPush(DIAG.reports, {
          kind: String(data.kind ?? '?'),
          message: String(data.message ?? '').slice(0, 500),
          stack: String(data.stack ?? '').slice(0, 600),
          extra: data.extra ?? null,
        })
        console.error(`[wechat-ui] 客户端上报 [${data.kind}] ${String(data.message ?? '').slice(0, 200)}`)
      } catch { /* 上报失败不影响任何事 */ }
      sendJson(res, 200, { ok: true })
    },
  }), 'wechat-ui: 错误上报路由')

  /* ---- 心跳：浏览器半每隔十几秒报一次活。
         页面一关就断，宿主据此判断"人在不在浏览器前面"。
         这比去猜 DSH 的内部服务名可靠得多（v0.3.3 试过，一个都拿不到）。 ---- */
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${PREFIX}/heartbeat`,
    handler: async (req, res) => {
      /* 只认 POST。GET 也记的话，任何一次 GET（探针、链接预取、别人扫端口）
         都会把"浏览器在线"点亮，进而错误地抑制桌面确认窗 —— 那是很隐蔽的错。
         浏览器半本来就是用 POST 发的，所以这条不影响正常使用。 */
      if (String(req?.method ?? '').toUpperCase() !== 'POST') {
        sendJson(res, 200, { ok: false, reason: 'post-only' })
        return
      }
      HEARTBEAT.lastAt = Date.now()
      HEARTBEAT.count++
      try { HEARTBEAT.ua = String(req.headers['user-agent'] ?? '').slice(0, 100) } catch { /* ignore */ }
      /* 浏览器半把"当前打开的会话"一起报上来 —— 自动推进器只对它动手。
         报空值就清掉，避免用户切到新会话后还往旧会话里发。 */
      try {
        const sid = queryOf(req, 'session')
        NEXTSTATE.sessionId = typeof sid === 'string' ? sid.slice(0, 120) : ''
        HEARTBEAT.active = queryOf(req, 'active') === '1'
      } catch { /* ignore */ }
      sendJson(res, 200, {
        ok: true,
        desktop: STATE.config.approval && STATE.config.questions,
        autoNext: autoNextStatus(),
      })
    },
  }), 'wechat-ui: 心跳路由')

  /* ---- 开关：/wechat-ui/desktop?on=1|0，立即生效，不需要重启 ---- */
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${PREFIX}/desktop`,
    handler: async (req, res) => {
      const on = queryOf(req, 'on')
      if (on === '1' || on === '0') {
        STATE.config.approval = on === '1'
        STATE.config.questions = on === '1'
        console.log(`[wechat-ui] 桌面确认已${on === '1' ? '开启' : '关闭'}`)
      }
      sendJson(res, 200, {
        desktop: STATE.config.approval && STATE.config.questions,
        config: STATE.config,
        browser: browserOnline(),
      })
    },
  }), 'wechat-ui: 桌面开关路由')

  /* ---- 自动推进器开关与调参：/wechat-ui/autonext?on=1&idle=6&active=30&streak=12&resume=1 ----
         宿主半是唯一权威：浏览器半边只负责报告"我在哪个会话"，
         发不发、发多快全部由这里判定，所以调参也放在这里。 ---- */
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${PREFIX}/autonext`,
    handler: async (req, res) => {
      /* 注意：URLSearchParams.get() 在参数不存在时返回 null（不是 undefined），
         而 Number(null) === 0 —— 只判 undefined 的话，一次不带参数的 GET
         就会把频率悄悄改成 0，表现成"明明开了却永远不发"。这里必须一起挡住。 */
      const num = (name, min, max) => {
        const raw = queryOf(req, name)
        if (raw === undefined || raw === null || String(raw).trim() === '') return null
        const n = Number(raw)
        if (!Number.isFinite(n)) return null
        return Math.max(min, Math.min(max, Math.round(n)))
      }
      const on = queryOf(req, 'on')
      if (on === '1' || on === '0') {
        NEXTSTATE.enabled = on === '1'
        if (on === '1') { NEXTSTATE.paused = false; NEXTSTATE.pauseReason = '' }
        console.log(`[wechat-ui] 自动推进已${on === '1' ? '开启' : '关闭'}`)
      }
      if (queryOf(req, 'resume') === '1') {
        NEXTSTATE.paused = false
        NEXTSTATE.pauseReason = ''
        NEXTSTATE.streak = 0
        console.log('[wechat-ui] 自动推进已恢复')
      }
      const idle = num('idle', 0, 50)
      if (idle !== null) NEXTSTATE.idlePerHour = idle
      const active = num('active', 0, 120)
      if (active !== null) NEXTSTATE.activePerHour = active
      const streak = num('streak', 1, 100)
      if (streak !== null) NEXTSTATE.maxStreak = streak
      const maxctx = num('maxctx', 0, 2_000_000)
      if (maxctx !== null) NEXTSTATE.maxContextTokens = maxctx
      /* 只有真的带了参数才写盘 —— 浏览器半每 5 秒拉一次状态，别每次都写文件 */
      if (['on', 'resume', 'idle', 'active', 'streak', 'maxctx'].some((k) => queryOf(req, k) != null)) saveState()
      sendJson(res, 200, { autoNext: autoNextStatus(), browser: browserOnline() })
    },
  }), 'wechat-ui: 自动推进开关路由')

  /* ---- 定时截屏：/wechat-ui/watch?on=1&sec=60&now=1 ----
         只截图存本地，不调用模型，所以不花钱。now=1 是立刻截一张（设置面板预览/自检用）。 ---- */
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${PREFIX}/watch`,
    handler: async (req, res) => {
      const on = queryOf(req, 'on')
      if (on === '1' || on === '0') {
        WATCHSTATE.enabled = on === '1'
        if (on === '1') { WATCHSTATE.lastAt = 0; WATCHSTATE.errorStreak = 0; WATCHSTATE.lastError = '' }
        console.log(`[wechat-ui] 定时截屏已${on === '1' ? '开启' : '关闭'}`)
      }
      const raw = queryOf(req, 'sec')
      if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
        const n = Number(raw)
        if (Number.isFinite(n)) {
          WATCHSTATE.intervalSec = Math.max(WATCH.minIntervalSec, Math.min(WATCH.maxIntervalSec, Math.round(n)))
        }
      }
      if (queryOf(req, 'now') === '1') {
        WATCHSTATE.busy = true
        try {
          const info = await captureWatchShot()
          WATCHSTATE.lastPath = String(info?.path ?? '')
          WATCHSTATE.lastAt = Date.now()
          WATCHSTATE.lastMs = Number(info?.ms) || 0
          WATCHSTATE.shots++
          WATCHSTATE.lastError = ''
          WATCHSTATE.errorStreak = 0
        } catch (error) {
          WATCHSTATE.lastError = String(error?.message ?? error).slice(0, 200)
        } finally {
          WATCHSTATE.busy = false
        }
      }
      /* 路由各自作用域独立：autonext 里的 num 在这条路由里看不到，必须自己定义一份。
         同样要挡住 null/空串 —— Number(null) === 0 会把设置悄悄清零。 */
      const num = (name, min, max) => {
        const raw = queryOf(req, name)
        if (raw === undefined || raw === null || String(raw).trim() === '') return null
        const n = Number(raw)
        if (!Number.isFinite(n)) return null
        return Math.max(min, Math.min(max, Math.round(n)))
      }

      /* ---- 自动让 AI 看的开关与调参 ---- */
      const auto = queryOf(req, 'auto')
      if (auto === '1' || auto === '0') {
        WATCHSTATE.autoLook = auto === '1'
        if (auto === '1') { WATCHSTATE.autoLookPaused = false; WATCHSTATE.autoLookPauseReason = ''; WATCHSTATE.autoLookStreak = 0 }
        console.log(`[wechat-ui] 自动看屏幕已${auto === '1' ? '开启' : '关闭'}`)
      }
      if (queryOf(req, 'resume') === '1') {
        WATCHSTATE.autoLookPaused = false
        WATCHSTATE.autoLookPauseReason = ''
        WATCHSTATE.autoLookStreak = 0
      }
      const perhour = num('perhour', AUTOLOOK.minPerHour, AUTOLOOK.maxPerHour)
      if (perhour !== null) WATCHSTATE.autoLookPerHour = perhour
      const lookStreak = num('lookstreak', 1, 50)
      if (lookStreak !== null) WATCHSTATE.autoLookMaxStreak = lookStreak

      if (['on', 'sec', 'auto', 'perhour', 'lookstreak', 'resume'].some((k) => queryOf(req, k) != null)) saveState()
      sendJson(res, 200, { watch: watchStatus(), browser: browserOnline() })
    },
  }), 'wechat-ui: 定时截屏开关路由')

  /* ---- 让 AI 看现在的屏幕：/wechat-ui/look?q=...（这一步花钱） ---- */
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${PREFIX}/look`,
    handler: async (req, res) => {
      try {
        const result = await lookAtScreen(ctx, queryOf(req, 'q') || '')
        sendJson(res, 200, Object.assign({ watch: watchStatus() }, result))
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error).slice(0, 200) })
      }
    },
  }), 'wechat-ui: 让 AI 看屏幕路由')

  /* ---- 最新一张定时截图（设置面板里预览用，只读本地文件） ---- */
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${PREFIX}/latest`,
    handler: async (req, res) => {
      try {
        if (!WATCHSTATE.lastPath) { res.writeHead(404); res.end('no shot yet'); return }
        const buf = await readFile(WATCHSTATE.lastPath)
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': buf.length,
          'cache-control': 'no-store',
        })
        res.end(buf)
      } catch {
        try { res.writeHead(404); res.end('not found') } catch { /* ignore */ }
      }
    },
  }), 'wechat-ui: 最新截图路由')

  /* ---- 桌面输入：POST /wechat-ui/say（正文就是文字）；也支持 GET ?text= ----
         桌面小窗用它把一句话发进当前会话，回答会由桌面弹窗推回来。 ---- */
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${PREFIX}/say`,
    handler: async (req, res) => {
      try {
        let text = ''
        if (String(req?.method ?? '').toUpperCase() === 'POST') {
          /* 桌面脚本用 form-urlencoded 发（纯 ASCII），这里解回来 —— 中文不会乱 */
          try {
            const body = await readTextBody(req)
            text = new URLSearchParams(body).get('text') || ''
          } catch { text = '' }
        } else {
          text = queryOf(req, 'text') || ''
        }
        const result = await sayToSession(ctx, text)
        sendJson(res, 200, result)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error).slice(0, 200) })
      }
    },
  }), 'wechat-ui: 桌面输入路由')

  /* ---- 版本握手：浏览器半启动时问一句"宿主半是哪个版本" ----
     插件目录是【两个实例共用的】，而 live 重载不会重新加载模块代码，
     很容易出现「宿主半还是旧版、浏览器半刷新后是新版」——前端就会去调不存在的接口。
     宁可明确报出来，也不要白屏。 ---- */
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${PREFIX}/version`,
    handler: async (req, res) => {
      sendJson(res, 200, { version: VERSION, startedAt: DIAG.startedAt })
    },
  }), 'wechat-ui: 版本路由')

  /* ---- 诊断 ---- */
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${PREFIX}/diag`,
    handler: async (req, res) => {
      DIAG.services = probeServices(ctx)
      DIAG.browser = browserOnline()
      DIAG.heartbeat = {
        lastAt: HEARTBEAT.lastAt,
        count: HEARTBEAT.count,
        ageMs: HEARTBEAT.lastAt === 0 ? -1 : Date.now() - HEARTBEAT.lastAt,
        timeoutMs: HEARTBEAT.timeoutMs,
        ua: HEARTBEAT.ua,
      }
      sendJson(res, 200, Object.assign({}, DIAG, {
        config: STATE.config,
        autoNext: autoNextStatus(),
        autoNextProbe: await autoNextProbe(ctx),
        watch: watchStatus(),
        hotkey: hotkeyStatus(),
        dedupKeys: RECENT.size,
        uptimeMs: Date.now() - DIAG.startedAt,
        now: Date.now(),
      }))
    },
  }), 'wechat-ui: 诊断路由')

  /* ---- 自检：直接拉起一次弹窗，不走提问机制 ---- */
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${PREFIX}/selftest`,
    handler: async (req, res) => {
      try {
        const out = await askDesktop({
          kind: 'question',
          header: '自检',
          question: '这是 wechat-ui 的桌面通道自检。随便点一个即可。',
          options: ['通道正常', '通道正常，但中文乱码', '没看到窗口'],
          multiSelect: false,
          timeoutSec: 20,
        }, 20)
        sendJson(res, 200, { ok: true, result: out })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'wechat-ui: 自检路由')
}

/* ==================== 桌面确认 ==================== */

function runDialog(args, timeoutMs) {
  return new Promise((resolve) => {
    let child = null
    let settled = false
    let timer = null
    const finish = (code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(code)
    }
    timer = setTimeout(() => {
      try { if (child) child.kill() } catch { }
      finish(-2)
    }, timeoutMs)

    try {
      child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch {
      finish(-1)
      return
    }
    child.on('error', () => finish(-1))
    child.on('exit', (code) => finish(code))
  })
}

async function askDesktop(payload, timeoutSec) {
  const dir = await mkdtemp(join(tmpdir(), 'wx-ask-'))
  const reqPath = join(dir, 'req.json')
  const resPath = join(dir, 'res.txt')
  const diagPath = join(dir, 'diag.log')
  try {
    await writeFile(reqPath, JSON.stringify(payload), 'utf8')
    const code = await runDialog(
      ['-File', DIALOG_SCRIPT, '-RequestPath', reqPath, '-ResultPath', resPath, '-DiagPath', diagPath],
      (timeoutSec + 25) * 1000,
    )
    const out = await readFile(resPath, 'utf8').catch(() => '')
    const windowLog = await readFile(diagPath, 'utf8').catch(() => '')
    const value = String(out || '').trim() || 'browser'
    diagPush(DIAG.dialogs, {
      kind: payload?.kind ?? '?',
      exitCode: code,
      result: value,
      window: String(windowLog).split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(0, 400),
    })
    return value
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => { })
  }
}

let dialogBusy = false

function onWaterfall(ctx, eventName, handler, label) {
  DIAG.registered.push(eventName)
  return ctx.effect(() => {
    try {
      return ctx.on(eventName, handler, { prepend: true, global: true })
    } catch (error) {
      DIAG.note = `${eventName} 用 global 形式失败，已退回 prepend：${error?.message ?? error}`
      console.error('[wechat-ui] ' + DIAG.note)
      return ctx.on(eventName, handler, true)
    }
  }, label)
}

/* ==================== 截图工具 ==================== */

/* 图片值 schema —— 与官方 read_image 同构，render 时靠它构造 attachment 引用 */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
}

function toImageRef(image) {
  return {
    attachmentId: image.attachmentId,
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...(image.name === undefined ? {} : { name: image.name }),
  }
}

/** 跑一次截屏脚本，解析它的 JSON 输出 */
function runScreenshot(outPath, mode, maxKeep, skipIfSame) {
  return new Promise((resolve, reject) => {
    let child = null
    let settled = false
    let timer = null
    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      fn(arg)
    }
    timer = setTimeout(() => {
      try { if (child) child.kill() } catch { }
      finish(reject, new Error(`截屏超时（${SHOT_TIMEOUT_MS} ms）`))
    }, SHOT_TIMEOUT_MS)

    try {
      child = spawn('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SHOT_SCRIPT,
        '-Out', outPath, '-Mode', mode,
        '-MaxWidth', String(SHOT_MAX_WIDTH), '-MaxKeep', String(maxKeep ?? SHOT_KEEP),
        ...(skipIfSame ? ['-SkipIfSame'] : []),
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      finish(reject, error)
      return
    }

    let stdout = ''
    let stderr = ''
    if (child.stdout) child.stdout.on('data', (d) => { stdout += d })
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (error) => finish(reject, error))
    child.on('exit', (code) => {
      if (code !== 0) {
        finish(reject, new Error(`截屏脚本退出码 ${code}${stderr ? '：' + String(stderr).slice(0, 200) : ''}`))
        return
      }
      const last = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop() || ''
      try {
        const parsed = JSON.parse(last)
        if (parsed && parsed.ok === false) { finish(reject, new Error('截屏失败：' + String(parsed.error))); return }
        finish(resolve, parsed)
      } catch {
        finish(reject, new Error('截屏脚本输出无法解析：' + last.slice(0, 200)))
      }
    })
  })
}

function registerScreenshotTool(ctx) {
  ctx.tools.register(defineTool({
    name: 'take_screenshot',
    description: [
      'Capture the current desktop as an image and return it, so you can see what is on the screen.',
      'Use this when the user asks you to look at their screen, or says things like "看屏幕".',
      'The image is attached to the tool result. Requires the current model to accept image input.',
    ].join(' '),
    parameters: {
      mode: {
        type: 'string',
        enum: ['entire', 'primary'],
        description: 'entire = all monitors (default); primary = main monitor only.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
          image: IMAGE_VALUE_SCHEMA,
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `桌面截图已保存到 ${value.path}（${value.width}×${value.height}），图像见下方。` },
        { type: 'image', attachment: toImageRef(value.image) },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      /* 兜底①：先查模型能力。不支持图片就明确报错，绝不让图被静默丢掉。 */
      try {
        const agent = exec && exec.agent
        const agents = ctx.get('agents')
        const llm = ctx.get('llm')
        if (agent && agents && llm && typeof agents.selectionFor === 'function') {
          const selection = agents.selectionFor(agent).current
          const info = await llm.resolveModelInfo(selection.provider, selection.model)
          if (Array.isArray(info && info.inputModalities) && !info.inputModalities.includes('image')) {
            throw new Error(
              `当前模型 "${selection.model}" 不支持图片输入，截图发给你也看不到。` +
              '请在界面底部的模型选择器里切到支持图片的模型（如 DeepSeek-V41-Flash）后重试。',
            )
          }
        }
      } catch (error) {
        if (String((error && error.message) || '').includes('不支持图片输入')) throw error
        /* 探测本身失败不该阻断截屏，记一笔继续 */
        console.error('[wechat-ui] 模型能力探测失败（继续尝试截屏）：', (error && error.message) || error)
      }

      /* 兜底②：截屏本身。失败会抛带原因的错，工具层会包成 isError 结果。 */
      const mode = args && args.mode === 'primary' ? 'primary' : 'entire'
      const outPath = join(SHOT_DIR, `shot-${Date.now()}.png`)
      await runScreenshot(outPath, mode)

      /* 兜底③：读字节 / 归属失败也要给人话 */
      const attachments = ctx.get('attachments')
      if (!attachments) throw new Error('附件服务不可用，无法把截图交给你（DSH 的 attachments 服务没挂载）')

      let bytes = null
      try {
        bytes = await readFile(outPath)
      } catch (error) {
        throw new Error(`截图文件读不出来：${(error && error.message) || error}`)
      }
      if (!bytes || bytes.length === 0) throw new Error('截出来的文件是空的，可能是屏幕锁定或权限问题')

      const ref = await attachments.saveImage({
        data: bytes,
        mediaType: 'image/png',
        name: basename(outPath),
      })

      return {
        path: outPath,
        width: ref.width,
        height: ref.height,
        image: {
          attachmentId: String(ref.attachmentId),
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
        },
      }
    },
  }))
}

/* ==================== 桌面通知 ==================== */

/** 按规则压缩文本：短的原样，长的留头留尾中间省略 */
function toastText(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim()
  if (text.length <= TOAST.threshold) return text
  return text.slice(0, TOAST.head) + '…' + text.slice(-TOAST.tail)
}

/** 弹一个通知，不等待它关闭（不拖住 DSH 的事件循环） */
function showToast(text, slot) {
  if (!text) return
  try {
    /* ⚠ 这里刻意【不用】 detached: true。
       实测对照：桌面确认窗用 { stdio:'ignore', windowsHide:true } 能正常显示
       （它的诊断里 visible=True），而通知窗加上 detached:true 之后，
       进程确实被拉起（探针能看到），但窗口永远不出现在桌面上 —— 用户什么都看不到。
       detached 让子进程脱离当前控制台/进程组，WinForms 窗口就上不了桌面。
       unref() 已经足够让它不拖住事件循环。 */
    const child = spawn('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TOAST_SCRIPT,
      '-Text', text, '-Slot', String(slot), '-Duration', String(TOAST.duration),
    ], { stdio: 'ignore', windowsHide: true })
    /* ⚠ 必须监听 'error'。spawn 失败（找不到 powershell 之类）是【异步】报的，
       try/catch 抓不到；没有监听器时 Node 会把它抛成未捕获异常 —— 那是能直接
       搞崩整个 DSH 进程的。这条不能省。 */
    child.on('error', (error) => {
      const message = String(error?.message ?? error).slice(0, 160)
      diagPush(DIAG.events, { event: 'toast', action: 'spawn-error', message })
      console.error('[wechat-ui] 弹通知失败（spawn）：' + message)
    })
    if (typeof child.unref === 'function') child.unref()
    diagPush(DIAG.events, { event: 'toast', action: 'spawned', slot, chars: String(text).length })
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 160)
    diagPush(DIAG.events, { event: 'toast', action: 'threw', message })
    console.error('[wechat-ui] 弹通知失败：' + message)
  }
}

/** 监听助手消息 → 按空行分段 → 每段一个通知 */
function registerToasts(ctx) {
  if (!TOAST.enabled) {
    console.log('[wechat-ui] 桌面通知已关闭（DSH_WECHAT_TOAST=0）')
    return
  }
  let recent = []
  const nextSlot = () => {
    const now = Date.now()
    recent = recent.filter((t) => now - t < (TOAST.duration + 2) * 1000)
    const slot = recent.length
    recent.push(now)
    return Math.min(slot, 4)
  }

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'assistant/message') return
      /* 记一笔：证明事件真的到达了处理器（排查"通知没弹"时这行最有用） */
      if (DIAG.events.length < 40) {
        diagPush(DIAG.events, { event: 'toast', action: 'assistant-message-seen', step: event.data && event.data.step })
      }
      const content = event.data && event.data.message && event.data.message.content
      if (!Array.isArray(content)) return
      const text = content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
      if (text.trim().length === 0) return

      /* 按空行分段；每段一个通知 */
      const paragraphs = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
      for (const p of paragraphs.slice(0, TOAST.maxPerMessage)) {
        const short = toastText(p)
        if (short) showToast(short, nextSlot())
      }
    } catch (error) {
      /* 通知失败绝不影响对话本身 */
      console.error('[wechat-ui] 桌面通知异常：', (error && error.message) || error)
    }
  }), 'wechat-ui: 桌面通知')

  console.log(`[wechat-ui] 桌面通知已开启：超过 ${TOAST.threshold} 字截为「前 ${TOAST.head}…后 ${TOAST.tail}」，每条最多 ${TOAST.maxPerMessage} 个，停留 ${TOAST.duration}s`)
}

function registerDesktopConfirm(ctx) {
  onWaterfall(ctx, 'approval/request', async (request, next) => {
    if (!STATE.config.approval) return next()

    /* 浏览器开着就直接交给它 —— 不该把正在用 DSH 的人挡住 */
    const browser = browserOnline()
    DIAG.browser = browser
    if (browser.known && browser.online) {
      diagPush(DIAG.events, { event: 'approval', action: 'browser-online-skip', via: browser.via })
      return next()
    }

    const key = `a:${request?.toolName ?? '?'}:${request?.callId ?? ''}:${String(request?.reason ?? '').slice(0, 120)}`
    if (!freshRequest(key)) {
      diagPush(DIAG.events, { event: 'approval', action: 'dedup-skip' })
      return next()
    }
    diagPush(DIAG.events, { event: 'approval', tool: String(request?.toolName ?? '?'), via: browser.via })
    if (dialogBusy) return next()

    dialogBusy = true
    try {
      const out = await askDesktop({
        kind: 'approval',
        toolName: String(request?.toolName ?? '未知工具'),
        reason: String(request?.reason ?? '（没有给出原因）'),
        timeoutSec: STATE.config.timeoutSec,
      }, STATE.config.timeoutSec)

      if (out === 'allowed-once') { console.log('[wechat-ui] 桌面确认：允许一次'); return 'allowed-once' }
      if (out === 'rejected') { console.log('[wechat-ui] 桌面确认：拒绝'); return 'rejected' }
      console.log('[wechat-ui] 桌面未响应（' + out + '），交回浏览器')
      return next()
    } catch (error) {
      console.error('[wechat-ui] 桌面确认异常，交回浏览器：', error?.message ?? error)
      return next()
    } finally {
      dialogBusy = false
    }
  }, 'wechat-ui: 桌面权限确认')

  onWaterfall(ctx, 'user-questions/request', async (request, next) => {
    if (!STATE.config.questions) return next()

    const browser = browserOnline()
    DIAG.browser = browser
    if (browser.known && browser.online) {
      diagPush(DIAG.events, { event: 'questions', action: 'browser-online-skip', via: browser.via })
      return next()
    }

    const key = 'q:' + JSON.stringify(request?.questions ?? null)
    if (!freshRequest(key)) {
      diagPush(DIAG.events, { event: 'questions', action: 'dedup-skip' })
      return next()
    }
    diagPush(DIAG.events, { event: 'questions', count: Array.isArray(request?.questions) ? request.questions.length : -1, via: browser.via })
    if (dialogBusy) return next()

    try {
      const questions = request?.questions
      if (!Array.isArray(questions) || questions.length !== 1) return next()
      const q = questions[0]
      if (q?.multiSelect) return next()
      const options = Array.isArray(q?.options)
        ? q.options.map((o) => String(o?.label ?? '')).filter((s) => s.length > 0)
        : []
      if (options.length < 2 || options.length > 5) return next()

      dialogBusy = true
      let out = 'browser'
      try {
        out = await askDesktop({
          kind: 'question',
          header: q?.header ? String(q.header) : '',
          question: String(q?.question ?? ''),
          options,
          multiSelect: false,
          timeoutSec: STATE.config.timeoutSec,
        }, STATE.config.timeoutSec)
      } finally {
        dialogBusy = false
      }

      if (out === 'browser' || out === 'error' || out === '') {
        console.log('[wechat-ui] 桌面未作答，交回浏览器')
        return next()
      }
      if (options.indexOf(out) < 0) {
        console.error('[wechat-ui] 桌面返回了不在选项里的值，交回浏览器：' + out)
        return next()
      }
      console.log('[wechat-ui] 桌面作答：' + out)
      return { answers: [{ id: String(q?.id ?? 'q'), selected: [out] }] }
    } catch (error) {
      console.error('[wechat-ui] 桌面提问异常，交回浏览器：', error?.message ?? error)
      return next()
    }
  }, 'wechat-ui: 桌面问答')
}

/* ==================== 自动 NEXT（对话推进器） ====================
   用户要的效果：偶尔自动往对话里丢一句 "NEXT"，让对话自己往前走。
   发出去的是普通用户消息，但界面上会被 isNextOnly 隐藏 —— 所以它纯是推进器。

   ⚠ 这是全套插件里【唯一会持续花钱】的功能：每发一条 = 一次完整模型调用。
   因此所有刹车都放在宿主半。就算浏览器半算错了时间，也超不过这里的预算：
     · 总开关默认关闭
     · 浏览器不在线（最近没有心跳）不发 —— 人没在看就不烧钱
     · 会话正在跑（模型还在干活）不发
     · 每小时条数上限（用户可调，0–50 / 0–120）
     · 连续自动推进上限，超了自动暂停并说明原因
     · 每天硬上限
     · 只在当前打开的会话上发，切走就不发
*/
const AUTONEXT = {
  tickMs: 10_000,              /* 多久检查一次（不发也只是一次内存判断） */
  activeWindowMs: 3 * 60_000,  /* 多久之内有对话算"对话中" */
  maxPerDay: 400,
  text: 'NEXT',                /* 发出去的内容 */
  defaultMaxContextTokens: 300_000, /* 上下文超过这个规模就不推进（0 = 不限制） */
}

const NEXTSTATE = {
  enabled: false,
  idlePerHour: 6,
  activePerHour: 30,
  maxStreak: 12,
  maxContextTokens: AUTONEXT.defaultMaxContextTokens,
  lastContextTokens: null,
  ctxBlocked: false,           /* 是否正因为上下文过大被挡（用来只提醒一次，别刷屏） */
  sessionId: '',
  day: '',
  sentToday: 0,
  sentTotal: 0,
  streak: 0,
  paused: false,
  pauseReason: '',
  lastSentAt: 0,
  lastActivityAt: 0,
  lastReason: 'off',
  lastError: '',
  mine: [],                    /* 我们发出的 requestId，用来把"自动"和"真人"分开 */
}

/**
 * 该不该发一条自动 NEXT —— 纯函数，便于离线测试（所有边界都在这里）。
 * @param {object} st NEXTSTATE 快照
 * @param {number} now 当前时间
 * @param {{browserOnline:boolean, hasAgent:boolean, agentRunning:boolean}} info 运行环境
 * @returns {{ok:boolean, reason:string, intervalMs:number, rate:number, active:boolean, waitMs?:number}}
 */
function autoNextDecision(st, now, info) {
  const no = (reason) => ({ ok: false, reason, intervalMs: 0, rate: 0, active: false })
  if (!st || !st.enabled) return no('off')
  if (st.paused) return no('paused')
  if (!info || !info.browserOnline) return no('browser-offline')
  if (!st.sessionId) return no('no-session')
  if (!info.hasAgent) return no('no-agent')
  if (info.agentRunning) return no('session-running')
  if (st.sentToday >= AUTONEXT.maxPerDay) return no('daily-cap')
  if (st.streak >= st.maxStreak) return no('streak-cap')

  const active = st.lastActivityAt > 0 && (now - st.lastActivityAt) < AUTONEXT.activeWindowMs
  const rate = active ? st.activePerHour : st.idlePerHour
  if (!(rate > 0)) return Object.assign(no('rate-zero'), { active })
  const intervalMs = Math.round(3_600_000 / rate)
  const waited = st.lastSentAt > 0 ? now - st.lastSentAt : Number.MAX_SAFE_INTEGER
  if (waited < intervalMs) {
    return { ok: false, reason: 'waiting', intervalMs, rate, active, waitMs: intervalMs - waited }
  }
  return { ok: true, reason: active ? 'active' : 'idle', intervalMs, rate, active }
}

function autoNextStatus() {
  return {
    enabled: NEXTSTATE.enabled,
    paused: NEXTSTATE.paused,
    pauseReason: NEXTSTATE.pauseReason,
    idlePerHour: NEXTSTATE.idlePerHour,
    activePerHour: NEXTSTATE.activePerHour,
    maxStreak: NEXTSTATE.maxStreak,
    maxContextTokens: NEXTSTATE.maxContextTokens,
    lastContextTokens: NEXTSTATE.lastContextTokens,
    sessionId: NEXTSTATE.sessionId,
    sentToday: NEXTSTATE.sentToday,
    sentTotal: NEXTSTATE.sentTotal,
    streak: NEXTSTATE.streak,
    lastReason: NEXTSTATE.lastReason,
    lastError: NEXTSTATE.lastError,
    lastSentAt: NEXTSTATE.lastSentAt,
    lastActivityAt: NEXTSTATE.lastActivityAt,
    active: NEXTSTATE.lastActivityAt > 0 && (Date.now() - NEXTSTATE.lastActivityAt) < AUTONEXT.activeWindowMs,
    maxPerDay: AUTONEXT.maxPerDay,
    text: AUTONEXT.text,
  }
}

/** 真正发一条。失败一律吞掉，绝不影响对话本身 */
async function sendAutoNext(ctx, decision) {
  const sc = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
  if (!sc || typeof sc.prompt !== 'function') {
    NEXTSTATE.lastReason = 'no-service'
    return false
  }
  const now = Date.now()
  const requestId = `wxnext-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  NEXTSTATE.mine.push(requestId)
  while (NEXTSTATE.mine.length > 50) NEXTSTATE.mine.shift()

  /* ⚠ 第二个参数 signal 是必需的：DSH 的实现是
       prompt(request, signal) { signal.throwIfAborted(); ... }
     没有 ?. 保护，不传就 TypeError（而且只在诊断里，界面上表现成"开了没反应"）。
     给一个永不 abort 的 signal 即可。 */
  const controller = new AbortController()
  await sc.prompt({
    requestId,
    sessionId: NEXTSTATE.sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: AUTONEXT.text }],
  }, controller.signal)

  NEXTSTATE.lastSentAt = now
  NEXTSTATE.sentToday++
  NEXTSTATE.sentTotal++
  NEXTSTATE.streak++
  NEXTSTATE.lastReason = 'sent'
  diagPush(DIAG.events, {
    event: 'autonext', action: 'sent', rate: decision.rate,
    active: decision.active, streak: NEXTSTATE.streak,
  })
  console.log(`[wechat-ui] 自动 NEXT 已发送（${decision.active ? '对话中' : '空闲'} ${decision.rate}/小时，连续第 ${NEXTSTATE.streak} 次）`)
  return true
}

/** 定时器：只在【所有】条件都满足时才发 */
function registerAutoNext(ctx) {
  ctx.effect(() => {
    const timer = setInterval(() => {
      void (async () => {
        try {
          const now = Date.now()
          const day = new Date(now).toISOString().slice(0, 10)
          if (NEXTSTATE.day !== day) { NEXTSTATE.day = day; NEXTSTATE.sentToday = 0 }

          const browser = browserOnline()
          let agent = null
          if (NEXTSTATE.sessionId) {
            const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
            if (agents && typeof agents.get === 'function') agent = agents.get(NEXTSTATE.sessionId)
          }
          const decision = autoNextDecision(NEXTSTATE, now, {
            browserOnline: !!(browser && browser.known && browser.online),
            hasAgent: !!agent,
            agentRunning: !!(agent && agent.status === 'running'),
          })
          NEXTSTATE.lastReason = decision.reason

          if (!decision.ok) {
            /* 连续太多次没人接话 → 自动踩刹车，并把原因写清楚 */
            if (decision.reason === 'streak-cap' && !NEXTSTATE.paused) {
              NEXTSTATE.paused = true
              NEXTSTATE.pauseReason = `连续自动推进 ${NEXTSTATE.streak} 次都没有人插话，已自动暂停（防跑飞烧钱）`
              diagPush(DIAG.events, { event: 'autonext', action: 'paused', streak: NEXTSTATE.streak })
              console.log('[wechat-ui] 自动 NEXT 已暂停：' + NEXTSTATE.pauseReason)
              try { showToast(`自动推进已暂停（连续 ${NEXTSTATE.streak} 次没人接话）`, 0) } catch { /* 通知失败无所谓 */ }
            }
            return
          }

          /* 成本刹车：同样"该发"，但会话上下文已经很大时先别发 ——
             推进一条 NEXT 就是一次把整个上下文重新喂进去的调用，
             在几十万 token 的会话上，频率再低也会很贵。 */
          const ctxTokens = await contextTokensOf(ctx)
          NEXTSTATE.lastContextTokens = ctxTokens
          if (NEXTSTATE.maxContextTokens > 0 && ctxTokens !== null && ctxTokens > NEXTSTATE.maxContextTokens) {
            /* 只在"刚被挡住"时提醒一次。之前用 lastReason 判断，而每轮开头都会
               把它重写成 waiting/active，导致每 10 秒刷一行日志刷满整个文件。 */
            if (!NEXTSTATE.ctxBlocked) {
              NEXTSTATE.ctxBlocked = true
              diagPush(DIAG.events, { event: 'autonext', action: 'context-too-big', tokens: ctxTokens, limit: NEXTSTATE.maxContextTokens })
              console.log(`[wechat-ui] 自动推进已跳过：当前会话上下文约 ${ctxTokens} token，超过上限 ${NEXTSTATE.maxContextTokens}（怕烧钱）。可在设置里调高上限。`)
            }
            NEXTSTATE.lastReason = 'context-too-big'
            return
          }
          NEXTSTATE.ctxBlocked = false

          /* 同自动看屏幕：先占住时间戳再发，避免 await 期间下一个 tick 并发再发一条 */
          NEXTSTATE.lastSentAt = now
          await sendAutoNext(ctx, decision)
        } catch (error) {
          const message = String(error?.message ?? error).slice(0, 200)
          NEXTSTATE.lastReason = 'error'
          /* 同一条错误只报一次，避免每 10 秒刷一行。以前这里只写诊断不写日志，
             结果"开关开了却没反应"查起来毫无线索。 */
          if (NEXTSTATE.lastError !== message) {
            NEXTSTATE.lastError = message
            console.error('[wechat-ui] 自动推进发送失败：' + message)
            diagPush(DIAG.events, { event: 'autonext', action: 'error', message })
          }
        }
      })()
    }, AUTONEXT.tickMs)
    return () => clearInterval(timer)
  }, 'wechat-ui: 自动推进定时器')
}

/** 跟踪"是不是有人真的在说话"：真人插话就把连续计数清零 */
function registerAutoNextActivity(ctx) {
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    try {
      if (!event) return
      const sid = session && (session.id ?? session.sessionId)
      if (NEXTSTATE.sessionId && sid && String(sid) !== NEXTSTATE.sessionId) return
      if (event.type === 'user/message') {
        NEXTSTATE.lastActivityAt = Date.now()
        const rpcId = event.data && event.data.source && event.data.source.rpcId
        const isMine = rpcId !== undefined && rpcId !== null && NEXTSTATE.mine.indexOf(String(rpcId)) >= 0
        if (!isMine && NEXTSTATE.streak > 0) {
          diagPush(DIAG.events, { event: 'autonext', action: 'streak-reset', was: NEXTSTATE.streak })
          NEXTSTATE.streak = 0
        }
        /* 真人说话了，自动看屏幕的连续计数也归零 */
        if (!isMine && WATCHSTATE.autoLookStreak > 0) {
          diagPush(DIAG.events, { event: 'watch', action: 'autolook-streak-reset', was: WATCHSTATE.autoLookStreak })
          WATCHSTATE.autoLookStreak = 0
        }
      } else if (event.type === 'assistant/message') {
        NEXTSTATE.lastActivityAt = Date.now()
      }
    } catch { /* 跟踪失败不影响任何事 */ }
  }), 'wechat-ui: 自动推进活动跟踪')
}

/** 读当前会话的上下文规模（用于成本刹车）。
    走 sessionController.list 的投影值，纯本地调用，不产生任何模型开销。
    读不到就返回 null —— 上层据此决定是放行还是保守处理。 */
async function contextTokensOf(ctx) {
  try {
    const sc = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
    if (!sc || typeof sc.list !== 'function' || !NEXTSTATE.sessionId) return null
    const res = await sc.list({})
    const items = res && (res.items || (res.value && res.value.items))
    if (!Array.isArray(items)) return null
    const item = items.find((x) => x && (x.sessionId === NEXTSTATE.sessionId))
    const values = item && item.projections && item.projections.values
    if (!values) return null
    const pressure = values.contextPressure && Number(values.contextPressure.pressureTokens)
    if (Number.isFinite(pressure) && pressure > 0) return pressure
    const usage = values.tokenUsage
    if (usage) {
      const sum = (Number(usage.uncachedInputTokens) || 0) + (Number(usage.cacheReadTokens) || 0) + (Number(usage.cacheWriteTokens) || 0)
      return sum > 0 ? sum : null
    }
    return null
  } catch {
    return null
  }
}

/** 自动推进的"可行性探针"：只读检查，不花一分钱。
    用来回答"开了之后到底有没有能力发出去"这个问题。 */
async function autoNextProbe(ctx) {
  const out = { hasSessionController: false, hasPrompt: false, hasAgent: false, agentStatus: '', sessionId: NEXTSTATE.sessionId, contextTokens: null }
  try {
    const sc = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
    out.hasSessionController = !!sc
    out.hasPrompt = !!(sc && typeof sc.prompt === 'function')
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    const agent = (agents && NEXTSTATE.sessionId && typeof agents.get === 'function')
      ? agents.get(NEXTSTATE.sessionId)
      : null
    out.hasAgent = !!agent
    out.agentStatus = agent ? String(agent.status ?? '') : ''
    out.contextTokens = await contextTokensOf(ctx)
    out.wouldSend = !!(out.hasPrompt && out.hasAgent && out.agentStatus !== 'running'
      && (NEXTSTATE.maxContextTokens <= 0 || out.contextTokens === null || out.contextTokens <= NEXTSTATE.maxContextTokens))
  } catch (error) {
    out.error = String(error?.message ?? error).slice(0, 140)
  }
  return out
}

/* ==================== 定时截屏（屏幕守望） ====================
   用户要的：开启后每隔一段时间自动截一张桌面，然后可以基于截图提问 / 回答。

   这里有两件完全不同的事，故意分开：
     · 定时截屏 —— 只是把图存到本地。不碰模型，不花钱。所以可以放心默认允许开。
     · 让 AI 看  —— 把截图作为图片块发进会话，这一步花钱，所以有独立的频率闸。
   定时截屏只在「浏览器在线」时才跑：人不在，截了也没人看，白耗 CPU。
*/
const WATCH = {
  tickMs: 5_000,              /* 多久检查一次该不该截 */
  minIntervalSec: 10,
  maxIntervalSec: 3600,
  defaultIntervalSec: 60,
  maxKeep: 20,
  lookMinGapMs: 12_000,       /* 两次"让 AI 看"至少隔这么久，防手抖连点 */
  lookMaxPerDay: 200,
  maxConsecutiveErrors: 5,    /* 连续失败这么多次就自动关，避免坏循环 */
}

const WATCHSTATE = {
  enabled: false,
  intervalSec: WATCH.defaultIntervalSec,
  shots: 0,
  skipped: 0,        /* 画面和上一张一样、跳过不存的次数 */
  lastAt: 0,
  lastPath: '',
  lastMs: 0,
  lastError: '',
  errorStreak: 0,
  busy: false,
  lookAt: 0,
  lookDay: '',
  lookToday: 0,
  looks: 0,
  lastLookError: '',
  /* ---- 自动让 AI 看（花钱，默认关，独立刹车） ---- */
  autoLook: false,
  autoLookPerHour: 6,
  autoLookMaxStreak: 6,
  autoLookStreak: 0,
  autoLookAt: 0,
  autoLookToday: 0,
  autoLookDay: '',
  autoLookPaused: false,
  autoLookPauseReason: '',
  autoLookLastError: '',
}

/* 自动让 AI 看：每隔一段时间把屏幕给模型看一眼，让它主动说点什么。
   这是全套里【第二贵】的功能（每看一次 = 一张全屏图 + 整个上下文），
   所以和自动推进一样：默认关、有频率闸、连续上限、每天硬上限、上下文上限。 */
const AUTOLOOK = {
  defaultPerHour: 6,
  minPerHour: 1,
  maxPerHour: 60,
  maxPerDay: 200,
  prompt: '这是我此刻的电脑屏幕。如果上面有值得提醒我的事，用一句话说；没有就只回四个字：一切正常。',
}

const WATCH_DIR = join(SHOT_DIR, 'watch')

function watchStatus() {
  return {
    enabled: WATCHSTATE.enabled,
    intervalSec: WATCHSTATE.intervalSec,
    shots: WATCHSTATE.shots,
    skipped: WATCHSTATE.skipped,
    lastAt: WATCHSTATE.lastAt,
    lastPath: WATCHSTATE.lastPath,
    lastMs: WATCHSTATE.lastMs,
    lastError: WATCHSTATE.lastError,
    looks: WATCHSTATE.looks,
    lookToday: WATCHSTATE.lookToday,
    lookMaxPerDay: WATCH.lookMaxPerDay,
    lastLookError: WATCHSTATE.lastLookError,
    hasShot: !!WATCHSTATE.lastPath,
    minIntervalSec: WATCH.minIntervalSec,
    maxIntervalSec: WATCH.maxIntervalSec,
    /* 自动让 AI 看 */
    autoLook: WATCHSTATE.autoLook,
    autoLookPerHour: WATCHSTATE.autoLookPerHour,
    autoLookMaxStreak: WATCHSTATE.autoLookMaxStreak,
    autoLookStreak: WATCHSTATE.autoLookStreak,
    autoLookToday: WATCHSTATE.autoLookToday,
    autoLookPaused: WATCHSTATE.autoLookPaused,
    autoLookPauseReason: WATCHSTATE.autoLookPauseReason,
    autoLookLastError: WATCHSTATE.autoLookLastError,
    autoLookMaxPerDay: AUTOLOOK.maxPerDay,
    autoLookMinPerHour: AUTOLOOK.minPerHour,
    autoLookMaxPerHour: AUTOLOOK.maxPerHour,
  }
}

/** 截一张存进守望目录（和手动截图分开存，保留策略互不干扰）
    skipIfSame=true 时：画面和上一张完全一样就不落盘（定时截屏专用） */
function captureWatchShot(skipIfSame) {
  return runScreenshot(join(WATCH_DIR, `watch-${Date.now()}.png`), 'entire', WATCH.maxKeep, skipIfSame === true)
}

/** 定时器：只负责截图、以及（如果开了）定期让 AI 看一眼。都不打断对话 */
function registerWatch(ctx) {
  ctx.effect(() => {
    const timer = setInterval(() => {
      void (async () => {
        try {
          const browser = browserOnline()
          const online = !!(browser && browser.known && browser.online)
          if (!online || WATCHSTATE.busy) return
          const now = Date.now()

          /* ---- 定时截屏（不花钱） ---- */
          if (WATCHSTATE.enabled && now - WATCHSTATE.lastAt >= WATCHSTATE.intervalSec * 1000) {
            WATCHSTATE.busy = true
            try {
              /* 画面没变就不落盘：你在看文档不动的时候，没必要每 60 秒存一张一样的图 */
              const info = await captureWatchShot(true)
              WATCHSTATE.lastAt = now
              WATCHSTATE.lastMs = Number(info?.ms) || 0
              if (info && info.skipped) {
                WATCHSTATE.skipped++
              } else {
                WATCHSTATE.shots++
                WATCHSTATE.lastPath = String(info?.path ?? '')
              }
              WATCHSTATE.lastError = ''
              WATCHSTATE.errorStreak = 0
            } catch (error) {
              WATCHSTATE.lastAt = now
              WATCHSTATE.lastError = String(error?.message ?? error).slice(0, 200)
              WATCHSTATE.errorStreak++
              if (WATCHSTATE.errorStreak === 1) {
                console.error('[wechat-ui] 定时截屏失败：' + WATCHSTATE.lastError)
              }
              if (WATCHSTATE.errorStreak >= WATCH.maxConsecutiveErrors) {
                WATCHSTATE.enabled = false
                diagPush(DIAG.events, { event: 'watch', action: 'auto-off', error: WATCHSTATE.lastError })
                console.error(`[wechat-ui] 定时截屏连续失败 ${WATCH.maxConsecutiveErrors} 次，已自动关闭`)
              }
            } finally {
              WATCHSTATE.busy = false
            }
          }

          /* ---- 自动让 AI 看（花钱，每条都是一次全上下文调用） ---- */
          if (!WATCHSTATE.autoLook || WATCHSTATE.autoLookPaused) return
          const day = new Date(now).toISOString().slice(0, 10)
          if (WATCHSTATE.autoLookDay !== day) { WATCHSTATE.autoLookDay = day; WATCHSTATE.autoLookToday = 0 }
          if (WATCHSTATE.autoLookToday >= AUTOLOOK.maxPerDay) return
          if (WATCHSTATE.autoLookStreak >= WATCHSTATE.autoLookMaxStreak) {
            WATCHSTATE.autoLookPaused = true
            WATCHSTATE.autoLookPauseReason = `连续自动看了 ${WATCHSTATE.autoLookStreak} 次都没人接话，已自动暂停（防跑飞烧钱）`
            diagPush(DIAG.events, { event: 'watch', action: 'autolook-paused', streak: WATCHSTATE.autoLookStreak })
            console.log('[wechat-ui] 自动看屏幕已暂停：' + WATCHSTATE.autoLookPauseReason)
            try { showToast('自动看屏幕已暂停（连续几次没人接话）', 0) } catch { /* ignore */ }
            return
          }
          const gap = Math.round(3_600_000 / Math.max(AUTOLOOK.minPerHour, Math.min(AUTOLOOK.maxPerHour, WATCHSTATE.autoLookPerHour)))
          if (WATCHSTATE.autoLookAt > 0 && now - WATCHSTATE.autoLookAt < gap) return

          /* 先把时间戳打上再发。lookAtScreen 里有 await（读会话上下文），
             5 秒的定时器可能在这个窗口里再进来一次，把"正在发"当成"该发了"，
             结果并发发两条。先占位就不会。 */
          WATCHSTATE.autoLookAt = now
          const result = await lookAtScreen(ctx, AUTOLOOK.prompt)
          if (result && result.ok) {
            WATCHSTATE.autoLookToday++
            WATCHSTATE.autoLookStreak++
            WATCHSTATE.autoLookLastError = ''
            diagPush(DIAG.events, { event: 'watch', action: 'autolook', streak: WATCHSTATE.autoLookStreak })
            console.log(`[wechat-ui] 自动看屏幕：已发出（连续第 ${WATCHSTATE.autoLookStreak} 次）`)
          } else if (result && result.reason === 'error') {
            WATCHSTATE.autoLookLastError = String(result.error || 'error').slice(0, 200)
          }
        } catch { /* 定时器里任何异常都不能往外冒 */ }
      })()
    }, WATCH.tickMs)
    return () => clearInterval(timer)
  }, 'wechat-ui: 定时截屏')
}

/**
 * 让 AI 看现在的屏幕：现截一张 → 作为图片块发进当前会话。
 * 这是花钱的一步，所以把能想到的闸都放在这里。
 */
async function lookAtScreen(ctx, question) {
  const fail = (reason, extra) => Object.assign({ ok: false, reason }, extra || {})
  const now = Date.now()
  const day = new Date(now).toISOString().slice(0, 10)
  if (WATCHSTATE.lookDay !== day) { WATCHSTATE.lookDay = day; WATCHSTATE.lookToday = 0 }

  if (WATCHSTATE.busy) return fail('busy')
  if (WATCHSTATE.lookAt > 0 && now - WATCHSTATE.lookAt < WATCH.lookMinGapMs) {
    return fail('too-soon', { waitMs: WATCH.lookMinGapMs - (now - WATCHSTATE.lookAt) })
  }
  if (WATCHSTATE.lookToday >= WATCH.lookMaxPerDay) return fail('daily-cap')

  const sessionId = NEXTSTATE.sessionId
  if (!sessionId) return fail('no-session')
  const sc = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
  if (!sc || typeof sc.prompt !== 'function') return fail('no-service')
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  const agent = (agents && typeof agents.get === 'function') ? agents.get(sessionId) : null
  if (!agent) return fail('no-agent')
  if (agent.status === 'running') return fail('session-running')

  const tokens = await contextTokensOf(ctx)
  NEXTSTATE.lastContextTokens = tokens
  if (NEXTSTATE.maxContextTokens > 0 && tokens !== null && tokens > NEXTSTATE.maxContextTokens) {
    return fail('context-too-big', { tokens, limit: NEXTSTATE.maxContextTokens })
  }

  WATCHSTATE.busy = true
  try {
    const info = await captureWatchShot()
    WATCHSTATE.lastPath = String(info?.path ?? '')
    WATCHSTATE.lastAt = now
    WATCHSTATE.lastMs = Number(info?.ms) || 0
    WATCHSTATE.shots++
    WATCHSTATE.errorStreak = 0

    const bytes = await readFile(WATCHSTATE.lastPath)
    const requestId = `wxlook-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    NEXTSTATE.mine.push(requestId)
    while (NEXTSTATE.mine.length > 50) NEXTSTATE.mine.shift()

    await sc.prompt({
      requestId,
      sessionId,
      mode: 'queue',
      content: [
        { type: 'image', mediaType: 'image/png', data: bytes.toString('base64'), name: 'screen.png' },
        { type: 'text', text: String(question || '').trim() || '这是我此刻的电脑屏幕。' },
      ],
    }, new AbortController().signal)

    WATCHSTATE.lookAt = now
    WATCHSTATE.lookToday++
    WATCHSTATE.looks++
    WATCHSTATE.lastLookError = ''
    diagPush(DIAG.events, { event: 'watch', action: 'look', bytes: bytes.length })
    console.log(`[wechat-ui] 已把屏幕截图发给模型（${Math.round(bytes.length / 1024)} KB）`)
    return { ok: true, path: WATCHSTATE.lastPath, bytes: bytes.length }
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 200)
    WATCHSTATE.lastLookError = message
    diagPush(DIAG.events, { event: 'watch', action: 'look-error', message })
    console.error('[wechat-ui] 让 AI 看屏幕失败：' + message)
    return fail('error', { error: message })
  } finally {
    WATCHSTATE.busy = false
  }
}

/* ==================== 桌面输入（不用打开浏览器） ====================
   从桌面小窗打一句话，直接发进当前会话；回答再由桌面弹窗推回来。
   这样就凑齐了"不用打开 DSH 就能问 DeepSeek"的闭环。
   走的是和浏览器完全一样的 prompt 通道，所以这里也要拦一遍上下文/忙碌等条件。 */
async function sayToSession(ctx, rawText) {
  const fail = (reason, extra) => Object.assign({ ok: false, reason }, extra || {})
  const text = String(rawText || '').trim()
  if (!text) return fail('empty')
  if (text.length > 4000) return fail('too-long', { chars: text.length })

  const sessionId = NEXTSTATE.sessionId
  if (!sessionId) return fail('no-session')
  const sc = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
  if (!sc || typeof sc.prompt !== 'function') return fail('no-service')
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  const agent = (agents && typeof agents.get === 'function') ? agents.get(sessionId) : null
  if (!agent) return fail('no-agent')
  if (agent.status === 'running') return fail('session-running')

  const tokens = await contextTokensOf(ctx)
  NEXTSTATE.lastContextTokens = tokens
  if (NEXTSTATE.maxContextTokens > 0 && tokens !== null && tokens > NEXTSTATE.maxContextTokens) {
    return fail('context-too-big', { tokens, limit: NEXTSTATE.maxContextTokens })
  }

  const requestId = `wxsay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  NEXTSTATE.mine.push(requestId)
  while (NEXTSTATE.mine.length > 50) NEXTSTATE.mine.shift()

  try {
    await sc.prompt({
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, new AbortController().signal)
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 200)
    diagPush(DIAG.events, { event: 'say', action: 'error', message })
    return fail('error', { error: message })
  }

  diagPush(DIAG.events, { event: 'say', action: 'sent', chars: text.length })
  console.log(`[wechat-ui] 桌面输入已发送（${text.length} 字）`)
  return { ok: true, chars: text.length, sessionId }
}

/* ==================== 全局热键 + 框选提问 ====================
   用户在屏幕上看到什么（报错、界面、游戏画面），按一下 Ctrl+Alt+Q 框选一块，
   直接问 AI，回答由桌面弹窗推回来。

   脚本负责"框选 + 存图 + 写一个 json"，插件负责"取走 + 发进会话"。
   这样脚本完全不需要知道 DSH 端口，也不用碰鉴权 —— 只通过一个本地目录交接。 */
const HOTKEY_SCRIPT = join(HERE, '..', 'scripts', 'hotkey-watch.ps1')
const INBOX_DIR = join(SHOT_DIR, 'inbox')
const HOTKEY = {
  enabled: process.env.DSH_WECHAT_HOTKEY !== '0',
  tickMs: 2_000,
  maxAgeMs: 10 * 60 * 1000,   /* 超过 10 分钟的旧图不再发（人早走了） */
  maxWidth: 1280,
}

/* 全局热键整机唯一，两个 DSH 实例同时开的时候后启动的那个必然抢不到。
   2026-09-21 的事故：3080 在 19:03 和 19:07 两次注册失败后【永久失效】——
   代码里没有重试，只在 hotkey.log 留了一行，界面上完全看不出来。
   所以这里补一个退避重试：抢不到就等，等对方（另一个实例）退出后自动接管。 */
const HOTKEY_RETRY = {
  maxTries: 40,        /* 上限，防止"对手永远不退"时无限拉进程 */
  delayMs: 45_000,     /* 45 秒一次 → 大约能守 30 分钟 */
}

/* 纯函数，方便测：退出码 0/null 是正常收摊，不用重试；其余（尤其 2 = 热键被占）才重试。 */
function shouldRetryHotkey(code, tries) {
  if (code === 0 || code === null) return false
  return tries < HOTKEY_RETRY.maxTries
}

const HOTKEYSTATE = {
  enabled: false,
  pid: 0,
  started: 0,
  lastError: '',
  picked: 0,
  sent: 0,
  lastSentAt: 0,
  retryCount: 0,
  nextRetryAt: 0,
}

function hotkeyStatus() {
  return {
    enabled: HOTKEYSTATE.enabled,
    pid: HOTKEYSTATE.pid,
    started: HOTKEYSTATE.started,
    picked: HOTKEYSTATE.picked,
    sent: HOTKEYSTATE.sent,
    lastSentAt: HOTKEYSTATE.lastSentAt,
    lastError: HOTKEYSTATE.lastError,
    keys: 'Ctrl+Alt+Q',
    inbox: INBOX_DIR,
    retryCount: HOTKEYSTATE.retryCount,
    nextRetryAt: HOTKEYSTATE.nextRetryAt,
    maxRetries: HOTKEY_RETRY.maxTries,
    retryDelayMs: HOTKEY_RETRY.delayMs,
  }
}

/** 把框选的那张图 + 问题发进当前会话（和别的通道共用同一套闸） */
async function sendRegionAsk(ctx, imagePath, question) {
  const fail = (reason, extra) => Object.assign({ ok: false, reason }, extra || {})
  const sessionId = NEXTSTATE.sessionId
  if (!sessionId) return fail('no-session')
  const sc = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
  if (!sc || typeof sc.prompt !== 'function') return fail('no-service')
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  const agent = (agents && typeof agents.get === 'function') ? agents.get(sessionId) : null
  if (!agent) return fail('no-agent')
  if (agent.status === 'running') return fail('session-running')

  const tokens = await contextTokensOf(ctx)
  NEXTSTATE.lastContextTokens = tokens
  if (NEXTSTATE.maxContextTokens > 0 && tokens !== null && tokens > NEXTSTATE.maxContextTokens) {
    return fail('context-too-big', { tokens, limit: NEXTSTATE.maxContextTokens })
  }

  let bytes
  try { bytes = await readFile(imagePath) } catch (error) { return fail('read-failed', { error: String(error?.message ?? error).slice(0, 160) }) }

  const requestId = `wxregion-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  NEXTSTATE.mine.push(requestId)
  while (NEXTSTATE.mine.length > 50) NEXTSTATE.mine.shift()

  try {
    await sc.prompt({
      requestId,
      sessionId,
      mode: 'queue',
      content: [
        { type: 'image', mediaType: 'image/png', data: bytes.toString('base64'), name: 'region.png' },
        { type: 'text', text: String(question || '').trim() || '这是我框选的一块屏幕。' },
      ],
    }, new AbortController().signal)
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 200)
    diagPush(DIAG.events, { event: 'region', action: 'error', message })
    return fail('error', { error: message })
  }

  HOTKEYSTATE.sent++
  HOTKEYSTATE.lastSentAt = Date.now()
  diagPush(DIAG.events, { event: 'region', action: 'sent', bytes: bytes.length })
  console.log(`[wechat-ui] 框选提问已发出（${Math.round(bytes.length / 1024)} KB）`)
  return { ok: true, bytes: bytes.length }
}

/** 轮询收件箱：脚本写进来的框选就靠这里取走 */
async function drainInbox(ctx) {
  try {
    let names
    try { names = await readdir(INBOX_DIR) } catch { return }   /* 目录不存在 = 没人用过 */
    const jsons = names.filter((n) => n.endsWith('.json')).sort()
    if (jsons.length === 0) return
    const now = Date.now()

    for (const name of jsons) {
      const jsonPath = join(INBOX_DIR, name)
      let meta = null
      try { meta = JSON.parse(await readFile(jsonPath, 'utf8')) } catch { meta = null }
      const pngName = meta && typeof meta.file === 'string' ? meta.file : name.replace(/\.json$/, '.png')
      const pngPath = join(INBOX_DIR, pngName)
      const stamp = Number(meta && meta.at) || 0

      /* 太旧了就别发了 —— 人早走了，突然冒出一条十年前的截图提问很怪 */
      if (stamp > 0 && now - stamp > HOTKEY.maxAgeMs) {
        console.log('[wechat-ui] 框选图片已过期，丢弃：' + pngName)
        try { await rm(jsonPath, { force: true }) } catch { }
        try { await rm(pngPath, { force: true }) } catch { }
        continue
      }

      HOTKEYSTATE.picked++
      const result = await sendRegionAsk(ctx, pngPath, meta && meta.question)
      if (result.ok) {
        try { await rm(jsonPath, { force: true }) } catch { }
        try { await rm(pngPath, { force: true }) } catch { }
      } else if (result.reason === 'no-session' || result.reason === 'no-agent') {
        /* 浏览器没开 / 会话没加载 —— 留着，等条件满足再发（最多等 maxAgeMs） */
        HOTKEYSTATE.lastError = result.reason
      } else if (result.reason === 'session-running' || result.reason === 'busy') {
        HOTKEYSTATE.lastError = result.reason            /* 稍后重试 */
      } else {
        HOTKEYSTATE.lastError = result.reason + (result.error ? ': ' + result.error : '')
        console.error('[wechat-ui] 框选提问发送失败：' + HOTKEYSTATE.lastError)
        try { await rm(jsonPath, { force: true }) } catch { }
        try { await rm(pngPath, { force: true }) } catch { }
      }
      break   /* 一轮只处理一个，别一次灌爆会话 */
    }
  } catch (error) {
    HOTKEYSTATE.lastError = String(error?.message ?? error).slice(0, 160)
  }
}

function registerRegionInbox(ctx) {
  ctx.effect(() => {
    const timer = setInterval(() => { void drainInbox(ctx) }, HOTKEY.tickMs)
    return () => clearInterval(timer)
  }, 'wechat-ui: 框选收件箱')
}

/** 拉起常驻的热键监听（每个进程一个；全局热键整机唯一，抢不到就退避重试） */
function registerHotkey(ctx) {
  ctx.effect(() => {
    if (!HOTKEY.enabled) {
      console.log('[wechat-ui] 全局热键已关闭（DSH_WECHAT_HOTKEY=0）')
      return () => { }
    }
    let child = null
    let timer = null
    let tries = 0
    let disposed = false
    let announced = false   /* 失败日志只打一次，别每 45 秒刷一行 */

    const launch = () => {
      if (disposed) return
      timer = null
      try {
        mkdirSync(INBOX_DIR, { recursive: true })
        child = spawn('powershell', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HOTKEY_SCRIPT,
          '-ShotsDir', INBOX_DIR,
          '-LogPath', join(RUNTIME_DIR, 'hotkey.log'),
        ], { stdio: 'ignore', windowsHide: true })
        child.on('error', (error) => {
          HOTKEYSTATE.lastError = String(error?.message ?? error).slice(0, 160)
          console.error('[wechat-ui] 热键监听启动失败：' + HOTKEYSTATE.lastError)
        })
        /* 子进程悄悄死掉是最难查的一类问题（之前 stdio:'ignore' 把 Add-Type 的编译错误
           全吞了，表现成"热键没反应、日志也没有"）。退出必须留痕。 */
        child.on('exit', (code) => {
          HOTKEYSTATE.enabled = false
          HOTKEYSTATE.pid = 0
          if (disposed) return
          if (!shouldRetryHotkey(code, tries)) {
            if (code !== 0 && code !== null) {
              HOTKEYSTATE.lastError = `热键监听退出（code=${code}），重试 ${tries} 次仍未成功`
              console.error('[wechat-ui] 热键 ' + `重试 ${tries} 次都没抢到，放弃。` +
                '想恢复：关掉占着它的那个 DSH 实例，或者重启本实例。')
            }
            return
          }
          tries++
          HOTKEYSTATE.retryCount = tries
          HOTKEYSTATE.nextRetryAt = Date.now() + HOTKEY_RETRY.delayMs
          HOTKEYSTATE.lastError = `热键被占用（code=${code}），${Math.round(HOTKEY_RETRY.delayMs / 1000)}s 后重试`
          if (!announced) {
            announced = true
            console.error(`[wechat-ui] 热键监听退出了：code=${code}` +
              '（多半被同机另一个 DSH 实例占了）；' +
              `${Math.round(HOTKEY_RETRY.delayMs / 1000)}s 后开始自动重试，` +
              `最多 ${HOTKEY_RETRY.maxTries} 次`)
          }
          timer = setTimeout(launch, HOTKEY_RETRY.delayMs)
          if (typeof timer.unref === 'function') timer.unref()
        })
        if (typeof child.unref === 'function') child.unref()
        HOTKEYSTATE.enabled = true
        HOTKEYSTATE.pid = child.pid || 0
        HOTKEYSTATE.started = Date.now()
        HOTKEYSTATE.nextRetryAt = 0
        if (tries > 0) {
          HOTKEYSTATE.lastError = ''
          console.log(`[wechat-ui] 热键第 ${tries} 次重试抢到了（Ctrl+Alt+Q 可以用了）`)
        }
      } catch (error) {
        HOTKEYSTATE.lastError = String(error?.message ?? error).slice(0, 160)
        console.error('[wechat-ui] 热键监听未能启动：' + HOTKEYSTATE.lastError)
      }
    }

    launch()
    return () => {
      disposed = true
      if (timer) { try { clearTimeout(timer) } catch { /* ignore */ } }
      HOTKEYSTATE.enabled = false
      HOTKEYSTATE.pid = 0
      HOTKEYSTATE.nextRetryAt = 0
      try { if (child) child.kill() } catch { /* ignore */ }
    }
  }, 'wechat-ui: 全局热键监听')
}

/* ==================== 挂载 ==================== */

function apply(ctx) {
  STATE.config = loadDesktopConfig()
  const restored = loadSavedState()
  console.log(`[wechat-ui] v${VERSION} 设置持久化：${restored ? '已读回上次设置' : '没有存档，用默认值'}（${STATE_FILE}）`)
  DIAG.version = VERSION
  DIAG.note = ''
  DIAG.registered.length = 0
  DIAG.services = probeServices(ctx)

  const webServer = ctx.webServer ?? (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)
  if (webServer && typeof webServer.register === 'function') {
    registerRoutes(ctx, webServer)
    console.log(`[wechat-ui] v${VERSION} 路由已挂载（${STICKER_DIR}）`)
  } else {
    console.error('[wechat-ui] webServer 不可用，图片通道未挂载')
  }

  registerDesktopConfirm(ctx)

  /* 桌面通知：失败也不该拖垮别的功能 */
  try {
    registerToasts(ctx)
  } catch (error) {
    console.error('[wechat-ui] 桌面通知注册失败（其它功能不受影响）：', (error && error.message) || error)
  }

  /* 兜底④：工具注册失败不该拖垮其它功能 */
  try {
    if (typeof ctx.tools?.register === 'function') {
      registerScreenshotTool(ctx)
      console.log(`[wechat-ui] v${VERSION} 截图工具已注册（目录：${SHOT_DIR}，缩到 ${SHOT_MAX_WIDTH}px，保留 ${SHOT_KEEP} 张）`)
    } else {
      console.error('[wechat-ui] tools 服务不可用，截图工具未注册')
    }
  } catch (error) {
    console.error('[wechat-ui] 截图工具注册失败（其它功能不受影响）：', (error && error.message) || error)
  }
  const browser = browserOnline()
  console.log(`[wechat-ui] v${VERSION} 桌面确认：权限=${STATE.config.approval ? '开' : '关'} 提问=${STATE.config.questions ? '开' : '关'} 超时=${STATE.config.timeoutSec}s 浏览器检测=心跳（还没收到过）`)

  registerAutoNextActivity(ctx)
  registerAutoNext(ctx)
  registerWatch(ctx)
  console.log(`[wechat-ui] v${VERSION} 自动推进：${NEXTSTATE.enabled ? '开' : '关（默认）'} · 空闲 ${NEXTSTATE.idlePerHour}/小时 · 对话中 ${NEXTSTATE.activePerHour}/小时 · 连续上限 ${NEXTSTATE.maxStreak} · 每天硬上限 ${AUTONEXT.maxPerDay}`)
  console.log(`[wechat-ui] v${VERSION} 定时截屏：${WATCHSTATE.enabled ? '开' : '关（默认）'} · 每 ${WATCHSTATE.intervalSec} 秒一张 · 保留 ${WATCH.maxKeep} 张 · 目录 ${WATCH_DIR}`)
  registerHotkey(ctx)
  registerRegionInbox(ctx)
  console.log(`[wechat-ui] v${VERSION} 框选提问：${HOTKEY.enabled ? '热键 ' + hotkeyStatus().keys + '（按下后框选屏幕提问）' : '已关闭（DSH_WECHAT_HOTKEY=0）'}`)
}

export { apply, inject, name }
/* 给离线测试用的钩子：决策逻辑是纯函数，可以脱离 DSH 直接验边界 */
export const __test = {
  autoNextDecision, autoNextStatus, contextTokensOf, sendAutoNext, NEXTSTATE, AUTONEXT,
  lookAtScreen, watchStatus, WATCHSTATE, WATCH,
  loadSavedState, saveState, STATE_FILE,
  sayToSession,
  sendRegionAsk, drainInbox, hotkeyStatus, HOTKEYSTATE, HOTKEY, INBOX_DIR,
  shouldRetryHotkey, HOTKEY_RETRY,
  VERSION,
}
