/* 由手写维护（无构建步骤）。
 *
 * dsh-wechat-ui · 浏览器半 v0.2.0
 *
 * v0.2 新增：图片头像（可换、可轮换）、表情面板、自动挑表情、设置开关。
 *
 * 设计底线（每一条都是冲着「别把 DSH 搞崩」去的）：
 *   1) 只接管 conversation.chat.node 的 user / assistant-step 两个 key。
 *      其余 13 个 key 不注册 → 自动回落官方渲染器。priority:-1 覆盖官方默认的 0。
 *   2) 真 React class ErrorBoundary：某条消息渲染炸了只降级那一条。
 *   3) 所有 props 都当可能缺失来读；后台接口挂了就退化成纯文本 / 文字头像。
 *   4) 浮动工具栏用 fixed 定位，不侵入 DSH 的布局容器（找不到就静默不显示）。
 *   5) 设置存 localStorage，读失败一律回默认值。
 */
window.__ModuleLoader__.load({
	id: "dsh-wechat-ui",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var React = require("react");
		var H = React.createElement;

		var P = null;
		try { P = require("@deepseek-ai/dsh-client-ui-primitives"); } catch (e) { P = null; }
		var MarkdownText = P && P.MarkdownText ? P.MarkdownText : null;

		var API = "/wechat-ui";

		/* 官方 MarkdownText 要求 labels 形如
		     { code: { copyLabel, copiedLabel }, footnotes }
		   传空对象会直接 TypeError: Cannot read properties of undefined (reading 'copyLabel')
		   —— 只要回复里出现代码块就会触发，这就是「气泡渲染出错」的根因。
		   t 拿不到就用中文兜底，保证结构永远完整。 */
		function makeLabels(t) {
			var tr = (typeof t === "function") ? t : null;
			var pick = function (key, fallback) {
				try {
					if (!tr) return fallback;
					var value = tr(key);
					return (value === undefined || value === null || value === "") ? fallback : String(value);
				} catch (e) { return fallback; }
			};
			return {
				code: {
					copyLabel: pick("copy", "复制"),
					copiedLabel: pick("copied", "已复制"),
				},
				footnotes: pick("markdown.footnotes", "脚注"),
			};
		}

		/* 心跳：告诉宿主「浏览器还开着」。宿主据此决定要不要弹桌面确认窗。
		   页面加载时立刻发一次，之后每 15 秒一次；切回前台/重新可见时各补一次
		   （浏览器会把后台标签页的定时器节流到分钟级，光靠 setInterval 不够）。 */
		function startHeartbeat() {
			var beat = function () {
				try {
					/* 带上"当前会话"和"标签页在前台吗" —— 自动推进器据此决定要不要发 */
					var q = "?session=" + encodeURIComponent(currentSession || "");
					try { q += "&active=" + (document.visibilityState === "visible" ? "1" : "0"); } catch (e) { }
					fetch(API + "/heartbeat" + q, { method: "POST", cache: "no-store" })
						.then(function (r) { return r.ok ? r.json() : null; })
						.then(function (d) { if (d && d.autoNext) { autoNextState = d.autoNext; notifyAutoNext(); } })
						.catch(function () { });
				} catch (e) { }
			};
			beat();
			try { setInterval(beat, 15000); } catch (e) { }
			try {
				document.addEventListener("visibilitychange", beat);
				window.addEventListener("focus", beat);
			} catch (e) { }
		}

		/* 渲染错误上报：浏览器控制台我看不到，所以送到宿主去（宿主写进诊断与日志） */
		function reportError(kind, error, extra) {
			try {
				fetch(API + "/report", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						kind: kind,
						message: String((error && error.message) || error || "").slice(0, 1500),
						stack: String((error && error.stack) || "").slice(0, 1500),
						extra: extra || null,
						href: String(window.location.href).slice(0, 200),
					}),
				}).catch(function () { });
			} catch (e) { }
		}

		/* ============================ 样式 ============================ */

		var CSS = [
			'.wx-row{display:flex;align-items:flex-start;gap:8px;margin:10px 0;padding:0 2px}',
			'.wx-row-user{flex-direction:row-reverse}',
			/* 头像 */
			'.wx-av{width:36px;height:36px;flex:0 0 36px;border-radius:5px;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:600;color:#fff;user-select:none;background:linear-gradient(135deg,#3a6ea5,#2b4f7a)}',
			'.wx-av-user{background:linear-gradient(135deg,#07C160,#059a4c)}',
			'.wx-av img{width:100%;height:100%;object-fit:cover;display:block}',
			/* 气泡 */
			'.wx-bub{position:relative;max-width:min(660px,76%);padding:9px 13px;border-radius:6px;font-size:14px;line-height:1.65;word-break:break-word;overflow-wrap:anywhere}',
			'.wx-bub-user{background:#95EC69;color:#111}',
			'.wx-bub-ai{background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#191919);border:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22))}',
			'.wx-bub-user:before,.wx-bub-ai:before{content:"";position:absolute;top:12px;width:0;height:0;border:5px solid transparent}',
			'.wx-bub-user:before{right:-9px;border-left-color:#95EC69}',
			'.wx-bub-ai:before{left:-9px;border-right-color:var(--dsw-alias-bg-base,#fff)}',
			'.wx-bub-ai p{margin:.35em 0}',
			'.wx-bub-ai p:first-child{margin-top:0}',
			'.wx-bub-ai p:last-child{margin-bottom:0}',
			'.wx-bub-ai pre{margin:.4em 0}',
			/* 思考过程折叠 */
			'.wx-think{margin:0 0 7px;border-radius:6px;background:var(--dsw-alias-markdown-code-block,rgba(128,128,128,.10))}',
			'.wx-think-head{cursor:pointer;user-select:none;padding:5px 10px;font-size:12.5px;opacity:.8;display:flex;align-items:center;gap:5px}',
			'.wx-think-head:hover{opacity:1}',
			'.wx-think-caret{font-size:10px;width:9px;display:inline-block}',
			'.wx-think-len{opacity:.55;font-size:11.5px}',
			'.wx-think-body{white-space:pre-wrap;font-size:12.5px;line-height:1.6;padding:2px 10px 9px;max-height:300px;overflow:auto;opacity:.8}',
			/* 工具调用 */
			'.wx-tool{margin:4px 0;font-size:12.5px;opacity:.72}',
			/* 表情贴图 */
			'.wx-sticker{margin:6px 0 2px;max-width:190px;border-radius:8px;display:block;cursor:pointer}',
			'.wx-sticker-wrap{position:relative;display:inline-block}',
			/* 浮动工具栏 */
			'.wx-fab{position:fixed;right:16px;bottom:104px;z-index:40;display:flex;flex-direction:column;gap:8px}',
			'.wx-fab button{width:40px;height:40px;border-radius:50%;border:1px solid rgba(128,128,128,.3);background:var(--dsw-alias-bg-base,#fff);color:inherit;cursor:pointer;font-size:17px;line-height:1;box-shadow:0 2px 10px rgba(0,0,0,.18);padding:0}',
			'.wx-fab button:hover{border-color:#07C160}',
			/* 浮动按钮关掉后留的小齿轮：平时很淡，鼠标移上去才清晰 ——
			   既保持界面干净，又保证设置面板永远有入口 */
			'.wx-fab-min{position:fixed;right:10px;bottom:96px;z-index:40;opacity:.22;transition:opacity .15s}',
			'.wx-fab-min:hover{opacity:1}',
			'.wx-fab-min button{width:30px;height:30px;border-radius:50%;border:1px solid rgba(128,128,128,.35);background:var(--dsw-alias-bg-base,#fff);color:inherit;cursor:pointer;font-size:14px;line-height:1;padding:0}',
			'.wx-fab-msg{position:fixed;right:16px;bottom:200px;z-index:41;background:rgba(0,0,0,.74);color:#fff;font-size:12px;line-height:1.4;padding:5px 9px;border-radius:7px;max-width:230px}',
			'.wx-shot{width:100%;max-width:260px;border-radius:6px;margin-top:6px;display:block;border:1px solid rgba(128,128,128,.3)}',
			/* 弹层 */
			'.wx-pop{position:fixed;right:66px;bottom:104px;width:352px;max-height:62vh;overflow:auto;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#191919);border:1px solid rgba(128,128,128,.25);border-radius:10px;box-shadow:0 10px 32px rgba(0,0,0,.28);z-index:41;padding:10px}',
			'.wx-pop h4{margin:2px 0 8px;font-size:13px;font-weight:600;opacity:.85}',
			'.wx-pop .wx-close{position:absolute;right:8px;top:6px;cursor:pointer;opacity:.5;font-size:16px}',
			'.wx-pop .wx-close:hover{opacity:1}',
			'.wx-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}',
			'.wx-grid img{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:6px;cursor:pointer;border:1px solid rgba(128,128,128,.2);display:block}',
			'.wx-grid img:hover{outline:2px solid #07C160;outline-offset:1px}',
			'.wx-grid img.wx-picked{outline:2px solid #07C160;outline-offset:1px}',
			/* 设置行 */
			'.wx-set{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 2px;font-size:13px}',
			'.wx-set input[type=range]{flex:1;max-width:150px;accent-color:#07C160}',
			'.wx-set input[type=checkbox]{accent-color:#07C160;width:15px;height:15px}',
			'.wx-set .wx-val{width:34px;text-align:right;opacity:.65;font-variant-numeric:tabular-nums}',
			'.wx-sep{height:1px;background:rgba(128,128,128,.2);margin:8px 0}',
			'.wx-hint{font-size:11.5px;opacity:.6;line-height:1.5;margin-top:6px}',
			/* 兜底 */
			'.wx-err{margin:6px 0;padding:8px 12px;border-radius:6px;font-size:13px;line-height:1.5;background:rgba(255,90,90,.12);border:1px solid rgba(255,90,90,.35)}',
			'.wx-next-hidden{display:none}',
		].join("\n");

		function injectStyles(css) {
			var el = document.createElement("style");
			el.setAttribute("data-dsh-wechat-ui", "");
			el.textContent = css;
			document.head.appendChild(el);
			return function () { try { el.remove(); } catch (e) {} };
		}

		/* ============================ 设置 ============================ */

		var SETTINGS_KEY = "dsh-wechat-ui:settings";
		var DEFAULTS = {
			toolbar: true,        /* 显示浮动工具栏 */
			autoSticker: true,    /* 自动挑表情 */
			stickerChance: 35,    /* 每条助手消息发表情的概率 % */
			avatarRotate: true,   /* 助手头像轮换 */
			avatarEvery: 8,       /* 每 N 个回合换一次 */
			aiAvatar: "",         /* 指定助手头像文件名，空=自动 */
			userAvatar: "",       /* 指定用户头像文件名，空=文字 */
			disabledStickers: [], /* 被单独停用的表情包（文件名数组） */
			stickerLibraryOpen: false,
		};

		function loadSettings() {
			try {
				var raw = window.localStorage && window.localStorage.getItem(SETTINGS_KEY);
				if (!raw) return Object.assign({}, DEFAULTS);
				var parsed = JSON.parse(raw);
				return Object.assign({}, DEFAULTS, parsed && typeof parsed === "object" ? parsed : {});
			} catch (e) { return Object.assign({}, DEFAULTS); }
		}
		function saveSettings(s) {
			try { window.localStorage && window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
		}

		var settings = loadSettings();
		var settingListeners = [];
		function updateSetting(key, value) {
			settings = Object.assign({}, settings, { [key]: value });
			saveSettings(settings);
			for (var i = 0; i < settingListeners.length; i++) {
				try { settingListeners[i](settings); } catch (e) {}
			}
		}
		function useSettings() {
			var st = React.useState(settings);
			React.useEffect(function () {
				var fn = function (s) { st[1](s); };
				settingListeners.push(fn);
				return function () {
					settingListeners = settingListeners.filter(function (x) { return x !== fn; });
				};
			}, []);
			return st[0];
		}

		/* ============================ 自动推进（宿主半才是权威） ============================
		   这是全套里唯一会持续花钱的功能，所以开关/频率/刹车全部由宿主半判定。
		   浏览器半只做三件事：报告"我在哪个会话"、把设置传过去、显示状态。 */
		var autoNextState = null;
		var autoNextListeners = [];
		function notifyAutoNext() {
			for (var i = 0; i < autoNextListeners.length; i++) {
				try { autoNextListeners[i](autoNextState); } catch (e) {}
			}
		}
		function pullAutoNext() {
			try {
				fetch(API + "/autonext", { cache: "no-store" })
					.then(function (r) { return r.ok ? r.json() : null; })
					.then(function (d) { if (d && d.autoNext) { autoNextState = d.autoNext; notifyAutoNext(); } })
					.catch(function () { });
			} catch (e) { }
		}
		function setAutoNext(query) {
			try {
				fetch(API + "/autonext" + (query || ""), { cache: "no-store" })
					.then(function (r) { return r.ok ? r.json() : null; })
					.then(function (d) { if (d && d.autoNext) { autoNextState = d.autoNext; notifyAutoNext(); } })
					.catch(function () { });
			} catch (e) { }
		}
		function useAutoNext() {
			var st = React.useState(autoNextState);
			React.useEffect(function () {
				var fn = function (s) { st[1](s); };
				autoNextListeners.push(fn);
				if (!autoNextState) pullAutoNext();
				return function () {
					autoNextListeners = autoNextListeners.filter(function (x) { return x !== fn; });
				};
			}, []);
			return st[0];
		}
		/* 宿主给的英文原因 → 说人话 */
		var NEXT_REASON = {
			"off": "总开关是关的",
			"paused": "已暂停（见下方原因）",
			"browser-offline": "浏览器没在报活，页面关了就停",
			"no-session": "还没认出当前会话，聊一句就认识了",
			"no-agent": "当前会话不在内存里",
			"waiting": "正常，在按频率等下一次",
			"session-running": "模型正在回答，等它说完",
			"daily-cap": "已达今天硬上限，今天不再发",
			"streak-cap": "连续太多次没人接话，已自动暂停",
			"context-too-big": "当前会话上下文太大，为省钱跳过（可调上限）",
			"rate-zero": "频率设成 0 了，等于不发",
			"no-service": "宿主半拿不到会话服务",
			"error": "上次发送出错（看诊断）",
			"sent": "刚刚发过一条",
		};

		/* 当前打开的会话 id。聊天节点渲染器能拿到 props.sessionId
		   （官方插槽契约里的标准属性），心跳把它报给宿主。 */
		var currentSession = "";
		function noteSession(props) {
			try {
				var sid = props && props.sessionId ? String(props.sessionId) : "";
				if (sid !== currentSession) currentSession = sid;
			} catch (e) { }
		}

		/* ---- 定时截屏（截图本身不花钱；只有"让 AI 看"那一步花钱） ---- */
		var watchState = null;
		var watchListeners = [];
		function notifyWatch() {
			for (var i = 0; i < watchListeners.length; i++) {
				try { watchListeners[i](watchState); } catch (e) { }
			}
		}
		function pullWatch() {
			try {
				fetch(API + "/watch", { cache: "no-store" })
					.then(function (r) { return r.ok ? r.json() : null; })
					.then(function (d) { if (d && d.watch) { watchState = d.watch; notifyWatch(); } })
					.catch(function () { });
			} catch (e) { }
		}
		function setWatch(query) {
			try {
				fetch(API + "/watch" + (query || ""), { cache: "no-store" })
					.then(function (r) { return r.ok ? r.json() : null; })
					.then(function (d) { if (d && d.watch) { watchState = d.watch; notifyWatch(); } })
					.catch(function () { });
			} catch (e) { }
		}
		function useWatch() {
			var st = React.useState(watchState);
			React.useEffect(function () {
				var fn = function (s) { st[1](s); };
				watchListeners.push(fn);
				if (!watchState) pullWatch();
				return function () {
					watchListeners = watchListeners.filter(function (x) { return x !== fn; });
				};
			}, []);
			return st[0];
		}

		/* "让 AI 看现在的屏幕"：这一步花钱，所以要把结果（尤其失败原因）显示出来 */
		var lookState = { busy: false, message: "" };
		var lookListeners = [];
		function notifyLook() {
			for (var i = 0; i < lookListeners.length; i++) {
				try { lookListeners[i](lookState); } catch (e) { }
			}
		}
		function useLook() {
			var st = React.useState(lookState);
			React.useEffect(function () {
				var fn = function (s) { st[1](s); };
				lookListeners.push(fn);
				return function () {
					lookListeners = lookListeners.filter(function (x) { return x !== fn; });
				};
			}, []);
			return st[0];
		}
		var LOOK_REASON = {
			"busy": "上一张还在处理",
			"too-soon": "太频繁了，隔十几秒再来",
			"daily-cap": "今天看得够多了",
			"no-session": "还没认出当前会话，先聊一句",
			"no-service": "宿主半拿不到会话服务",
			"no-agent": "当前会话不在内存里",
			"session-running": "模型正在回答，等它说完",
			"context-too-big": "会话上下文太大，为省钱跳过",
			"error": "发送出错",
		};
		function lookAtScreenNow(question) {
			if (lookState.busy) return;
			lookState = { busy: true, message: "正在截屏并发送…" };
			notifyLook();
			try {
				fetch(API + "/look?q=" + encodeURIComponent(question || ""), { cache: "no-store" })
					.then(function (r) { return r.json(); })
					.then(function (d) {
						if (d && d.watch) { watchState = d.watch; notifyWatch(); }
						if (d && d.ok) {
							lookState = { busy: false, message: "已发出（" + Math.round((d.bytes || 0) / 1024) + " KB），等它回答" };
						} else {
							var why = (d && d.reason) || "error";
							lookState = { busy: false, message: LOOK_REASON[why] || ("失败：" + why) };
						}
						notifyLook();
					})
					.catch(function () { lookState = { busy: false, message: "请求失败" }; notifyLook(); });
			} catch (e) {
				lookState = { busy: false, message: "请求失败" };
				notifyLook();
			}
		}

		/* ============================ 数据加载（模块级缓存，只请求一次） ============================ */

		var dataPromise = null;
		function loadData() {
			if (!dataPromise) {
				dataPromise = Promise.all([
					fetch(API + "/stickers").then(function (r) { return r.ok ? r.json() : { files: [] }; }).catch(function () { return { files: [] }; }),
					fetch(API + "/tags").then(function (r) { return r.ok ? r.json() : { items: [] }; }).catch(function () { return { items: [] }; }),
				]).then(function (res) {
					var files = (res[0] && res[0].files) || [];
					var items = (res[1] && res[1].items) || [];
					var byFile = {};
					for (var i = 0; i < items.length; i++) {
						var it = items[i];
						if (it && it.file && it.usable !== false) byFile[it.file] = it;
					}
					return { files: files, tags: byFile };
				});
			}
			return dataPromise;
		}
		function useData() {
			var st = React.useState(null);
			React.useEffect(function () {
				var alive = true;
				loadData().then(function (d) { if (alive) st[1](d); }).catch(function () {});
				return function () { alive = false; };
			}, []);
			return st[0];
		}

		function imgUrl(file) { return API + "/img?f=" + encodeURIComponent(file); }

		/* ============================ 自动挑表情 ============================ */

		function hashStr(s) {
			var h = 0;
			for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
			return h;
		}

		/* 按【触发词】打分挑表情。
		   以前是按固定情绪词查表，只有 25 个词，导致一部分图永远选不到；
		   现在每张图都有自己的触发词（12~21 个），所以每张都有被选中的入口。
		   评分：越长的触发词越具体，命中它说明语境越贴切 → 权重越高。 */
		/* 表情选择缓存 —— 长会话下最明显的一处省算力。
		   pickSticker 要拿正文和 34 张表情的触发词逐条比（≈450 次字符串比较），
		   而它原来是在【每次渲染】里现算的；几百条消息的会话，光滚动就要重算好几万次。
		   一条已完成消息的正文不会变，所以按「消息种子 + 设置指纹」缓存：
		   blocksText 和 pickSticker 都只在第一次算，之后直接取。 */
		var stickerPickCache = new Map();
		var STICKER_CACHE_MAX = 800;

		function pickStickerCached(seed, blocks, stick, s) {
			try {
				var dl = Array.isArray(s.disabledStickers) ? s.disabledStickers : [];
				var sig = seed + "|" + (Number(s.stickerChance) || 0) + "|" + dl.join(",") +
					"|" + (stick && stick.files ? stick.files.length : 0);
				if (stickerPickCache.has(sig)) return stickerPickCache.get(sig);

				var pick = null;
				var excluded = {};
				for (var i = 0; i < dl.length; i++) excluded[dl[i]] = true;
				var body = blocksText(blocks);
				var chance = Math.max(0, Math.min(100, Number(s.stickerChance) || 0));
				var roll = Math.abs(hashStr("roll|" + seed + "|" + body.slice(0, 80))) % 100;
				if (roll < chance) pick = pickSticker(body, stick, seed, excluded);

				/* 缓存别无限长：满了就整个丢掉重建（比维护 LRU 简单，代价可接受） */
				if (stickerPickCache.size > STICKER_CACHE_MAX) stickerPickCache.clear();
				stickerPickCache.set(sig, pick);
				return pick;
			} catch (e) {
				return null;
			}
		}

		function pickSticker(text, data, seed, excluded) {
			try {
				if (!data || !Array.isArray(data.files) || data.files.length === 0) return null;
				var body = String(text || "");
				if (body.length === 0) return null;

				var scored = [];
				for (var i = 0; i < data.files.length; i++) {
					var file = data.files[i];
					var tag = data.tags[file];
					if (!tag || tag.disabled) continue;
					if (excluded && excluded[file]) continue;
					var triggers = Array.isArray(tag.triggers) ? tag.triggers : null;
					if (!triggers || triggers.length === 0) continue;

					var score = 0;
					for (var j = 0; j < triggers.length; j++) {
						var t = String(triggers[j]);
						if (t.length < 2) continue;
						if (body.indexOf(t) >= 0) score += 1 + Math.min(4, Math.floor(t.length / 3));
					}
					if (score > 0) scored.push({ file: file, score: score });
				}
				if (scored.length === 0) return null;

				/* 只在最高分附近挑，避免"碰巧命中一个泛词"的图抢戏 */
				scored.sort(function (a, b) { return b.score - a.score; });
				var best = scored[0].score;
				var tier = scored.filter(function (s) { return s.score >= best * 0.6; });
				if (tier.length > 5) tier = tier.slice(0, 5);

				/* 用 seed 定档内顺序：同一条消息重渲染时挑到同一张，不会乱跳 */
				var idx = Math.abs(hashStr(String(seed || 0) + "|" + body.slice(0, 120))) % tier.length;
				return tier[idx].file;
			} catch (e) { return null; }
		}

		/* 用户点了表情（插进输入框的标记），强制用那一张 */
		var EXPLICIT_RE = /\[表情:([^\]\s]+)\]/;

		function explicitSticker(text, data) {
			try {
				var m = EXPLICIT_RE.exec(text || "");
				if (!m) return null;
				var file = m[1];
				if (data && Array.isArray(data.files) && data.files.indexOf(file) >= 0) return file;
				return null;
			} catch (e) { return null; }
		}

		/* ============================ 数据提取 ============================ */

		function blocksText(blocks) {
			try {
				if (!Array.isArray(blocks)) return "";
				var out = "";
				for (var i = 0; i < blocks.length; i++) {
					var b = blocks[i];
					if (b && b.kind === "text" && typeof b.text === "string") out += b.text + "\n";
				}
				return out;
			} catch (e) { return ""; }
		}

		function textOfContent(content) {
			try {
				if (typeof content === "string") return content;
				if (!Array.isArray(content)) return "";
				var out = "";
				for (var i = 0; i < content.length; i++) {
					var b = content[i];
					if (b && b.type === "text" && typeof b.text === "string") out += b.text;
				}
				return out;
			} catch (e) { return ""; }
		}

		function isNextOnly(text) {
			if (typeof text !== "string") return false;
			var t = text.trim();
			if (t.length === 0 || t.length > 12) return false;
			return /^(next|continue|go\s*on|继续|下一步)$/i.test(t);
		}

		function turnSeed(node) {
			try {
				var loc = node && node.location;
				if (!loc) return 0;
				var t = loc.turn;
				if (typeof t === "number") return t;
				if (t && typeof t.turn === "number") return t.turn;
				if (t && typeof t.seq === "number") return t.seq;
				if (typeof loc.seq === "number") return loc.seq;
			} catch (e) {}
			return 0;
		}

		/* ============================ 错误边界 ============================ */

		class WxBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { err: null };
			}
			static getDerivedStateFromError(err) { return { err: err }; }
			/* 兜底文本可以是字符串，也可以是函数。
			   传函数是为了【懒算】：这条文本只有在真的渲染失败时才会被用到，
			   但原来调用方在每次渲染都先把它算出来（等于每个气泡每帧多遍历一遍内容）。
			   几百条消息的会话里，这笔白工是纯浪费。 */
			fallback() {
				try {
					var f = this.props.fallbackText;
					return typeof f === "function" ? String(f() || "") : String(f || "");
				} catch (e) { return ""; }
			}
			componentDidCatch(err, info) {
				console.error("[wechat-ui] 组件渲染出错，已隔离（DSH 其余功能不受影响）：", err, info);
				reportError("boundary", err, {
					where: String(this.props.where || "bubble"),
					componentStack: info && info.componentStack ? String(info.componentStack).slice(0, 800) : "",
					fallbackText: this.fallback().slice(0, 300),
				});
			}
			render() {
				if (this.state.err) {
					var msg = String((this.state.err && this.state.err.message) || this.state.err);
					var fb = this.fallback();
					return H("div", { className: "wx-err" },
						this.props.title || "\u26a0 微信气泡渲染出错，这条消息已降级显示。",
						H("div", { style: { marginTop: 4, opacity: .7, fontSize: 12 } }, msg),
						fb
							? H("div", { style: { marginTop: 6, whiteSpace: "pre-wrap" } }, fb)
							: null);
				}
				return this.props.children;
			}
		}

		/* ============================ 版本握手 ============================
		   插件目录是两个 DSH 实例共用的，而 live 重载【不会】重新加载模块代码。
		   所以只要"磁盘换了新代码、进程还是旧的"，刷新页面就会出现
		   浏览器半（新）对着宿主半（旧）——前端去调不存在的接口。
		   这里主动问一句，不一致就明确报出来，而不是让页面莫名其妙地坏掉。 */
		var CLIENT_VERSION = "0.8.6";
		var hostVersion = null;
		var hostMismatch = false;

		function checkHostVersion() {
			try {
				fetch(API + "/version", { cache: "no-store" })
					.then(function (r) { return r.ok ? r.json() : null; })
					.then(function (d) {
						if (!d || !d.version) return;
						hostVersion = String(d.version);
						hostMismatch = hostVersion !== CLIENT_VERSION;
						if (hostMismatch) {
							var e = new Error("版本不一致：浏览器半 " + CLIENT_VERSION + " / 宿主半 " + hostVersion);
							console.error("[wechat-ui] " + e.message + " —— 多数情况是页面太旧，先 Ctrl+F5 强制刷新；刷新后仍提示才需要重启 DSH。");
							reportError("version-mismatch", e, { client: CLIENT_VERSION, host: hostVersion });
						}
					})
					.catch(function () { });
			} catch (e) { }
		}

		/* ============================ 头像 ============================ */

		function Avatar(props) {
			var data = useData();
			var s = useSettings();
			var isUser = props.side === "user";
			var file = null;
			try {
				var files = (data && data.files) || [];
				var chosen = isUser ? s.userAvatar : s.aiAvatar;
				if (chosen) {
					file = chosen;
				} else if (files.length > 0) {
					if (isUser) {
						file = null; /* 用户默认还是文字头像，避免抢戏 */
					} else {
						var every = Math.max(1, Number(s.avatarEvery) || 8);
						var idx = s.avatarRotate ? (Math.floor((props.seed || 0) / every) % files.length) : 0;
						file = files[idx];
					}
				}
			} catch (e) { file = null; }

			return H("div", { className: "wx-av " + (isUser ? "wx-av-user" : "") },
				file ? H("img", { src: imgUrl(file), alt: "", loading: "lazy" }) : (isUser ? "我" : "鲸"));
		}

		/* ============================ 思考过程折叠 ============================ */

		function ReasoningFold(props) {
			var st = React.useState(false);
			var open = st[0], setOpen = st[1];
			var text = props.text || "";
			var title = props.running ? "思考中…" : "思考过程";
			return H("div", { className: "wx-think" },
				H("div", { className: "wx-think-head", onClick: function () { setOpen(!open); } },
					H("span", { className: "wx-think-caret" }, open ? "\u25be" : "\u25b8"),
					H("span", null, title),
					H("span", { className: "wx-think-len" }, text.length + " 字")),
				open ? H("div", { className: "wx-think-body" }, text) : null);
		}

		/* ============================ 表情贴图 ============================ */

		function StickerView(props) {
			if (!props.file) return null;
			return H("div", { className: "wx-sticker-wrap" },
				H("img", {
					className: "wx-sticker",
					src: imgUrl(props.file),
					alt: props.alt || "表情",
					title: props.alt || "",
					loading: "lazy",
					onClick: function () {
						try { window.open(imgUrl(props.file), "_blank"); } catch (e) {}
					},
				}));
		}

		/* ============================ 助手气泡 ============================ */

		function AssistantInner(props) {
			var node = props.node || {};
			var data = node.data || {};
			var blocks = Array.isArray(data.blocks) ? data.blocks : [];
			var streaming = data.status === "running";
			var s = useSettings();
			var stick = useData();
			/* labels 结构必须完整，否则 MarkdownText 在有代码块时抛错 */
			var labels = React.useMemo(function () { return makeLabels(props.t); }, [props.t]);

			var reasoning = "";
			var out = [];
			for (var i = 0; i < blocks.length; i++) {
				var b = blocks[i];
				if (!b || typeof b !== "object") continue;
				if (b.kind === "reasoning") { reasoning += (b.text || ""); continue; }
				if (b.kind === "text") {
					var key = "t" + i;
					if (MarkdownText) {
						out.push(H(MarkdownText, { key: key, text: b.text || "", streaming: streaming, labels: labels }));
					} else {
						out.push(H("div", { key: key, style: { whiteSpace: "pre-wrap" } }, b.text || ""));
					}
					continue;
				}
				if (b.kind === "tool-call") {
					out.push(H("div", { key: "c" + i, className: "wx-tool" }, "\ud83d\udd27 " + (b.name || "tool")));
					continue;
				}
			}

			if (reasoning.trim() !== "") {
				out.unshift(H(ReasoningFold, { key: "reasoning", text: reasoning, running: streaming }));
			}

			/* 表情：显式标记优先，其次是按概率自动挑。出字中不发表情。 */
			var stickerFile = null;
			if (!streaming && props.forcedSticker) {
				stickerFile = props.forcedSticker;
			} else if (!streaming && s.autoSticker && stick && stick.files.length > 0) {
				stickerFile = pickStickerCached(turnSeed(node), blocks, stick, s);
			}
			if (stickerFile) out.push(H(StickerView, { key: "sticker", file: stickerFile }));

			return H("div", { className: "wx-bub wx-bub-ai" },
				out.length > 0 ? out : H("span", { style: { opacity: .5 } }, streaming ? "\u2026" : "\uff08\u7a7a\uff09"));
		}

		function WxAssistantBubble(props) {
			noteSession(props);
			/* 兜底文本改成懒算（传函数）—— 它只在渲染真出错时才用得上，
			   原来却每次渲染都要把整条消息遍历一遍 */
			return H(WxBoundary, {
				fallbackText: function () {
					try { return blocksText(props && props.node && props.node.data && props.node.data.blocks); } catch (e) { return ""; }
				},
			},
				H("div", { className: "wx-row wx-row-ai" },
					H(Avatar, { side: "ai", seed: turnSeed(props && props.node) }),
					H(AssistantInner, props)));
		}

		/* ============================ 用户气泡 ============================ */

		function WxUserBubble(props) {
			noteSession(props);
			var text = "";
			try { text = textOfContent(props && props.node && props.node.data && props.node.data.content); } catch (e) { text = ""; }

			if (isNextOnly(text)) return H("div", { className: "wx-next-hidden" });

			/* 用户消息里带 [表情:x] 标记时，把标记从气泡正文里去掉，只留文字 */
			var shown = text.replace(EXPLICIT_RE, "").trim();
			return H(WxBoundary, {
				fallbackText: function () {
					try { return textOfContent(props && props.node && props.node.data && props.node.data.content); } catch (e) { return ""; }
				},
			},
				H("div", { className: "wx-row wx-row-user" },
					H(Avatar, { side: "user" }),
					H("div", { className: "wx-bub wx-bub-user" }, shown)));
		}

		/* ============================ 往输入框插入标记 ============================ */

		function insertIntoComposer(text) {
			try {
				var nodes = document.querySelectorAll("textarea, [contenteditable='true'], [contenteditable='']");
				var el = null;
				for (var i = nodes.length - 1; i >= 0; i--) {
					var n = nodes[i];
					if (n && n.offsetParent !== null) { el = n; break; }
				}
				if (!el) return false;

				if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
					/* React 受控组件：必须走原生 setter 再派发 input 事件，否则状态不更新 */
					var proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
					var desc = Object.getOwnPropertyDescriptor(proto, "value");
					var next = (el.value || "") + text;
					if (desc && desc.set) desc.set.call(el, next); else el.value = next;
					el.dispatchEvent(new Event("input", { bubbles: true }));
					el.focus();
					return true;
				}

				/* contenteditable：用 execCommand 保住撤销栈与 React 的输入事件 */
				el.focus();
				var sel = window.getSelection();
				if (sel) {
					var range = document.createRange();
					range.selectNodeContents(el);
					range.collapse(false);
					sel.removeAllRanges();
					sel.addRange(range);
				}
				if (document.execCommand) document.execCommand("insertText", false, text);
				else el.textContent = (el.textContent || "") + text;
				el.dispatchEvent(new Event("input", { bubbles: true }));
				return true;
			} catch (e) {
				console.error("[wechat-ui] 插入输入框失败：", e);
				return false;
			}
		}

		function insertSticker(file) {
			var ok = insertIntoComposer("[表情:" + file + "]");
			if (!ok) {
				try {
					if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText("[表情:" + file + "]");
					window.alert("没找到输入框，已把标记复制到剪贴板：\n[表情:" + file + "]\n粘贴到输入框发给我就行。");
				} catch (e) {
					window.alert("没找到输入框，请手动输入：[表情:" + file + "]");
				}
			}
		}

		/* ============================ 表情面板 ============================ */

		function StickerPanel(props) {
			var data = useData();
			var s = useSettings();
			var files = (data && data.files) || [];
			var acts = props.mode === "avatar" ? "avatar" : "send";
			var target = props.avatarTarget || "ai";

			return H("div", { className: "wx-pop" },
				H("span", { className: "wx-close", onClick: props.onClose }, "\u00d7"),
				H("h4", null, acts === "avatar"
					? (target === "ai" ? "选一张当我的头像" : "选一张当你的头像")
					: "点一张 → 插到输入框（发出去我就知道你要哪张）"),
				files.length === 0
					? H("div", { className: "wx-hint" }, "没拿到表情包列表。检查 D:\\ComfyUI 之外的那个图片目录，或看 dsh 日志里 [wechat-ui] 的报错。")
					: H("div", { className: "wx-grid" },
						files.map(function (f) {
							var tag = (data.tags && data.tags[f]) || null;
							var title = tag ? ((tag.text || "") + "  " + (tag.mood || "")).slice(0, 80) : f;
							var picked = acts === "avatar"
								? (target === "ai" ? s.aiAvatar : s.userAvatar) === f
								: false;
							return H("img", {
								key: f,
								src: imgUrl(f),
								alt: title,
								title: title,
								className: picked ? "wx-picked" : "",
								loading: "lazy",
								onClick: function () {
									if (acts === "avatar") {
										updateSetting(target === "ai" ? "aiAvatar" : "userAvatar", f);
									} else {
										insertSticker(f);
									}
								},
							});
						})),
				acts === "avatar" && ((target === "ai" ? s.aiAvatar : s.userAvatar) !== "")
					? H("div", { className: "wx-hint" },
						H("a", {
							href: "#",
							onClick: function (e) { e.preventDefault(); updateSetting(target === "ai" ? "aiAvatar" : "userAvatar", ""); },
						}, "清除这个头像（恢复默认）"))
					: null);
		}

		/* ============================ 设置面板 ============================ */

		function Switch(props) {
			return H("div", { className: "wx-set" },
				H("span", null, props.label),
				H("input", {
					type: "checkbox",
					checked: !!props.checked,
					onChange: function (e) { props.onChange(!!e.target.checked); },
				}));
		}

		function Slider(props) {
			return H("div", { className: "wx-set" },
				H("span", null, props.label),
				H("input", {
					type: "range", min: props.min, max: props.max, step: props.step || 1,
					value: props.value,
					onChange: function (e) { props.onChange(Number(e.target.value)); },
				}),
				H("span", { className: "wx-val" }, props.value + (props.unit || "")));
		}

		/* 表情库：看每张的触发词、单独停用某张。
		   停用只影响"自动挑选"，手动发表情仍然能用它。 */
		function StickerLibraryPanel(props) {
			var data = useData();
			var s = useSettings();
			var files = (data && data.files) || [];
			var disabled = Array.isArray(s.disabledStickers) ? s.disabledStickers : [];
			var disabledSet = {};
			for (var i = 0; i < disabled.length; i++) disabledSet[disabled[i]] = true;

			var toggle = function (file) {
				var next = [];
				var found = false;
				for (var j = 0; j < disabled.length; j++) {
					if (disabled[j] === file) { found = true; continue; }
					next.push(disabled[j]);
				}
				if (!found) next.push(file);
				updateSetting("disabledStickers", next);
			};

			return H("div", { className: "wx-pop", style: { width: 410 } },
				H("span", { className: "wx-close", onClick: props.onClose }, "\u00d7"),
				H("h4", null, "表情库（" + (files.length - disabled.length) + " / " + files.length + " 启用）"),
				H("div", { className: "wx-hint", style: { marginBottom: 8 } },
					"点一下就停用/启用。停用的不会被自动发出来。鼠标悬停能看到每张的触发词。"),
				disabled.length > 0
					? H("div", { style: { marginBottom: 8 } },
						H("a", {
							href: "#",
							onClick: function (e) { e.preventDefault(); updateSetting("disabledStickers", []); },
						}, "全部启用"))
					: null,
				files.length === 0
					? H("div", { className: "wx-hint" }, "没拿到表情包列表（宿主半没加载？）")
					: H("div", { className: "wx-grid" },
						files.map(function (f) {
							var tag = (data.tags && data.tags[f]) || null;
							var triggers = (tag && Array.isArray(tag.triggers)) ? tag.triggers : [];
							var title = (tag ? (tag.text || "") + "\n情绪：" + (tag.mood || "") : f) +
								(triggers.length ? "\n\n触发词（" + triggers.length + "）：" + triggers.join("、") : "\n\n（这张没有触发词）");
							var off = !!disabledSet[f];
							return H("div", { key: f, style: { position: "relative" } },
								H("img", {
									src: imgUrl(f),
									alt: tag ? (tag.mood || "") : f,
									title: title,
									loading: "lazy",
									style: off ? { opacity: .28, filter: "grayscale(1)" } : null,
									onClick: function () { toggle(f); },
								}),
								off ? H("span", {
									style: {
										position: "absolute", left: 4, top: 4, fontSize: 10,
										background: "rgba(0,0,0,.62)", color: "#fff",
										padding: "1px 4px", borderRadius: 3,
									},
								}, "停用") : null);
						})),
				H("div", { className: "wx-hint" },
					"每张都有独立触发词，所以都有机会被自动选中；停用只是把它从自动挑选里排除。"));
		}

		function SettingsPanel(props) {
			var s = useSettings();
			var data = useData();
			var an = useAutoNext();
			var w = useWatch();
			var look = useLook();
			var files = (data && data.files) || [];
			var avatarState = React.useState(null);
			var avatarMode = avatarState[0], setAvatarMode = avatarState[1];
			var libState = React.useState(false);
			var libraryOpen = libState[0], setLibraryOpen = libState[1];

			/* 面板开着的时候每 5 秒刷一次状态，这样"今天已发几条/在等什么"是活的。
			   注意：必须放在下面的提前 return 之前，否则违反 hooks 规则。 */
			React.useEffect(function () {
				pullAutoNext();
				pullWatch();
				var t = null;
				try { t = setInterval(function () { pullAutoNext(); pullWatch(); }, 5000); } catch (e) { }
				return function () { try { if (t) clearInterval(t); } catch (e) { } };
			}, []);

			if (libraryOpen) {
				return H(StickerLibraryPanel, { onClose: function () { setLibraryOpen(false); } });
			}

			if (avatarMode) {
				return H(StickerPanel, {
					mode: "avatar",
					avatarTarget: avatarMode,
					onClose: function () { setAvatarMode(null); },
				});
			}

			var disabledCount = Array.isArray(s.disabledStickers) ? s.disabledStickers.length : 0;

			return H("div", { className: "wx-pop" },
				H("span", { className: "wx-close", onClick: props.onClose }, "\u00d7"),
				H("h4", null, "微信模式设置"),

				H(Switch, { label: "显示浮动按钮", checked: s.toolbar, onChange: function (v) { updateSetting("toolbar", v); } }),
				H(Switch, { label: "自动发表情", checked: s.autoSticker, onChange: function (v) { updateSetting("autoSticker", v); } }),
				H(Slider, { label: "发表情频率", value: s.stickerChance, min: 0, max: 100, step: 5, unit: "%", onChange: function (v) { updateSetting("stickerChance", v); } }),
				H("div", { className: "wx-set" },
					H("span", null, "表情库"),
					H("span", null,
						H("a", {
							href: "#",
							onClick: function (e) { e.preventDefault(); setLibraryOpen(true); },
						}, "管理（" + (files.length - disabledCount) + "/" + files.length + " 启用）"))),

				H("div", { className: "wx-sep" }),

				/* ---- 自动推进：会花钱，所以默认关，状态也要写清楚 ---- */
				H(Switch, {
					label: "自动推进（每条约一次模型调用，会花钱）",
					checked: !!(an && an.enabled),
					onChange: function (v) { setAutoNext("?on=" + (v ? "1" : "0")); },
				}),
				an ? H("div", null,
					H(Slider, { label: "空闲频率", value: an.idlePerHour, min: 0, max: 50, step: 1, unit: " 次/时", onChange: function (v) { setAutoNext("?idle=" + v); } }),
					H(Slider, { label: "对话中频率", value: an.activePerHour, min: 0, max: 120, step: 5, unit: " 次/时", onChange: function (v) { setAutoNext("?active=" + v); } }),
					H(Slider, { label: "连续上限", value: an.maxStreak, min: 1, max: 100, step: 1, unit: " 次", onChange: function (v) { setAutoNext("?streak=" + v); } }),
					H(Slider, { label: "上下文上限", value: an.maxContextTokens, min: 0, max: 600000, step: 20000, unit: " token", onChange: function (v) { setAutoNext("?maxctx=" + v); } }),
					H("div", { className: "wx-hint", style: { marginTop: 2 } },
						"上下文超过上限就跳过（0 = 不限制）。推进一条 = 把整个上下文再喂一次，会话越大越贵。" +
						(an.lastContextTokens ? " 当前会话约 " + Math.round(an.lastContextTokens / 1000) + "k token。" : "")),
					H("div", { className: "wx-set" },
						H("span", null, "状态"),
						H("span", null, (an.paused ? "已暂停" : (an.enabled ? "运行中" : "未开启")) + " · 今天已发 " + an.sentToday + " 条")),
					H("div", { className: "wx-hint", style: { marginTop: 4 } },
						(an.paused && an.pauseReason) ? an.pauseReason : ("当前：" + (NEXT_REASON[an.lastReason] || an.lastReason || "—"))),
					an.paused ? H("div", { className: "wx-set" },
						H("span", null, "刹车已踩下"),
						H("span", null,
							H("a", { href: "#", onClick: function (e) { e.preventDefault(); setAutoNext("?resume=1"); } }, "恢复"))) : null) : null,

				H("div", { className: "wx-sep" }),

				/* ---- 定时截屏：截图不花钱，"让 AI 看"才花钱 ---- */
				H(Switch, {
					label: "定时截屏（只存本地，不花钱）",
					checked: !!(w && w.enabled),
					onChange: function (v) { setWatch("?on=" + (v ? "1" : "0")); },
				}),
				w ? H("div", null,
					H(Slider, { label: "截屏间隔", value: w.intervalSec, min: 10, max: 600, step: 10, unit: " 秒", onChange: function (v) { setWatch("?sec=" + v); } }),
					H("div", { className: "wx-set" },
						H("span", null, "状态"),
						H("span", null, (w.enabled ? "每 " + w.intervalSec + " 秒一张" : "未开启") + " · 已截 " + w.shots + " 张")),
					w.lastError ? H("div", { className: "wx-hint", style: { marginTop: 4 } }, "上次出错：" + w.lastError) : null,
					H("div", { className: "wx-set" },
						H("span", null, "最新一张"),
						H("span", null,
							H("a", { href: "#", onClick: function (e) { e.preventDefault(); setWatch("?now=1"); } }, "立刻截一张"))),
					w.hasShot ? H("img", { className: "wx-shot", src: API + "/latest?t=" + (w.lastAt || 0) }) : null,
					H("div", { className: "wx-set" },
						H("span", null, "让 AI 看"),
						H("span", null,
							H("a", {
								href: "#",
								onClick: function (e) { e.preventDefault(); lookAtScreenNow(""); },
							}, look && look.busy ? "处理中…" : "看现在的屏幕"))),
					look && look.message ? H("div", { className: "wx-hint", style: { marginTop: 4 } }, look.message) : null,
					H("div", { className: "wx-sep" }),
					H(Switch, {
						label: "自动让 AI 看（每看一次都是一次模型调用，会花钱）",
						checked: !!(w.autoLook),
						onChange: function (v) { setWatch("?auto=" + (v ? "1" : "0")); },
					}),
					H(Slider, { label: "看屏幕频率", value: w.autoLookPerHour, min: w.autoLookMinPerHour, max: w.autoLookMaxPerHour, step: 1, unit: " 次/时", onChange: function (v) { setWatch("?perhour=" + v); } }),
					H(Slider, { label: "连续上限", value: w.autoLookMaxStreak, min: 1, max: 50, step: 1, unit: " 次", onChange: function (v) { setWatch("?lookstreak=" + v); } }),
					H("div", { className: "wx-set" },
						H("span", null, "状态"),
						H("span", null, (w.autoLookPaused ? "已暂停" : (w.autoLook ? "运行中" : "未开启")) + " · 今天已看 " + w.autoLookToday + " 次")),
					(w.autoLookPaused && w.autoLookPauseReason) ? H("div", { className: "wx-hint", style: { marginTop: 4 } }, w.autoLookPauseReason) : null,
					w.autoLookPaused ? H("div", { className: "wx-set" },
						H("span", null, "刹车已踩下"),
						H("span", null,
							H("a", { href: "#", onClick: function (e) { e.preventDefault(); setWatch("?resume=1"); } }, "恢复"))) : null,
					w.autoLookLastError ? H("div", { className: "wx-hint", style: { marginTop: 4 } }, "上次出错：" + w.autoLookLastError) : null,
					H("div", { className: "wx-hint", style: { marginTop: 4 } },
						"「让 AI 看」会把截图作为图片发给模型，这一步会花钱（每次一张全屏图 + 当前上下文）。" +
						"定时截屏本身只写本地文件，可以放心开着。")) : null,

				H("div", { className: "wx-sep" }),

				H(Switch, { label: "头像轮换", checked: s.avatarRotate, onChange: function (v) { updateSetting("avatarRotate", v); } }),
				H(Slider, { label: "每 N 回合换", value: s.avatarEvery, min: 1, max: 40, step: 1, unit: "", onChange: function (v) { updateSetting("avatarEvery", v); } }),

				H("div", { className: "wx-set" },
					H("span", null, "我的头像"),
					H("span", null,
						H("a", { href: "#", onClick: function (e) { e.preventDefault(); setAvatarMode("ai"); } }, s.aiAvatar ? "更换" : "选一张"),
						s.aiAvatar ? H("a", { href: "#", style: { marginLeft: 10, opacity: .7 }, onClick: function (e) { e.preventDefault(); updateSetting("aiAvatar", ""); } }, "清除") : null)),
				H("div", { className: "wx-set" },
					H("span", null, "你的头像"),
					H("span", null,
						H("a", { href: "#", onClick: function (e) { e.preventDefault(); setAvatarMode("user"); } }, s.userAvatar ? "更换" : "选一张"),
						s.userAvatar ? H("a", { href: "#", style: { marginLeft: 10, opacity: .7 }, onClick: function (e) { e.preventDefault(); updateSetting("userAvatar", ""); } }, "清除") : null)),

				H("div", { className: "wx-hint" },
					"表情包共 " + files.length + " 张，每张都有独立触发词，所以都有机会被自动选中。设置存在浏览器本地，换台机器要重设。"),
			);
		}

		/* ============================ 浮动工具栏 ============================ */

		function Toolbar(props) {
			/* 测试探针：让离线测试能真的把工具栏搞炸，验证错误边界接得住。
			   没有这条，就证明不了"工具栏出错不会白屏"。 */
			if (props && props.__poison) throw new Error("poisoned-toolbar");
			var s = useSettings();
			var look = useLook();
			var panelSt = React.useState(null);
			var panel = panelSt[0], setPanel = panelSt[1];

			/* 版本不一致只提示，绝不夺走功能。
			   之前是直接 return 提示 —— 等于把工具栏换成了一行红字，
			   用户本来只是"版本旧一点"，结果连设置都打不开了。
			   提示的目的是告诉人原因，不是惩罚人。 */
			var notice = hostMismatch
				? H("div", {
					className: "wx-fab-msg",
					style: { background: "rgba(190,40,40,.92)", bottom: "104px" },
				}, "插件版本不一致：页面 " + CLIENT_VERSION + " / 服务 " + hostVersion +
					"。功能仍可用；按 Ctrl+F5 强制刷新本页，若仍提示则需重启 DSH。")
				: null;

			/* ⚠ 关掉浮动按钮之后【不能什么都不留】。
			   设置面板是从这个工具栏打开的 —— 全隐藏就等于把唯一的入口
			   一起藏了，用户再也调不回来（真实踩过：只能去开 F12 清 localStorage）。
			   所以关掉时只留一个很淡的小齿轮，鼠标移上去才变清晰。 */
			if (!s.toolbar) {
				return H("div", null,
					notice,
					H("div", { className: "wx-fab-min" },
						H("button", {
							title: "浮动按钮已隐藏 · 点这里打开微信模式设置",
							onClick: function () { setPanel(panel === "settings" ? null : "settings"); },
						}, "\u2699")),
					panel === "settings" ? H(SettingsPanel, { onClose: function () { setPanel(null); } }) : null);
			}

			return H("div", null,
				notice,
				H("div", { className: "wx-fab" },
					H("button", {
						title: "表情包",
						onClick: function () { setPanel(panel === "sticker" ? null : "sticker"); },
					}, "\ud83d\ude0a"),
					H("button", {
						title: "让 AI 看现在的屏幕",
						onClick: function () { lookAtScreenNow(""); },
					}, "\ud83d\udcf7"),
					H("button", {
						title: "微信模式设置",
						onClick: function () { setPanel(panel === "settings" ? null : "settings"); },
					}, "\u2699")),
				look && look.message ? H("div", { className: "wx-fab-msg" }, look.message) : null,
				panel === "sticker" ? H(StickerPanel, { mode: "send", onClose: function () { setPanel(null); } }) : null,
				panel === "settings" ? H(SettingsPanel, { onClose: function () { setPanel(null); } }) : null);
		}

		/* 浮动工具栏必须包在错误边界里：它挂在整屏覆盖层上，
		   一旦渲染抛异常，React 会把整棵组件树卸掉 → 整个 DSH 界面白屏。
		   这是真实的故障模式（换版本时被触发过），不能省。 */
		function ToolbarSafe(props) {
			return H(WxBoundary, {
				where: "toolbar",
				title: "\u26a0 微信插件的浮动按钮出错了，已隔离（DSH 其余功能正常）。",
			}, H(Toolbar, props));
		}

		/* ============================ 挂载 ============================ */

		function apply(ctx) {
			ctx.effect(function () { return injectStyles(CSS); });
			startHeartbeat();
			checkHostVersion();

			var slots = ctx.get("slots");
			if (!slots) {
				console.error("[wechat-ui] slots 服务不可用，微信气泡未接管（DSH 其余功能不受影响）");
				return;
			}

			/* priority: -1 —— 官方全用默认 0，数字最小者渲染 */
			slots.inject("conversation.chat.node", function () {
				return slots.register({ name: "conversation.chat.node", key: "user", priority: -1 }, WxUserBubble);
			});
			slots.inject("conversation.chat.node", function () {
				return slots.register({ name: "conversation.chat.node", key: "assistant-step", priority: -1 }, WxAssistantBubble);
			});

			/* 浮动工具栏：挂在整屏覆盖层（list 槽，加一个 id 就是新增，不动别人）
			   注意注册的是 ToolbarSafe（带错误边界），不是 Toolbar 本身 */
			slots.inject("shell.overlay", function () {
				return slots.register({ name: "shell.overlay", id: "wechat-ui-toolbar", order: 60 }, ToolbarSafe);
			});
		}

		exports.name = "wechat-ui";
		exports.inject = ["slots"];
		exports.apply = apply;
		/* 仅供离线测试调用；不参与运行时逻辑，宿主/浏览器都不会读它 */
		exports.__test = {
			pickSticker: pickSticker,
			explicitSticker: explicitSticker,
			makeLabels: makeLabels,
			isNextOnly: isNextOnly,
			textOfContent: textOfContent,
			hashStr: hashStr,
			/* 给离线测试直接渲染用：设置面板里 hooks 最多，渲染一次能抓出 hooks 顺序错误 */
			SettingsPanel: SettingsPanel,
			updateSetting: updateSetting,
			StickerLibraryPanel: StickerLibraryPanel,
			CLIENT_VERSION: CLIENT_VERSION,
		};
		return module.exports;
	}
});
