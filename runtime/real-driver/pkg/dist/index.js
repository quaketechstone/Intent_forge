// WebRTC 即时沟通 v1.2.0 · id=org.quake.webrtc.im
// 入口 src/index.js → index.js
// 本文件由 mother-driver-sdk 的 sdk-build 拼接生成，请勿手工编辑。
// 产物必须自包含：无裸模块 import、无动态 import、无 re-export。
// ── ctx-bridge.js ──────────────────────────────────────────────
/**
 * ctx-bridge.js —— 把母体注入的 ctx 收敛成引擎能用的形态
 *
 * 只做三件事：
 *   1. 日志：统一前缀，吞掉异常（日志失败不该影响业务）；
 *   2. 存储：zsjws 原来用 localStorage（同步），这里换成 ctx.kv（异步）的同步镜像；
 *   3. 清理：所有 disposer 登记到一处，卸载时逐个执行，单个抛错不影响其余。
 *
 * 不做：网络直连（WS 在 engine 层，HTTP 走 ctx.http）、DOM（在 launcher/layer）。
 */

const MEM = () => new Map()

/**
 * 同步镜像存储：读走内存，写回 kv。
 * zsjws 的身份模块是同步调用（localStorage.getItem），不能直接改成 await，
 * 所以在 mount 阶段先把用到的键预热进内存，之后读写都是同步的。
 */
function createStorage(kv) {
  const mem = MEM()
  let kvUsable = Boolean(kv)

  const write = (key, value) => {
    if (!kvUsable) return
    try {
      const p = value === null ? kv.del(key) : kv.put(key, value)
      if (p && typeof p.catch === 'function') p.catch(() => { kvUsable = false })
    } catch (_) {
      kvUsable = false
    }
  }

  return {
    /** 预热：把关心的键读进内存。kv 不可用时静默降级为纯内存。 */
    async preload(keys) {
      if (!kvUsable) return
      for (const k of keys) {
        try {
          const v = await kv.get(k)
          if (v !== null && v !== undefined) mem.set(k, v)
        } catch (_) {
          kvUsable = false
          return
        }
      }
    },
    /**
     * 全量预热：不硬编码键名，直接按 kv 的命名空间列举。
     * 引擎的身份模块是同步读（localStorage 时代的写法），必须先把键灌进内存，
     * 否则卸载再装载会换一个新身份。
     */
    async preloadAll() {
      if (!kvUsable || typeof kv.list !== 'function') return
      let keys = []
      try {
        keys = await kv.list('')
      } catch (_) {
        kvUsable = false
        return
      }
      if (!Array.isArray(keys)) return
      // 只预热本驱动会写的那一小撮键，避免把整个命名空间搬进内存
      const mine = keys.filter((k) => String(k).startsWith('zsjws_')).slice(0, 64)
      await this.preload(mine)
    },
    get(key) {
      return mem.has(key) ? mem.get(key) : null
    },
    set(key, value) {
      mem.set(key, value)
      write(key, value)
    },
    remove(key) {
      mem.delete(key)
      write(key, null)
    },
    /** 诊断用：kv 是否真的可用。 */
    persistent: () => kvUsable,
  }
}

/** 总线未装配（fail-closed 桩）时抛的错误码；不是"没有 bus 字段"。 */
const BUS_NOT_READY = 'BUS_NOT_READY'

function busCodeOf(e) {
  if (e && typeof e === 'object' && typeof e.code === 'string') return e.code
  return 'BUS_UNKNOWN'
}

function busMessageOf(e) {
  if (e && typeof e === 'object' && typeof e.message === 'string') return e.message
  return String(e)
}

/**
 * 总线端口（I-2）——把 `ctx.bus` 收敛成**永不向 UI 抛错**的惰性句柄。
 *
 * 判据（D-R1）：母体里 `ctx.bus` **恒存在**；未装配时是 fail-closed 桩，
 * 调用会同步抛 `BUS_NOT_READY`。所以这里**不拿 `if (!bus)` 当降级判据**
 * ——那个分支永不成立，是死代码。状态由**调用时的错误码**决定：
 *
 *   unknown     拿到了句柄，还没调用过（无法据此断言可用）
 *   ready       最近一次调用成功
 *   unavailable 抛 BUS_NOT_READY（总线未装配 / 已关闭）
 *   denied      抛 BUS_DENIED（授权表没放行）
 *   error       其它错误码（契约错、背压、处理器异常…）
 *   absent      更旧的母体没有 bus 字段（兼容分支，行为同桩：不抛、返回空）
 *
 * 不做：不重试、不排队、不代驱动决定"没总线时业务怎么办"。
 * 业务降级由调用方按 `busState` 自己决定，端口只保证**不炸**。
 */
function createBusPort(ctx, log) {
  const rawBus = ctx && ctx.bus && typeof ctx.bus === 'object' ? ctx.bus : null
  const offs = new Set()
  let state = rawBus ? 'unknown' : 'absent'
  let last = null

  const note = (e) => {
    const code = busCodeOf(e)
    const message = busMessageOf(e)
    last = { code, message }
    state = code === BUS_NOT_READY ? 'unavailable' : code === 'BUS_DENIED' ? 'denied' : 'error'
    log(`总线调用失败（${code}）：${message}`)
    return code
  }

  const subscribe = (topic, fn) => {
    if (typeof topic !== 'string' || typeof fn !== 'function') return () => {}
    if (!rawBus || typeof rawBus.subscribe !== 'function') {
      state = 'absent'
      return () => {}
    }
    try {
      const off = rawBus.subscribe(topic, fn)
      state = 'ready'
      let released = false
      const release = () => {
        if (released) return
        released = true
        offs.delete(release)
        try {
          if (typeof off === 'function') off()
        } catch (e) {
          // 退订失败不影响卸载：总线侧可能已经先关了
          log(`退订失败（已吞掉）：${busMessageOf(e)}`)
        }
      }
      offs.add(release)
      return release
    } catch (e) {
      note(e)
      return () => {}
    }
  }

  const publish = (topic, payload) => {
    if (typeof topic !== 'string') return false
    if (!rawBus || typeof rawBus.publish !== 'function') {
      state = 'absent'
      return false
    }
    try {
      rawBus.publish(topic, payload)
      state = 'ready'
      return true
    } catch (e) {
      note(e)
      return false
    }
  }

  /** 退订全部（I-3）：幂等，单个失败不影响其余。 */
  const offAll = () => {
    for (const release of [...offs]) release()
    offs.clear()
  }

  return {
    subscribe,
    publish,
    offAll,
    state: () => state,
    lastError: () => last,
    /** 句柄是否存在（诊断用；**不是**可用性判据）。 */
    attached: () => Boolean(rawBus),
  }
}

/**
 * @param {object} ctx 母体上下文（可能缺字段，一律判空）
 * @param {string} id  驱动 id
 */
function createBridge(ctx, id) {
  const c = ctx || {}
  const disposers = []
  let disposed = false

  const log = (msg) => {
    try {
      if (typeof c.log === 'function') c.log(`[${id}] ${msg}`)
    } catch (_) { /* 日志失败不影响业务 */ }
  }

  const storage = createStorage(c.kv || null)
  const bus = createBusPort(c, log)

  const bridge = {
    id,
    log,
    storage,
    persistent: storage.persistent,
    /** ctx.http 是能力代理；未声明能力时为 undefined，这里返回 null 让调用方给出可行动提示。 */
    http: typeof c.http === 'function' ? c.http : null,
    hostVersion: c.hostVersion || null,
    form: c.form || null,
    /** 总线句柄（I-2）：subscribe / publish / state / lastError / offAll。 */
    bus,
    /** 诊断快捷方式（I-4）：等价于 bus.state()。 */
    busState: () => bus.state(),

    /** 登记清理；返回取消函数。 */
    onDispose(fn) {
      if (typeof fn !== 'function') return () => {}
      const entry = () => {
        try {
          fn()
        } catch (e) {
          log(`disposer 抛错（已吞掉）：${e && e.message ? e.message : e}`)
        }
      }
      disposers.push(entry)
      // 同时登记到母体；母体销毁时会再执行一次，靠 disposed 幂等兜住
      try {
        if (typeof c.onDispose === 'function') c.onDispose(entry)
      } catch (_) { /* 旧母体没有 onDispose */ }
      return () => {
        const i = disposers.indexOf(entry)
        if (i >= 0) disposers.splice(i, 1)
      }
    },

    /** 卸载时由驱动自己调用；幂等。 */
    disposeAll() {
      if (disposed) return
      disposed = true
      // 先退订（I-3）：订阅挂在总线上，比 DOM 更"远端"。
      // 先撤可避免清理期还收到事件；单个退订失败不影响后续清理。
      try {
        bus.offAll()
      } catch (_) { /* 总线已关时退订会抛，忽略 */ }
      while (disposers.length) {
        const fn = disposers.pop()
        fn()
      }
    },

    isDisposed: () => disposed,
  }

  return bridge
}

// ── im-bus.js ──────────────────────────────────────────────
/**
 * im-bus.js —— IM 业务路径的总线同步（**已就绪、未获授权时自动降级**）
 *
 * ## 定位
 *
 * `ctx-bridge` 提供的是**端口**（能调、不炸）；本模块是**业务用法**：
 * 真正订阅 `im:session`、真正发布 `im:state`。两者分开，是为了让"驱动会不会用总线"
 * 与"驱动有没有资格用总线"成为两件事——后者由总线裁决，驱动无权自证。
 *
 * ## 激活判据（唯一一条）
 *
 * **订阅是否被总线接受**。不看 `if (!bus)`（母体里 `ctx.bus` 恒存在，那是死代码），
 * 也不看清单里有没有写声明（声明是申请，不是授权）。所以：
 *
 *   订阅成功  → active   ：此后状态变化才发布
 *   BUS_DENIED → denied  ：**不发布**、不重试、不再尝试（一次申请，一次结论）
 *   BUS_NOT_READY → unavailable：同上
 *   其它错误   → error    ：同上
 *
 * 这条判据使"审批前"与"审批后"跑的是**同一份代码**：审批前订阅被拒 → 静默降级；
 * 审批后（声明生效 + builtin 装载）订阅成功 → 同一行代码开始发布。
 * 不需要翻开关，也不存在"开关忘了翻"的状态。
 *
 * ## 主题与信封
 *
 * `im:session`（收）/ `im:state`（发）。两个主题的归属见 U-3（**未确认**：
 * 本驱动假定 `im:` 归 `org.quake.webrtc.im`）。发布用 `publish(topic, payload)`，
 * 信封由总线构造；订阅回调收到的是 `BusEvent`（`{topic, from, payload, ts}`），
 * **不是** `Envelope`——按信封形状校验会一律判非法（实测）。
 *
 * `ts` 用驱动本地时钟，**仅用于同端排序**（B2：不作为跨端时序或防伪依据）。
 *
 * ## 不做
 *
 * 不重试、不排队、不缓存待发消息。总线不可用时业务照常本地运行（D-R6：总线是控制面，
 * 不该绑架数据面）；恢复要靠重新装载，而不是驱动自己造一套重连。
 */

/** 主题常量：收/发各一。改名等于改契约，需同步 U-3 归属确认。 */
const IM_TOPICS = Object.freeze({
  session: 'im:session',
  state: 'im:state',
})

/** `im:session` 的载荷形状提案（`im/session-event@0`）。未定稿，收到未知形状一律丢弃。 */
const SESSION_ACTIONS = ['announce', 'leave']

/** 信封 id：优先用 crypto.randomUUID，非安全上下文回退到 getRandomValues，再回退到时间戳。 */
function newEnvelopeId() {
  try {
    const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null
    if (c && typeof c.randomUUID === 'function') return c.randomUUID()
    if (c && typeof c.getRandomValues === 'function') {
      const b = new Uint8Array(16)
      c.getRandomValues(b)
      b[6] = (b[6] & 0x0f) | 0x40
      b[8] = (b[8] & 0x3f) | 0x80
      const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    }
  } catch (_) { /* 环境没有 crypto：退到时间戳，仅用于本地诊断 */ }
  return `im-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 入站事件的最小校验：只认自己声明过的主题与形状，其余丢弃（不抛给调用方）。
 *
 * 注意契约形状：订阅回调收到的是 **`BusEvent`**（`{topic, from, payload, ts}`），
 * **不是** `Envelope`。信封（`v`/`id`/`kind`/`corr`…）是总线内部结构，出站投递时
 * 被裁成事件视图。按 `Envelope` 校验会一律判非法——这条是实测踩出来的，不是推断。
 */
function readSession(ev) {
  if (!ev || typeof ev !== 'object') return null
  if (ev.topic !== IM_TOPICS.session) return null
  const p = ev.payload
  if (!p || typeof p !== 'object') return null
  if (!SESSION_ACTIONS.includes(p.action)) return null
  if (typeof p.peerId !== 'string' || p.peerId.length === 0) return null
  return {
    action: p.action,
    peerId: p.peerId,
    name: typeof p.name === 'string' ? p.name : null,
    room: typeof p.room === 'string' ? p.room : null,
    at: typeof ev.ts === 'number' ? ev.ts : null,
    // 归属：这条消息是"谁发的"由总线写入，驱动只记录不解释
    from: typeof ev.from === 'string' ? ev.from : null,
  }
}

/**
 * @param {object} input
 * @param {object} input.bus      `ctx-bridge` 的 bus 端口（subscribe/publish/state/offAll）
 * @param {() => object} input.snapshot 业务状态快照（发布用；返回值须可 JSON 序列化）
 * @param {(msg: string) => void} [input.log]
 * @param {(s: object) => void} [input.onSession] 收到对端会话事件时的回调（可选）
 */
function createImBusSync({ bus, snapshot, log, onSession }) {
  const say = typeof log === 'function' ? log : () => {}
  const sessions = new Map()
  let off = null
  let status = 'idle'
  let lastPublished = null
  let publishCount = 0
  let rejectedCount = 0
  let lastError = null

  const record = (s) => {
    if (s.action === 'leave') sessions.delete(s.peerId)
    else sessions.set(s.peerId, s)
    if (typeof onSession === 'function') {
      try { onSession(s) } catch (e) { say(`会话回调抛错（已吞掉）：${e && e.message ? e.message : e}`) }
    }
  }

  const handler = (ev) => {
    const s = readSession(ev)
    if (!s) {
      rejectedCount += 1
      return
    }
    record(s)
  }

  /** 发布当前快照；与上次相同则不发（去重即限流，不用定时器，卸载不留挂起任务）。 */
  const flush = () => {
    if (status !== 'active') return false
    let body
    try {
      body = JSON.stringify(snapshot())
    } catch (e) {
      say(`快照不可序列化（已跳过本次发布）：${e && e.message ? e.message : e}`)
      return false
    }
    if (body === lastPublished) return false
    const ok = bus.publish(IM_TOPICS.state, JSON.parse(body))
    if (ok) {
      lastPublished = body
      publishCount += 1
    } else {
      // 端口已经把错误码记进 lastError；这里只同步本模块状态
      const le = typeof bus.lastError === 'function' ? bus.lastError() : null
      lastError = le
      status = le && le.code === 'BUS_DENIED' ? 'denied' : le && le.code === 'BUS_NOT_READY' ? 'unavailable' : 'error'
    }
    return ok
  }

  /**
   * 申请一次订阅。**只申请一次**：被拒就停在 denied，不重试——
   * 重试会把"权限问题"伪装成"网络抖动"，让人永远查不到根因。
   */
  const attach = () => {
    if (status === 'active' || status === 'denied' || status === 'unavailable') return status
    if (bus.state() === 'absent') {
      status = 'absent'
      return status
    }
    off = bus.subscribe(IM_TOPICS.session, handler)
    const s = bus.state()
    if (s === 'ready') {
      status = 'active'
      say(`总线同步已启用（${IM_TOPICS.session} → ${IM_TOPICS.state}）`)
      flush()
    } else {
      status = s === 'unknown' ? 'error' : s
      lastError = typeof bus.lastError === 'function' ? bus.lastError() : null
      say(`总线同步未启用（${status}${lastError && lastError.code ? ` / ${lastError.code}` : ''}）：业务转本地模式`)
    }
    return status
  }

  /** 业务状态变化后调用；未激活时是 no-op（不是"攒着等连上"）。 */
  const notify = () => flush()

  const detach = () => {
    if (typeof off === 'function') {
      try { off() } catch (_) { /* 退订失败不影响卸载 */ }
    }
    off = null
    if (status === 'active') status = 'idle'
    lastPublished = null
  }

  return {
    attach,
    notify,
    detach,
    /** active / denied / unavailable / error / absent / idle */
    status: () => status,
    lastError: () => lastError,
    /** 收到的对端会话（按 peerId 去重，leave 即移除）。 */
    sessions: () => [...sessions.values()],
    stats: () => ({ published: publishCount, rejectedInbound: rejectedCount, sessions: sessions.size }),
  }
}

// ── launcher.js ──────────────────────────────────────────────
/**
 * launcher.js —— 槽位里的几何图标按钮（折叠态）
 *
 * 契约：驱动在槽位里只占一个按钮的位置。业务 UI 不在这里，点击后由 layer.js 展开。
 * 图标是几何的：六边形外框 + 中心节点 + 三条连线（网状通信的抽象），不画具体聊天气泡。
 */

const ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none"
  stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true">
  <path d="M12 2.6 20.1 7.3v9.4L12 21.4 3.9 16.7V7.3z"/>
  <circle cx="12" cy="12" r="2.1"/>
  <path d="M12 9.9V4.6M10.2 13.1 5.9 15.6M13.8 13.1l4.3 2.5"/>
</svg>`

/**
 * @param {Document} doc
 * @param {string} id 驱动 id（写进 data-module）
 * @param {() => void} onOpen
 */
function createLauncher(doc, id, onOpen) {
  const btn = doc.createElement('button')
  btn.setAttribute('type', 'button')
  btn.setAttribute('class', 'wim-launcher')
  btn.setAttribute('data-module', id)
  btn.setAttribute('data-wim-launcher', '')
  btn.setAttribute('aria-label', '打开即时沟通')
  btn.setAttribute('title', '即时沟通')
  btn.innerHTML = ICON

  const badge = doc.createElement('span')
  badge.setAttribute('class', 'wim-badge')
  badge.setAttribute('data-wim-badge', '')
  badge.setAttribute('hidden', '')
  badge.textContent = '0'
  btn.appendChild(badge)

  const onClick = (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault()
    onOpen()
  }
  btn.addEventListener('click', onClick)

  return {
    el: btn,
    /** 在线人数角标；0 或负数时隐藏。 */
    setBadge(n) {
      const v = Number(n) || 0
      if (v > 0) {
        badge.textContent = String(v)
        badge.removeAttribute('hidden')
      } else {
        badge.setAttribute('hidden', '')
      }
    },
    dispose() {
      btn.removeEventListener('click', onClick)
      if (btn.parentNode) btn.parentNode.removeChild(btn)
    },
  }
}

// ── layer.js ──────────────────────────────────────────────
/**
 * layer.js —— 槽位内的展开层（视觉全屏）
 *
 * 关键约束（SDK 宪法第 10 条 + 契约 L13）：驱动只能向**已授予的槽位**渲染。
 * 因此这一层是槽位的子节点，靠 `position: fixed` 铺满视口，
 * 而不是 `document.body.appendChild`。卸载时随根节点一起消失，不留痕。
 */

const EDGE_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
  <path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

function createLayer(doc, id, onClose) {
  const layer = doc.createElement('div')
  layer.setAttribute('class', 'wim-layer')
  layer.setAttribute('data-module', id)
  layer.setAttribute('data-wim-layer', '')
  layer.setAttribute('role', 'dialog')
  layer.setAttribute('aria-modal', 'true')
  layer.setAttribute('aria-label', '即时沟通')
  layer.setAttribute('tabindex', '-1')
  layer.setAttribute('hidden', '')

  const panel = doc.createElement('div')
  panel.setAttribute('class', 'wim-panel')
  panel.setAttribute('data-wim-panel', '')

  const head = doc.createElement('div')
  head.setAttribute('class', 'wim-panel-head')

  const title = doc.createElement('span')
  title.setAttribute('class', 'wim-panel-title')
  title.textContent = '即时沟通'

  const sub = doc.createElement('span')
  sub.setAttribute('class', 'wim-panel-sub')
  sub.setAttribute('data-wim-status', '')
  sub.textContent = '未连接'

  const closeBtn = doc.createElement('button')
  closeBtn.setAttribute('type', 'button')
  closeBtn.setAttribute('class', 'wim-close')
  closeBtn.setAttribute('data-wim-close', '')
  closeBtn.setAttribute('aria-label', '关闭')
  closeBtn.textContent = '×'

  const body = doc.createElement('div')
  body.setAttribute('class', 'wim-panel-body')
  body.setAttribute('data-wim-body', '')
  body.textContent = '业务界面接入中'

  /**
   * 业务界面是 `position:fixed; inset:0` 的全屏壳（业务自己的形态，不去改它），
   * 一旦挂进来就会盖住本层的标题栏 —— 那样用户除了 Esc 就没有可见的退出入口。
   * 所以业务挂载后本层转为「bare」：收起标题栏，只留一枚贴左边的半透明收起把手。
   * 把手不占布局、不吃业务的内容区，且始终在业务壳之上。
   */
  const edge = doc.createElement('button')
  edge.setAttribute('type', 'button')
  edge.setAttribute('class', 'wim-edge')
  edge.setAttribute('data-wim-close', '')
  edge.setAttribute('aria-label', '收起即时沟通')
  edge.setAttribute('title', '收起')
  edge.innerHTML = EDGE_ICON

  head.appendChild(title)
  head.appendChild(sub)
  head.appendChild(closeBtn)
  panel.appendChild(head)
  panel.appendChild(body)
  layer.appendChild(panel)
  layer.appendChild(edge)

  let open = false
  let bare = false
  const ownerDoc = doc

  const onKey = (e) => {
    if (open && (e.key === 'Escape' || e.key === 'Esc')) {
      if (typeof e.preventDefault === 'function') e.preventDefault()
      close()
    }
  }
  const onBackdrop = (e) => {
    if (e && e.target === layer) close()
  }
  closeBtn.addEventListener('click', () => close())
  edge.addEventListener('click', () => close())
  layer.addEventListener('keydown', onKey)
  layer.addEventListener('click', onBackdrop)

  function openLayer() {
    if (open) return
    open = true
    layer.removeAttribute('hidden')
    // Esc 要能随时收起：业务界面自己会抢焦点，键盘事件不一定落到本层上，
    // 所以开着的时候在文档级挂一份，收起时立刻摘掉（不在宿主上留监听）。
    if (ownerDoc && typeof ownerDoc.addEventListener === 'function') {
      ownerDoc.addEventListener('keydown', onKey)
    }
    try { layer.focus() } catch (_) { /* 某些环境不支持 focus */ }
  }

  function close() {
    if (!open) return
    open = false
    layer.setAttribute('hidden', '')
    if (ownerDoc && typeof ownerDoc.removeEventListener === 'function') {
      ownerDoc.removeEventListener('keydown', onKey)
    }
    if (typeof onClose === 'function') onClose()
  }

  return {
    el: layer,
    body,
    open: openLayer,
    close,
    isOpen: () => open,
    setStatus(text) {
      const v = String(text == null ? '' : text)
      sub.textContent = v
      // 空文本时不占位，宿主条退化为「标题 + 关闭」
      if (v) sub.removeAttribute('hidden')
      else sub.setAttribute('hidden', '')
    },
    /**
     * 业务界面挂载后调用：收起标题栏，只留左边那枚收起把手。
     * 全屏是业务定的形态，驱动不去压缩它，只保证「进得来、出得去」。
     */
    setBare(on) {
      bare = Boolean(on)
      if (bare) panel.setAttribute('class', 'wim-panel wim-panel-bare')
      else panel.setAttribute('class', 'wim-panel')
    },
    setBody(node) {
      while (body.firstChild) body.removeChild(body.firstChild)
      if (node) body.appendChild(node)
    },
    dispose() {
      open = false
      closeBtn.removeEventListener('click', close)
      edge.removeEventListener('click', close)
      layer.removeEventListener('keydown', onKey)
      layer.removeEventListener('click', onBackdrop)
      if (ownerDoc && typeof ownerDoc.removeEventListener === 'function') {
        ownerDoc.removeEventListener('keydown', onKey)
      }
      if (layer.parentNode) layer.parentNode.removeChild(layer)
    },
  }
}

// ── ui/css.generated.js ──────────────────────────────────────────────
/**
 * css.generated.js —— 由 scripts/scope-css.mjs 生成，请勿手改
 * 来源：zsjws@3b57750 的 wa-ui.css / call-layer.css / beauty-panel.css
 * 处理：所有选择器限定在 .wim-root 子树内，:root 变量块改为 .wim-root
 */
const UI_CSS = "/* ===== wa-ui.css（zsjws@3b57750，作用域化） ===== */\n/* ============================================================\n * wa-ui.css — WhatsApp Web 视觉层（WDS token 移植）\n * 来源：wa-ui/components/ui/whatsapp/styles/whatsapp.css\n * 处理：移除 @theme inline（Tailwind 4 语法）；补中文字体栈；\n *       去壁纸（--wa-wallpaper-image），改用纯色 + 极淡噪点。\n * 冻结：媒体层样式在 call-layer.css，不要合并进来。\n * ============================================================ */\n\n\n@keyframes wa-typing-bounce {\n  0%,\n  60%,\n  100% {\n    transform: translateY(0);\n  }\n  30% {\n    transform: translateY(-4px);\n  }\n}\n\n\n.wim-root{\n  /* === Typography（补中文栈；原 wa-ui 只有西文） === */\n  --font-wa: \"Segoe UI\", \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\",\n    \"Noto Sans CJK SC\", \"Apple Color Emoji\", \"Segoe UI Emoji\", \"Noto Color Emoji\",\n    \"Helvetica Neue\", Helvetica, Arial, Ubuntu, sans-serif;\n\n  /* === Primary Brand Colors === */\n  --wa-green-50: #f2fdf0;\n  --wa-green-75: #e7fce3;\n  --wa-green-100: #d9fdd3;\n  --wa-green-200: #acfcac;\n  --wa-green-300: #71eb85;\n  --wa-green-400: #25d366;\n  --wa-green-450: #21c063;\n  --wa-green-500: #1daa61;\n  --wa-green-600: #1b8755;\n  --wa-green-700: #15603e;\n  --wa-green-750: #144d37;\n  --wa-green-800: #103529;\n\n  /* === Emerald (Teal) === */\n  --wa-emerald-400: #06cf9c;\n  --wa-emerald-500: #00a884;\n  --wa-emerald-600: #008069;\n\n  /* === Neutral Gray === */\n  --wa-gray-50: #fafafa;\n  --wa-gray-75: #f4f4f4;\n  --wa-gray-100: #eeeeee;\n  --wa-gray-200: #d8d8d8;\n  --wa-gray-300: #bdbdbd;\n  --wa-gray-400: #959393;\n  --wa-gray-500: #757778;\n  --wa-gray-600: #606263;\n  --wa-gray-700: #424445;\n  --wa-gray-800: #242626;\n  --wa-gray-850: #1d1f1f;\n  --wa-gray-900: #161717;\n  --wa-gray-1000: #0a0a0a;\n\n  /* === Sky Blue (Read Receipts) === */\n  --wa-sky-blue-300: #53bdeb;\n  --wa-sky-blue-400: #009de2;\n\n  /* === Red (Destructive/Negative) === */\n  --wa-red-300: #fb5061;\n  --wa-red-400: #f53947;\n\n  /* === Cobalt === */\n  --wa-cobalt-300: #53a6fd;\n  --wa-cobalt-400: #007bfc;\n\n  /* === Persistent/Brand === */\n  --wa-verified: #0085f4;\n  --wa-always-white: #ffffff;\n  --wa-always-black: #000000;\n\n  /* === Profile Photo Avatars === */\n  --wa-avatar-brown: #dba685;\n  --wa-avatar-cobalt: #53a6fd;\n  --wa-avatar-green: #25d366;\n  --wa-avatar-orange: #fc9775;\n  --wa-avatar-pink: #ff72a1;\n  --wa-avatar-purple: #a791ff;\n  --wa-avatar-red: #fb5061;\n  --wa-avatar-sky-blue: #53bdeb;\n  --wa-avatar-teal: #42c7b8;\n  --wa-avatar-yellow: #ffd279;\n}\n\n\n/* === Light Mode (WhatsApp Default) === */\n.wim-root, .wim-root [data-theme=\"light\"]{\n  /* Surfaces */\n  --wa-bg: #ffffff;\n  --wa-bg-deeper: #f0f2f5;\n  --wa-bg-wash: #f7f8fa;\n  --wa-panel-bg: #ffffff;\n  --wa-panel-header-bg: #ffffff;\n  --wa-conversation-bg: #f5f0e8;\n  --wa-compose-bg: #f0f2f5;\n\n  /* Content */\n  --wa-text-primary: #111b21;\n  --wa-text-secondary: #667781;\n  --wa-text-deemphasized: rgba(17, 27, 33, 0.4);\n\n  /* Chat Bubbles */\n  --wa-bubble-outgoing: #e7ffdb;\n  --wa-bubble-incoming: #ffffff;\n  --wa-bubble-system: #ffecd2;\n  --wa-bubble-radius: 7.5px;\n  --wa-bubble-meta: rgba(17, 27, 33, 0.45);\n\n  /* Lines */\n  --wa-border: #e9edef;\n  --wa-divider: rgba(134, 150, 160, 0.15);\n\n  /* Interactive */\n  --wa-primary: #008069;\n  --wa-primary-hover: #017561;\n  --wa-icon-default: #54656f;\n  --wa-icon-lighter: #8696a0;\n  --wa-hover: rgba(17, 27, 33, 0.05);\n  --wa-active: rgba(17, 27, 33, 0.1);\n\n  /* Read Receipts */\n  --wa-read: #53bdeb;\n  --wa-delivered: #8696a0;\n\n  /* Misc */\n  --wa-unread-marker: #25d366;\n  --wa-typing-dot: #8696a0;\n  --wa-input-bg: #ffffff;\n  --wa-input-border: #e4e6eb;\n\n  /* Chat Wallpaper */\n  --wa-wallpaper-bg: #f5f0e8;\n  --wa-wallpaper-fg: rgba(17, 27, 33, 0.05);\n  --wa-wallpaper-tint: rgba(229, 221, 213, 0.85);\n\n  /* Template header placeholder */\n  --wa-placeholder-bg: #ccd0d5;\n  --wa-placeholder-icon: brightness(0) saturate(100%) invert(42%) sepia(9%) saturate(621%) hue-rotate(155deg) brightness(94%) contrast(87%);\n\n  /* Template button icon — converts PNG to wa-emerald-500 (#00a884) */\n  --wa-btn-icon-filter: brightness(0) saturate(100%) invert(50%) sepia(97%) saturate(372%) hue-rotate(128deg) brightness(97%);\n\n  /* === Additional Color Scales === */\n  --wa-teal-300: #42c7b8;\n  --wa-teal-400: #02a698;\n  --wa-teal-500: #028377;\n\n  --wa-purple-300: #a791ff;\n  --wa-purple-400: #7f66ff;\n\n  --wa-orange-300: #fc9775;\n  --wa-orange-400: #fa6533;\n\n  --wa-yellow-300: #ffd279;\n  --wa-yellow-400: #ffb938;\n\n  --wa-pink-300: #ff72a1;\n  --wa-pink-400: #ff2e74;\n\n  /* === Attachment Type Colors === */\n  --wa-attachment-document: #7f66ff;\n  --wa-attachment-audio: #fa6533;\n  --wa-attachment-photo: #007bfc;\n  --wa-attachment-contact: #009de2;\n  --wa-attachment-camera: #ff2e74;\n  --wa-attachment-sticker: #02a698;\n  --wa-attachment-poll: #ffbc38;\n  --wa-attachment-catalog: #3a5564;\n\n  /* === Semantic Text === */\n  --wa-text-disabled: #d1d7db;\n  --wa-text-critical: #ea0038;\n  --wa-text-success: #1fa855;\n  --wa-text-action: #008069;\n  --wa-system-msg: #54656f;\n  --wa-primary-title: #41525d;\n\n  /* === Shadows === */\n  --wa-shadow-light: rgba(11, 20, 26, .08);\n  --wa-shadow-medium: rgba(11, 20, 26, .15);\n  --wa-border-bubble: rgba(17, 27, 33, .06);\n\n  /* === Button States === */\n  --wa-button-primary-hover: #017561;\n  --wa-filter-text: #54656f;\n  --wa-filter-active: #008069;\n  --wa-filter-bg-active: #d9fdd3;\n\n  /* === Spacing === */\n  --wa-text-size-small: 12.6px;\n  --wa-bubble-padding-start: 9px;\n  --wa-bubble-padding-end: 7px;\n}\n\n\n/* === Dark Mode === */\n.wim-root [data-theme=\"dark\"], .wim-root .dark{\n  /* Surfaces */\n  --wa-bg: #111b21;\n  --wa-bg-deeper: #0b141a;\n  --wa-bg-wash: #161717;\n  --wa-panel-bg: #111b21;\n  --wa-panel-header-bg: #202c33;\n  --wa-conversation-bg: #0b141a;\n  --wa-compose-bg: #202c33;\n\n  /* Content */\n  --wa-text-primary: #e9edef;\n  --wa-text-secondary: #8696a0;\n  --wa-text-deemphasized: rgba(233, 237, 239, 0.4);\n\n  /* Chat Bubbles */\n  --wa-bubble-outgoing: #005c4b;\n  --wa-bubble-incoming: #202c33;\n  --wa-bubble-system: #182229;\n  --wa-bubble-meta: rgba(255, 255, 255, 0.6);\n\n  /* Lines */\n  --wa-border: rgba(233, 237, 239, 0.12);\n  --wa-divider: rgba(134, 150, 160, 0.15);\n\n  /* Interactive */\n  --wa-primary: #00a884;\n  --wa-primary-hover: #06cf9c;\n  --wa-icon-default: #aebac1;\n  --wa-icon-lighter: #8696a0;\n  --wa-hover: rgba(233, 237, 239, 0.05);\n  --wa-active: rgba(233, 237, 239, 0.1);\n\n  /* Read Receipts */\n  --wa-read: #53bdeb;\n  --wa-delivered: #aebac1;\n\n  /* Misc */\n  --wa-unread-marker: #00a884;\n  --wa-typing-dot: #8696a0;\n  --wa-input-bg: #2a3942;\n  --wa-input-border: rgba(233, 237, 239, 0.12);\n\n  /* Chat Wallpaper */\n  --wa-wallpaper-bg: #0b141a;\n  --wa-wallpaper-fg: rgba(255, 255, 255, 0.06);\n  --wa-wallpaper-tint: rgba(11, 20, 26, 0.88);\n\n  /* Template header placeholder */\n  --wa-placeholder-bg: #2a3942;\n  --wa-placeholder-icon: brightness(0) saturate(100%) invert(62%) sepia(10%) saturate(400%) hue-rotate(155deg) brightness(95%) contrast(85%);\n\n  /* Template button icon — converts PNG to wa-emerald-400 (#06cf9c) */\n  --wa-btn-icon-filter: brightness(0) saturate(100%) invert(68%) sepia(60%) saturate(400%) hue-rotate(118deg) brightness(100%);\n\n  /* === Semantic Text (dark) === */\n  --wa-text-disabled: #3b4a54;\n  --wa-text-critical: #ff6b7a;\n  --wa-text-success: #25d366;\n  --wa-text-action: #00a884;\n  --wa-system-msg: #8696a0;\n  --wa-primary-title: #8696a0;\n\n  /* === Shadows (dark) === */\n  --wa-shadow-light: rgba(0, 0, 0, .3);\n  --wa-shadow-medium: rgba(0, 0, 0, .4);\n  --wa-border-bubble: rgba(255, 255, 255, .06);\n\n  /* === Button States (dark) === */\n  --wa-button-primary-hover: #06cf9c;\n  --wa-filter-text: #8696a0;\n  --wa-filter-active: #00a884;\n  --wa-filter-bg-active: #005c4b;\n}\n\n\n/* === Layout Constants === */\n.wim-root{\n  --wa-sidebar-width: 440px;\n  --wa-sidebar-min-width: 340px;\n  --wa-header-height: 59px;\n  --wa-compose-height: 62px;\n  --wa-chat-spacing: 15px;\n  --wa-avatar-size-sm: 40px;\n  --wa-avatar-size-md: 49px;\n  --wa-avatar-size-lg: 200px;\n  --wa-msg-max-width: 60%;\n}\n/* ============================================================\n * 组件层 —— 按 wa-ui 的 17 个组件映射为原生 class\n * 全部使用 --wa-* token，不依赖 Tailwind。\n * ============================================================ */\n/* ---------- 0. 基础重置（只作用于 .wa-* 内部，不污染媒体层） ---------- */\n.wim-root .wa-shell, .wim-root .wa-shell *, .wim-root .wa-gate, .wim-root .wa-gate *{\n  box-sizing: border-box;\n  -webkit-tap-highlight-color: transparent;\n}\n.wim-root .wa-shell, .wim-root .wa-gate{\n  font-family: var(--font-wa);\n  color: var(--wa-text-primary);\n  -webkit-font-smoothing: antialiased;\n}\n.wim-root .wa-shell button, .wim-root .wa-gate button{ font-family: inherit; }\n\n/* ---------- 1. 外壳布局：移动单栏 / 桌面三栏 ---------- */\n.wim-root .wa-shell{\n  position: fixed;\n  inset: 0;\n  display: flex;\n  background: var(--wa-bg-deeper);\n  overflow: hidden;\n}\n.wim-root .wa-sidebar{ display: none; }\n.wim-root .wa-main{\n  flex: 1;\n  min-width: 0;\n  display: flex;\n  flex-direction: column;\n  background: var(--wa-panel-bg);\n  position: relative;\n}\n\n@media (min-width: 900px) {\n  .wim-root .wa-shell{ padding: 0; }\n  .wim-root .wa-sidebar{\n    display: flex;\n    flex-direction: column;\n    width: var(--wa-sidebar-width);\n    min-width: var(--wa-sidebar-min-width);\n    background: var(--wa-panel-bg);\n    border-right: 1px solid var(--wa-border);\n    flex-shrink: 0;\n  }\n  .wim-root .wa-back{ display: none !important; }\n}\n\n/* ---------- 2. 侧栏（发现邻居 / 会话列表） ---------- */\n.wim-root .wa-side-head{\n  height: var(--wa-header-height);\n  min-height: var(--wa-header-height);\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  padding: 0 16px;\n  background: var(--wa-panel-header-bg);\n  border-bottom: 1px solid var(--wa-border);\n  flex-shrink: 0;\n}\n.wim-root .wa-side-head .wa-me{ flex: 1; min-width: 0; }\n.wim-root .wa-side-head .wa-me b{\n  display: block;\n  font-size: 15px;\n  font-weight: 600;\n  color: var(--wa-text-primary);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n.wim-root .wa-side-head .wa-me span{ font-size: 12.5px; color: var(--wa-text-secondary); }\n\n.wim-root .wa-side-body{ flex: 1; overflow-y: auto; padding: 8px 0; }\n.wim-root .wa-side-note{\n  padding: 14px 20px;\n  font-size: 12.5px;\n  line-height: 1.6;\n  color: var(--wa-text-secondary);\n  text-align: center;\n}\n.wim-root .wa-side-label{\n  padding: 10px 18px 6px;\n  font-size: 11.5px;\n  font-weight: 600;\n  letter-spacing: .04em;\n  text-transform: uppercase;\n  color: var(--wa-text-secondary);\n}\n\n/* 列表项（对应 ChatListItem） */\n.wim-root .wa-list-item{\n  display: flex;\n  align-items: center;\n  gap: 15px;\n  padding: 10px 9px;\n  margin: 0 8px;\n  border-radius: 12px;\n  cursor: pointer;\n  transition: background-color .15s;\n  border: 0;\n  width: calc(100% - 16px);\n  background: transparent;\n  text-align: left;\n}\n.wim-root .wa-list-item:hover{ background: var(--wa-hover); }\n.wim-root .wa-list-item:active{ background: var(--wa-active); }\n.wim-root .wa-list-item.sel{ background: var(--wa-active); }\n.wim-root .wa-list-item .li-body{ flex: 1; min-width: 0; }\n.wim-root .wa-list-item .li-name{\n  font-size: 17px;\n  color: var(--wa-text-primary);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n.wim-root .wa-list-item .li-sub{\n  font-size: 13.5px;\n  color: var(--wa-text-secondary);\n  margin-top: 2px;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n.wim-root .wa-list-item .li-dot{\n  width: 9px; height: 9px; border-radius: 50%;\n  background: var(--wa-unread-marker);\n  flex-shrink: 0;\n}\n.wim-root .wa-list-item .li-cta{\n  font-size: 12.5px;\n  color: var(--wa-primary);\n  font-weight: 600;\n  flex-shrink: 0;\n}\n\n/* ---------- 3. 头像 ---------- */\n.wim-root .wa-avatar{\n  border-radius: 50%;\n  flex-shrink: 0;\n  display: grid;\n  place-items: center;\n  color: #fff;\n  font-weight: 600;\n  overflow: hidden;\n  background: var(--wa-gray-300);\n  position: relative;\n}\n.wim-root .wa-avatar.sm{ width: var(--wa-avatar-size-sm); height: var(--wa-avatar-size-sm); font-size: 15px; }\n.wim-root .wa-avatar.md{ width: var(--wa-avatar-size-md); height: var(--wa-avatar-size-md); font-size: 17px; }\n.wim-root .wa-avatar img{ width: 100%; height: 100%; object-fit: cover; }\n.wim-root .wa-avatar .online{\n  position: absolute; right: 0; bottom: 1px;\n  width: 12px; height: 12px; border-radius: 50%;\n  background: var(--wa-unread-marker);\n  border: 2px solid var(--wa-panel-header-bg);\n}\n\n/* ---------- 4. 会话头部 ---------- */\n.wim-root .wa-header{\n  height: var(--wa-header-height);\n  min-height: var(--wa-header-height);\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  padding: 0 12px;\n  padding-top: env(safe-area-inset-top);\n  background: var(--wa-panel-header-bg);\n  border-bottom: 1px solid var(--wa-border);\n  flex-shrink: 0;\n  z-index: 5;\n}\n.wim-root .wa-header .hd-body{ flex: 1; min-width: 0; cursor: pointer; }\n.wim-root .wa-header .hd-name{\n  font-size: 16px;\n  font-weight: 600;\n  color: var(--wa-text-primary);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n.wim-root .wa-header .hd-status{\n  font-size: 13px;\n  color: var(--wa-text-secondary);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  margin-top: 1px;\n}\n.wim-root .wa-header .hd-status.live{ color: var(--wa-primary); }\n\n/* 图标按钮（通用） */\n.wim-root .wa-iconbtn{\n  width: 40px; height: 40px;\n  border: 0; background: transparent;\n  border-radius: 50%;\n  display: grid; place-items: center;\n  color: var(--wa-icon-default);\n  cursor: pointer;\n  flex-shrink: 0;\n  transition: background-color .15s;\n}\n.wim-root .wa-iconbtn:hover{ background: var(--wa-hover); }\n.wim-root .wa-iconbtn:active{ background: var(--wa-active); }\n.wim-root .wa-iconbtn svg{ display: block; }\n.wim-root .wa-iconbtn.danger{ color: var(--wa-text-critical); }\n\n/* ---------- 5. 消息区 ---------- */\n.wim-root .wa-wallpaper{\n  flex: 1;\n  position: relative;\n  overflow: hidden;\n  background-color: var(--wa-wallpaper-bg);\n  /* 无壁纸图：用极淡双层点阵模拟 WDS 壁纸纹理 */\n  background-image:\n    radial-gradient(circle at 0 0, var(--wa-wallpaper-fg) 0 1px, transparent 1.2px),\n    radial-gradient(circle at 12px 12px, var(--wa-wallpaper-fg) 0 1px, transparent 1.2px);\n  background-size: 24px 24px, 24px 24px;\n}\n.wim-root .wa-msgs{\n  position: absolute;\n  inset: 0;\n  overflow-y: auto;\n  overscroll-behavior: contain;\n  padding: 12px var(--wa-chat-spacing) 8px;\n  display: flex;\n  flex-direction: column;\n  scrollbar-width: thin;\n  scrollbar-color: var(--wa-border) transparent;\n}\n.wim-root .wa-msgs::-webkit-scrollbar{ width: 6px; }\n.wim-root .wa-msgs::-webkit-scrollbar-thumb{ background: var(--wa-border); border-radius: 3px; }\n.wim-root .wa-msgs > .wa-spacer{ flex: 1 0 auto; }\n\n/* 日期分隔 */\n.wim-root .wa-date{\n  align-self: center;\n  margin: 10px 0;\n  padding: 5px 12px;\n  border-radius: 8px;\n  background: var(--wa-panel-header-bg);\n  color: var(--wa-text-secondary);\n  font-size: 12.5px;\n  box-shadow: 0 1px 2px var(--wa-shadow-light);\n}\n\n/* 系统消息 */\n.wim-root .wa-system{\n  align-self: center;\n  margin: 8px 0;\n  padding: 6px 12px;\n  border-radius: 8px;\n  background: var(--wa-bubble-system);\n  color: var(--wa-system-msg);\n  font-size: 12.5px;\n  line-height: 1.5;\n  text-align: center;\n  max-width: 82%;\n  box-shadow: 0 1px 1px var(--wa-shadow-light);\n}\n\n/* ---------- 6. 气泡 ---------- */\n.wim-root .wa-row{\n  display: flex;\n  width: 100%;\n  margin-bottom: 2px;\n}\n.wim-root .wa-row.out{ justify-content: flex-end; }\n.wim-root .wa-row.tail{ margin-bottom: 6px; }\n.wim-root .wa-row.has-reaction{ margin-bottom: 24px; }\n\n.wim-root .wa-bubble{\n  position: relative;\n  min-width: 80px;\n  max-width: var(--wa-msg-max-width);\n  border-radius: var(--wa-bubble-radius);\n  padding: 6px var(--wa-bubble-padding-end) 7px var(--wa-bubble-padding-start);\n  background: var(--wa-bubble-incoming);\n  box-shadow: 0 1px .5px var(--wa-border-bubble);\n  overflow: visible;\n}\n.wim-root .wa-row.out .wa-bubble{ background: var(--wa-bubble-outgoing); }\n.wim-root .wa-row.tail.out .wa-bubble{ border-bottom-right-radius: 0; }\n.wim-root .wa-row.tail.in  .wa-bubble{ border-bottom-left-radius: 0; }\n\n.wim-root .wa-bubble .wa-text{\n  font-size: 14.2px;\n  line-height: 19px;\n  color: var(--wa-text-primary);\n  white-space: pre-wrap;\n  word-break: break-word;\n  overflow-wrap: anywhere;\n}\n.wim-root .wa-bubble .wa-text a{ color: var(--wa-text-action); text-decoration: underline; }\n\n/* 尾巴（SVG 由 JS 插入，这里只定位） */\n.wim-root .wa-tail{ position: absolute; bottom: 0; width: 8px; height: 13px; pointer-events: none; }\n.wim-root .wa-row.out .wa-tail{ right: -8px; }\n.wim-root .wa-row.in  .wa-tail{ left: -8px; }\n\n/* 群聊发送者名（1:1 不用，留位） */\n.wim-root .wa-sender{ font-size: 12.8px; font-weight: 500; line-height: 20px; margin-bottom: 1px; }\n\n/* 元信息：时间 + 状态 */\n.wim-root .wa-meta{\n  display: flex;\n  align-items: center;\n  justify-content: flex-end;\n  gap: 3px;\n  margin-top: 2px;\n  float: right;\n  margin-left: 8px;\n}\n.wim-root .wa-meta .t{ font-size: 11px; line-height: 15px; color: var(--wa-bubble-meta); }\n.wim-root .wa-status{ display: inline-flex; align-items: center; }\n.wim-root .wa-status svg{ display: block; }\n.wim-root .wa-status.sending{ color: var(--wa-bubble-meta); }\n.wim-root .wa-status.sent{ color: var(--wa-delivered); opacity: .75; }\n.wim-root .wa-status.delivered{ color: var(--wa-delivered); }\n.wim-root .wa-status.read{ color: var(--wa-read); }\n.wim-root .wa-status.failed{ color: var(--wa-text-critical); }\n\n/* 表情回应 */\n.wim-root .wa-reaction{\n  position: absolute;\n  display: flex;\n  gap: 3px;\n  bottom: -20px;\n  left: 8px;\n  z-index: 2;\n}\n.wim-root .wa-row.out .wa-reaction{ left: auto; right: 8px; bottom: -16px; }\n.wim-root .wa-reaction span{\n  background: var(--wa-panel-header-bg);\n  border: 1px solid var(--wa-border);\n  border-radius: 12px;\n  padding: 1px 6px;\n  font-size: 13px;\n  line-height: 18px;\n  box-shadow: 0 1px 2px var(--wa-shadow-light);\n}\n\n/* ---------- 7. 媒体气泡 ---------- */\n.wim-root .wa-bubble.media{\n  padding: 4px 4px 6px;\n  /* 媒体气泡比文字气泡宽（WDS: 336px），否则图片被压得太小 */\n  max-width: min(336px, 78%);\n}\n.wim-root .wa-bubble.media .wa-text{ padding: 0 5px; }\n\n/* 图片 */\n.wim-root .wa-img{\n  display: block;\n  border-radius: 6px;\n  max-width: 100%;\n  max-height: 336px;\n  object-fit: cover;\n  cursor: pointer;\n  background: var(--wa-placeholder-bg);\n}\n.wim-root .wa-img-grid{\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  gap: 2px;\n  width: 330px;\n  max-width: 100%;\n}\n.wim-root .wa-img-grid .wa-img{ width: 100%; height: 164px; }\n.wim-root .wa-img-grid.single{ grid-template-columns: 1fr; width: auto; }\n.wim-root .wa-img-grid.single .wa-img{ height: auto; max-height: 336px; }\n/* 3 张时首图跨两列（与 WhatsApp 一致），否则会出现半空的第二行 */\n.wim-root .wa-img-grid[data-n=\"3\"] .wa-img:first-child{ grid-column: span 2; height: 200px; }\n\n/* 正在输入 */\n.wim-root .wa-typing-row .wa-bubble{ padding: 9px 13px; }\n.wim-root .wa-typing{ display: flex; align-items: center; gap: 4px; height: 16px; }\n.wim-root .wa-typing i{\n  width: 7px; height: 7px; border-radius: 50%;\n  background: var(--wa-typing-dot);\n  animation: wa-typing-bounce 1.2s infinite ease-in-out;\n}\n.wim-root .wa-typing i:nth-child(2){ animation-delay: .15s; }\n.wim-root .wa-typing i:nth-child(3){ animation-delay: .3s; }\n@media (prefers-reduced-motion: reduce) {\n  .wim-root .wa-typing i{ animation: none; opacity: .6; }\n}\n.wim-root .wa-img-more{\n  position: relative;\n}\n.wim-root .wa-img-more::after{\n  content: attr(data-more);\n  position: absolute; inset: 0;\n  display: grid; place-items: center;\n  background: rgba(0,0,0,.45);\n  color: #fff; font-size: 20px; font-weight: 600;\n  border-radius: 6px;\n}\n\n/* 视频 */\n.wim-root .wa-video-wrap{ position: relative; display: inline-block; }\n.wim-root .wa-video-wrap video{ display: block; border-radius: 6px; max-width: 336px; max-height: 336px; background: #000; }\n.wim-root .wa-video-badge{\n  position: absolute; left: 8px; bottom: 8px;\n  background: rgba(0,0,0,.55); color: #fff;\n  font-size: 11.5px; padding: 1px 6px; border-radius: 10px;\n}\n\n/* 文件 */\n.wim-root .wa-file{\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  padding: 4px 2px;\n  min-width: 220px;\n}\n.wim-root .wa-file .fi{\n  width: 46px; height: 46px; border-radius: 8px;\n  display: flex; flex-direction: column; align-items: center; justify-content: center;\n  color: #fff; flex-shrink: 0;\n  background: var(--wa-attachment-document);\n}\n.wim-root .wa-file .fi span{ font-size: 8px; font-weight: 700; line-height: 1; margin-top: 1px; opacity: .9; }\n.wim-root .wa-file .fb{ flex: 1; min-width: 0; }\n.wim-root .wa-file .fn{\n  font-size: 14px; color: var(--wa-text-primary);\n  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\n}\n.wim-root .wa-file .fs{ font-size: 12px; color: var(--wa-text-secondary); margin-top: 1px; }\n.wim-root .wa-file .fa{\n  width: 32px; height: 32px; border-radius: 50%;\n  border: 2px solid var(--wa-primary);\n  display: grid; place-items: center;\n  color: var(--wa-primary);\n  text-decoration: none;\n  flex-shrink: 0;\n}\n.wim-root .wa-file .fa:hover{ opacity: .7; }\n.wim-root .wa-file[data-kind=\"image\"] .fi{ background: var(--wa-attachment-photo); }\n.wim-root .wa-file[data-kind=\"audio\"] .fi{ background: var(--wa-attachment-audio); }\n.wim-root .wa-file[data-kind=\"video\"] .fi{ background: var(--wa-attachment-camera); }\n\n/* 语音 */\n.wim-root .wa-voice{\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  min-width: 220px;\n  padding: 2px 0;\n}\n.wim-root .wa-voice .vp{\n  width: 34px; height: 34px; border-radius: 50%;\n  border: 0; flex-shrink: 0;\n  background: var(--wa-primary); color: #fff;\n  display: grid; place-items: center; cursor: pointer;\n}\n.wim-root .wa-voice .vw{\n  flex: 1; display: flex; align-items: center; gap: 2px; height: 26px;\n  cursor: pointer;\n}\n.wim-root .wa-voice .vw i{\n  display: block; width: 3px; border-radius: 2px;\n  background: var(--wa-icon-lighter);\n  flex-shrink: 0;\n}\n.wim-root .wa-voice .vw i.on{ background: var(--wa-primary); }\n.wim-root .wa-voice .vd{ font-size: 11px; color: var(--wa-bubble-meta); flex-shrink: 0; min-width: 30px; text-align: right; }\n\n/* 传输进度遮罩 */\n.wim-root .wa-sending-mask{\n  position: absolute; inset: 0;\n  display: grid; place-items: center;\n  background: rgba(0,0,0,.28);\n  border-radius: 6px;\n  z-index: 3;\n}\n.wim-root .wa-spin{\n  width: 40px; height: 40px;\n  border: 3px solid rgba(255,255,255,.3);\n  border-top-color: #fff;\n  border-radius: 50%;\n  animation: wa-spin .9s linear infinite;\n}\n@keyframes wa-spin { to { transform: rotate(360deg); } }\n.wim-root .wa-progress-text{\n  position: absolute; bottom: 6px; left: 0; right: 0;\n  text-align: center; color: #fff; font-size: 11px;\n}\n\n/* ---------- 8. 正在输入 ---------- */\n.wim-root .wa-typing{\n  display: inline-flex; align-items: center; gap: 4px;\n  padding: 10px 14px;\n  border-radius: var(--wa-bubble-radius);\n  background: var(--wa-bubble-incoming);\n  box-shadow: 0 1px .5px var(--wa-border-bubble);\n  align-self: flex-start;\n  margin-bottom: 2px;\n}\n.wim-root .wa-typing i{\n  width: 7px; height: 7px; border-radius: 50%;\n  background: var(--wa-typing-dot);\n  animation: wa-typing-bounce 1.2s ease-in-out infinite;\n}\n.wim-root .wa-typing i:nth-child(2){ animation-delay: .15s; }\n.wim-root .wa-typing i:nth-child(3){ animation-delay: .3s; }\n\n/* ---------- 9. 输入区 ---------- */\n.wim-root .wa-composer{\n  display: flex;\n  align-items: flex-end;\n  gap: 8px;\n  padding: 5px 10px;\n  padding-bottom: calc(5px + env(safe-area-inset-bottom));\n  background: var(--wa-compose-bg);\n  flex-shrink: 0;\n}\n.wim-root .wa-composer .box{\n  flex: 1;\n  display: flex;\n  align-items: flex-end;\n  gap: 4px;\n  background: var(--wa-input-bg);\n  border-radius: 21px;\n  padding: 5px 8px;\n  min-width: 0;\n}\n.wim-root .wa-composer textarea{\n  flex: 1;\n  border: 0; outline: 0; resize: none;\n  background: transparent;\n  font-family: inherit;\n  font-size: 16px;          /* 必须 ≥16px，否则 iOS 聚焦时放大页面 */\n  line-height: 24px;\n  max-height: 120px;\n  height: 24px;\n  padding: 0 4px;\n  color: var(--wa-text-primary);\n}\n.wim-root .wa-composer textarea::placeholder{ color: var(--wa-text-secondary); }\n\n.wim-root .wa-send{\n  width: 40px; height: 40px; border-radius: 50%;\n  border: 0; flex-shrink: 0;\n  background: var(--wa-primary); color: #fff;\n  display: grid; place-items: center; cursor: pointer;\n  transition: transform .12s, background-color .15s;\n}\n.wim-root .wa-send:active{ transform: scale(.92); }\n.wim-root .wa-send.mic{ background: transparent; color: var(--wa-icon-default); }\n\n/* 录音条 */\n.wim-root .wa-recbar{\n  display: none;\n  align-items: center;\n  gap: 12px;\n  padding: 10px 14px;\n  background: var(--wa-bubble-system);\n  border-top: 1px solid var(--wa-border);\n  font-size: 14px;\n  color: var(--wa-text-primary);\n  flex-shrink: 0;\n}\n.wim-root .wa-recbar.on{ display: flex; }\n.wim-root .wa-recdot{\n  width: 10px; height: 10px; border-radius: 50%;\n  background: var(--wa-red-400);\n  animation: wa-blink 1s infinite;\n  flex-shrink: 0;\n}\n@keyframes wa-blink { 0%,100% { opacity: 1 } 50% { opacity: .2 } }\n.wim-root .wa-recbar .grow{ flex: 1; }\n\n/* ---------- 10. 表情面板 ---------- */\n.wim-root .wa-emoji{\n  display: none;\n  grid-template-columns: repeat(auto-fill, minmax(42px, 1fr));\n  gap: 4px;\n  padding: 10px 12px;\n  max-height: 180px;\n  overflow-y: auto;\n  background: var(--wa-panel-header-bg);\n  border-top: 1px solid var(--wa-border);\n  flex-shrink: 0;\n}\n.wim-root .wa-emoji.on{ display: grid; }\n.wim-root .wa-emoji button{\n  font-size: 22px; line-height: 1;\n  border: 0; background: transparent;\n  padding: 8px 0; border-radius: 8px; cursor: pointer;\n}\n.wim-root .wa-emoji button:hover{ background: var(--wa-hover); }\n\n/* ---------- 11. 下拉菜单 ---------- */\n.wim-root .wa-menu{\n  position: absolute;\n  top: calc(var(--wa-header-height) - 4px);\n  right: 10px;\n  min-width: 180px;\n  background: var(--wa-panel-header-bg);\n  border-radius: 10px;\n  box-shadow: 0 4px 20px var(--wa-shadow-medium);\n  padding: 6px;\n  z-index: 40;\n  display: none;\n  transform-origin: top right;\n}\n.wim-root .wa-menu.on{ display: block; animation: wa-pop .15s ease-out; }\n@keyframes wa-pop { from { opacity: 0; transform: scale(.94) } to { opacity: 1; transform: scale(1) } }\n.wim-root .wa-menu button{\n  display: flex; align-items: center; gap: 10px;\n  width: 100%; padding: 10px 12px;\n  border: 0; background: transparent; border-radius: 7px;\n  font-size: 14.5px; color: var(--wa-text-primary);\n  cursor: pointer; text-align: left;\n}\n.wim-root .wa-menu button:hover{ background: var(--wa-hover); }\n.wim-root .wa-menu button.danger{ color: var(--wa-text-critical); }\n\n/* ---------- 12. 全屏查看器 ---------- */\n.wim-root .wa-viewer{\n  position: fixed; inset: 0;\n  background: rgba(0,0,0,.94);\n  z-index: 60;\n  display: none;\n  align-items: center; justify-content: center;\n  padding: 20px;\n}\n.wim-root .wa-viewer.on{ display: flex; }\n.wim-root .wa-viewer img, .wim-root .wa-viewer video{ max-width: 100%; max-height: 100%; border-radius: 6px; }\n.wim-root .wa-viewer .close{\n  position: absolute; top: calc(14px + env(safe-area-inset-top)); right: 14px;\n  width: 42px; height: 42px; border-radius: 50%;\n  border: 0; background: rgba(255,255,255,.14); color: #fff;\n  display: grid; place-items: center; cursor: pointer;\n}\n\n/* ---------- 13. 移动端抽屉（侧栏的移动形态） ---------- */\n.wim-root .wa-drawer{\n  position: fixed; inset: 0;\n  z-index: 50;\n  display: none;\n}\n.wim-root .wa-drawer.on{ display: block; }\n.wim-root .wa-drawer .mask{\n  position: absolute; inset: 0;\n  background: rgba(0,0,0,.45);\n}\n.wim-root .wa-drawer .panel{\n  position: absolute; top: 0; bottom: 0; left: 0;\n  width: 86%; max-width: 360px;\n  background: var(--wa-panel-bg);\n  display: flex; flex-direction: column;\n  animation: wa-slide .22s ease-out;\n}\n@keyframes wa-slide { from { transform: translateX(-100%) } to { transform: translateX(0) } }\n\n/* ---------- 14. 入口页（home / created / join） ---------- */\n.wim-root .wa-gate{\n  position: fixed; inset: 0;\n  display: flex; align-items: center; justify-content: center;\n  padding: 24px;\n  background: var(--wa-bg-deeper);\n  overflow-y: auto;\n}\n.wim-root .wa-gate-card{\n  width: 100%; max-width: 420px;\n  background: var(--wa-panel-bg);\n  border-radius: 20px;\n  padding: 30px 24px;\n  box-shadow: 0 8px 40px var(--wa-shadow-medium);\n}\n.wim-root .wa-gate-logo{\n  width: 68px; height: 68px; margin: 0 auto 18px;\n  border-radius: 20px;\n  background: var(--wa-primary);\n  display: grid; place-items: center;\n  color: #fff;\n}\n.wim-root .wa-gate-card h1{\n  margin: 0 0 10px;\n  font-size: 22px; font-weight: 600;\n  text-align: center;\n  color: var(--wa-text-primary);\n}\n.wim-root .wa-gate-card .desc{\n  margin: 0 0 22px;\n  font-size: 13.5px; line-height: 1.65;\n  color: var(--wa-text-secondary);\n  text-align: center;\n}\n.wim-root .wa-gate-card .link-box{\n  background: var(--wa-bg-deeper);\n  border-radius: 10px;\n  padding: 11px 12px;\n  font-size: 12.5px; line-height: 1.5;\n  color: var(--wa-text-secondary);\n  word-break: break-all;\n  margin-bottom: 14px;\n  text-align: center;\n  user-select: all;\n}\n.wim-root .wa-gate-card .tiny{\n  margin-top: 12px;\n  font-size: 11.5px;\n  color: var(--wa-text-deemphasized);\n  text-align: center;\n  line-height: 1.6;\n}\n\n.wim-root .wa-btn{\n  width: 100%; height: 48px;\n  border: 0; border-radius: 12px;\n  font-size: 15.5px; font-weight: 600;\n  cursor: pointer;\n  display: flex; align-items: center; justify-content: center; gap: 8px;\n  transition: background-color .15s, transform .1s;\n}\n.wim-root .wa-btn:active{ transform: scale(.985); }\n.wim-root .wa-btn.primary{ background: var(--wa-primary); color: #fff; }\n.wim-root .wa-btn.primary:hover{ background: var(--wa-primary-hover); }\n.wim-root .wa-btn.primary:disabled{ opacity: .55; cursor: default; }\n.wim-root .wa-btn.ghost{\n  background: transparent;\n  color: var(--wa-primary);\n  border: 1px solid var(--wa-border);\n  margin-top: 10px;\n}\n.wim-root .wa-btn.ghost:hover{ background: var(--wa-hover); }\n\n.wim-root .wa-pass{\n  width: 100%; height: 54px;\n  border: 1px solid var(--wa-border);\n  border-radius: 12px;\n  background: var(--wa-input-bg);\n  text-align: center;\n  letter-spacing: 8px;\n  font-size: 24px; font-weight: 600;\n  color: var(--wa-text-primary);\n  outline: 0;\n  margin-bottom: 14px;\n  font-family: inherit;\n}\n.wim-root .wa-pass:focus{ border-color: var(--wa-primary); }\n\n/* ---------- 15. Toast ---------- */\n.wim-root .wa-toast{\n  position: fixed;\n  left: 50%; bottom: calc(88px + env(safe-area-inset-bottom));\n  transform: translateX(-50%);\n  background: rgba(17,27,33,.9);\n  color: #fff;\n  font-size: 13.5px;\n  padding: 10px 16px;\n  border-radius: 10px;\n  z-index: 70;\n  max-width: 80vw;\n  text-align: center;\n  opacity: 0;\n  pointer-events: none;\n  transition: opacity .2s, transform .2s;\n}\n.wim-root .wa-toast.on{ opacity: 1; transform: translateX(-50%) translateY(-6px); }\n\n/* ---------- 16. 连接状态条 ---------- */\n.wim-root .wa-banner{\n  display: none;\n  align-items: center;\n  justify-content: center;\n  gap: 10px;\n  padding: 7px 14px;\n  background: var(--wa-bubble-system);\n  color: var(--wa-system-msg);\n  font-size: 12.5px;\n  flex-shrink: 0;\n}\n.wim-root .wa-banner.on{ display: flex; }\n.wim-root .wa-banner button{\n  border: 0; background: var(--wa-primary); color: #fff;\n  font-size: 12px; padding: 4px 12px; border-radius: 12px; cursor: pointer;\n}\n\n/* ---------- 17. 空态 ---------- */\n.wim-root .wa-empty{\n  flex: 1;\n  display: flex; flex-direction: column;\n  align-items: center; justify-content: center;\n  gap: 14px;\n  padding: 40px 24px;\n  color: var(--wa-text-secondary);\n  text-align: center;\n}\n.wim-root .wa-empty .ico{\n  width: 76px; height: 76px; border-radius: 50%;\n  background: var(--wa-hover);\n  display: grid; place-items: center;\n  color: var(--wa-icon-lighter);\n}\n.wim-root .wa-empty p{ margin: 0; font-size: 14px; line-height: 1.6; }\n\n/* ---------- 5. 访客列表（IM 式首页，取代本地房间入口页） ---------- */\n.wim-root .wa-visitors{\n  height: 100%;\n  width: 100%;\n  max-width: 560px;\n  margin: 0 auto;\n  display: flex;\n  flex-direction: column;\n  background: var(--wa-bg);\n}\n.wim-root .wa-visitors-head{\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  padding: 12px 16px;\n  padding-top: calc(12px + env(safe-area-inset-top));\n  background: var(--wa-panel-header-bg);\n  border-bottom: 1px solid var(--wa-border);\n  flex-shrink: 0;\n}\n.wim-root .wa-visitors-head .vh-me{ flex: 1; min-width: 0; }\n.wim-root .wa-visitors-head .vh-me b{\n  display: block;\n  font-size: 16px;\n  font-weight: 600;\n  color: var(--wa-text-primary);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n.wim-root .wa-visitors-head .vh-me span{\n  display: block;\n  font-size: 12.5px;\n  color: var(--wa-text-secondary);\n  margin-top: 1px;\n}\n.wim-root .wa-visitors-body{\n  flex: 1;\n  overflow-y: auto;\n  -webkit-overflow-scrolling: touch;\n  padding: 6px 0 24px;\n}\n\n/* 历史访客：整体灰度渲染，不可点击 */\n.wim-root .wa-list-item.off, .wim-root .wa-list-item.off:hover, .wim-root .wa-list-item.off:active{ background: transparent; cursor: default; }\n.wim-root .wa-list-item.off .wa-avatar{ filter: grayscale(1); opacity: .45; }\n.wim-root .wa-list-item.off .li-name{ color: var(--wa-text-secondary); font-weight: 500; }\n.wim-root .wa-list-item.off .li-sub{ opacity: .65; }\n.wim-root .wa-list-item.off:disabled{ color: inherit; }\n\n/* 录音键：按住录音时高亮 */\n.wim-root .wa-iconbtn#btnRec.on{ color: var(--wa-primary); background: var(--wa-hover); }\n\n/* 桌面端隐藏移动专用件 */\n@media (min-width: 900px) {\n  .wim-root .wa-drawer{ display: none !important; }\n}\n\n\n/* ===== call-layer.css（zsjws@3b57750，作用域化） ===== */\n/* ============================================================\n * call-layer.css — 通话层 / 美颜面板样式\n * 来源：zsjws.html 内联 <style> 的 86-99 与 104-152 行，逐字复制。\n *\n * ⚠️ 冻结文件：选择器与声明不得修改。\n *    这组样式服务于 js/call-ui.js 与 js/BeautyEngine.js，\n *    二者是长期调试产物，本文件任何改动都必须真机验通话。\n * ============================================================ */\n\n.wim-root .video{ position: fixed; inset: 0; background: #111; z-index: 20; display: none; flex-direction: column; align-items: center; justify-content: space-between; }\n.wim-root .video.on{ display: flex; }\n.wim-root .remote{ flex: 1; width: 100%; height: 100%; object-fit: cover; }\n.wim-root .local{ position: absolute; right: 14px; top: calc(14px + env(safe-area-inset-top)); width: 110px; height: 150px; object-fit: cover; background: #222; border-radius: 12px; z-index: 2; }\n\n.wim-root .call-banner{ position: absolute; top: 15%; display: flex; flex-direction: column; align-items: center; z-index: 3; color: #fff; text-align: center; width: 100%; }\n.wim-root .call-banner .avatar{ font-size: 64px; margin-bottom: 12px; }\n.wim-root .call-banner .call-title{ font-size: 18px; font-weight: bold; margin-bottom: 24px; }\n.wim-root .call-actions{ display: flex; gap: 36px; }\n\n.wim-root .controls{ height: 90px; display: flex; align-items: center; justify-content: center; gap: 20px; padding-bottom: env(safe-area-inset-bottom); z-index: 3; width: 100%; }\n.wim-root .ctrl{ width: 56px; height: 56px; border: 0; border-radius: 50%; background: #333; color: #fff; font-size: 20px; cursor: pointer; display: grid; place-items: center; }\n.wim-root .answer{ background: #4caf50; font-size: 15px; font-weight: bold; width: 68px; height: 68px; }\n.wim-root .hang{ background: #e53935; font-size: 15px; font-weight: bold; width: 68px; height: 68px; }\n\n/* 沉浸式美颜参数调节面板样式 */\n.wim-root .beauty-panel{\n  position: absolute;\n  bottom: 100px;\n  left: 50%;\n  transform: translateX(-50%);\n  width: 90%;\n  max-width: 360px;\n  background: rgba(20, 20, 20, 0.75);\n  backdrop-filter: blur(12px);\n  -webkit-backdrop-filter: blur(12px);\n  border-radius: 20px;\n  padding: 16px 20px;\n  color: #fff;\n  z-index: 25;\n  display: none;\n  box-shadow: 0 8px 32px rgba(0,0,0,0.4);\n}\n.wim-root .beauty-panel.on{ display: block; }\n.wim-root .beauty-row{\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  margin: 10px 0;\n  font-size: 13px;\n}\n.wim-root .beauty-row label{ width: 70px; color: #ccc; }\n.wim-root .beauty-row input[type=\"range\"]{\n  flex: 1;\n  accent-color: #229ed9;\n  height: 4px;\n}\n.wim-root .beauty-actions{\n  display: flex;\n  justify-content: space-between;\n  margin-top: 14px;\n  border-top: 1px solid rgba(255,255,255,0.1);\n  padding-top: 12px;\n}\n.wim-root .beauty-btn{\n  background: rgba(255,255,255,0.15);\n  border: none;\n  color: #fff;\n  padding: 6px 14px;\n  border-radius: 10px;\n  font-size: 12px;\n  cursor: pointer;\n}\n.wim-root .beauty-btn.active{ background: #229ed9; }\n\n\n/* ===== beauty-panel.css（zsjws@3b57750，作用域化） ===== */\n.wim-root .beauty-panel{\n position: absolute;\n bottom: 100px;\n left: 50%;\n transform: translateX(-50%);\n width: 90%;\n max-width: 360px;\n background: rgba(20, 20, 20, 0.75);\n backdrop-filter: blur(12px);\n -webkit-backdrop-filter: blur(12px);\n border-radius: 20px;\n padding: 16px 20px;\n color: #fff;\n z-index: 25;\n display: none;\n box-shadow: 0 8px 32px rgba(0,0,0,0.4);\n font-family: inherit;\n}\n.wim-root .beauty-panel.on{ display: block; }\n.wim-root .beauty-row{\n display: flex;\n align-items: center;\n justify-content: space-between;\n margin: 10px 0;\n font-size: 13px;\n}\n.wim-root .beauty-row label{ width: 70px; color: #ccc; }\n.wim-root .beauty-row input[type=\"range\"]{\n flex: 1;\n accent-color: #229ed9;\n height: 4px;\n}\n.wim-root .beauty-actions{\n display: flex;\n justify-content: space-between;\n margin-top: 14px;\n border-top: 1px solid rgba(255,255,255,0.1);\n padding-top: 12px;\n}\n.wim-root .beauty-btn{\n background: rgba(255,255,255,0.15);\n border: none;\n color: #fff;\n padding: 6px 14px;\n border-radius: 10px;\n font-size: 12px;\n cursor: pointer;\n}\n.wim-root .beauty-btn.active{ background: #229ed9; }"

// ── styles.js ──────────────────────────────────────────────
/**
 * styles.js —— 驱动自有样式（全部作用域在 `.wim-root` 下）
 *
 * 为什么不放全局：母体页面的 DOM 与驱动同处一棵树，任何 `html`/`body`/`*` 选择器
 * 都会污染宿主。这里每条规则都以 `.wim-root` 起头，卸载时整块 <style> 一起摘掉。
 *
 * zsjws 的 wa-ui.css（36KB / 178 个 .wa-* 类）经 scripts/scope-css.mjs 作用域化后
 * 以 `UI_CSS` 并入本文件的 CSS_TEXT；本文件只保留驱动骨架（按钮/层/面板）的样式。
 */

const DRIVER_ID = 'org.quake.webrtc.im'
const SLOT_NAME = 'chat.sidebar'
const ROOT_CLASS = 'wim-root'
const LAYER_Z = '2147483000'

const FRAME_CSS = `
.wim-root {
  position: relative;
  display: inline-block;
  font-family: "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
  line-height: 1.4;
  color: #111b21;
  -webkit-tap-highlight-color: transparent;
}

.wim-launcher {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 1px solid rgba(0, 168, 132, .28);
  border-radius: 14px;
  background: linear-gradient(160deg, #f2fdf0 0%, #e7fce3 100%);
  color: #0a7c5a;
  cursor: pointer;
  transition: transform .12s ease, box-shadow .12s ease, border-color .12s ease;
  box-shadow: 0 1px 2px rgba(11, 20, 26, .06);
}
.wim-launcher:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0, 168, 132, .18); border-color: rgba(0, 168, 132, .5); }
.wim-launcher:active { transform: translateY(0); }
.wim-launcher:focus-visible { outline: 2px solid #00a884; outline-offset: 2px; }

.wim-badge {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: 9px;
  background: #00a884;
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 17px;
  text-align: center;
  box-shadow: 0 0 0 2px #fff;
}
.wim-badge[hidden] { display: none; }

.wim-layer {
  position: fixed;
  inset: 0;
  z-index: ${LAYER_Z};
  display: flex;
  align-items: stretch;
  justify-content: center;
  background: rgba(11, 20, 26, .55);
}
.wim-layer[hidden] { display: none; }

.wim-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #f0f2f5;
}
.wim-panel-head {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 52px;
  padding: 0 14px;
  background: #f0f2f5;
  border-bottom: 1px solid #e5e7eb;
  flex: 0 0 auto;
}
.wim-panel-title { font-size: 14px; font-weight: 600; }
.wim-panel-sub { font-size: 12px; color: #667781; }
.wim-close {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: #54656f;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.wim-close:hover { background: rgba(11, 20, 26, .06); }
.wim-panel-body {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  color: #667781;
  font-size: 13px;
  text-align: center;
}

/* ---- bare 形态：业务界面接管整屏 ----
 * 业务壳是 position:fixed; inset:0，会盖住标题栏；此时收起标题栏，
 * 换成贴左边的半透明收起把手，保证「进得来、出得去」。
 */
.wim-panel-bare > .wim-panel-head { display: none; }
.wim-edge {
  position: fixed;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  display: none;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 58px;
  padding: 0;
  border: 0;
  border-radius: 0 12px 12px 0;
  background: rgba(11, 20, 26, .38);
  color: #fff;
  cursor: pointer;
  z-index: 4;
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  opacity: .7;
  transition: opacity .15s;
}
.wim-edge:hover, .wim-edge:focus-visible { opacity: 1; }
.wim-panel-bare + .wim-edge { display: flex; }

@media (prefers-color-scheme: dark) {
  .wim-root { color: #e9edef; }
  .wim-launcher { background: linear-gradient(160deg, #111b21 0%, #0b141a 100%); border-color: rgba(0, 168, 132, .35); color: #00d9a5; }
  .wim-badge { box-shadow: 0 0 0 2px #0b141a; }
  .wim-panel { background: #0b141a; }
  .wim-panel-head { background: #111b21; border-bottom-color: #222d34; }
  .wim-panel-sub { color: #8696a0; }
  .wim-close { color: #aebac1; }
  .wim-close:hover { background: rgba(233, 237, 239, .08); }
  .wim-panel-body { color: #8696a0; }
}
`

/**
 * 框架样式（驱动自己的 chrome）+ 业务样式（zsjws 迁移，已作用域化）。
 * 业务样式 37.5KB 由 scripts/scope-css.mjs 生成，不要手改。
 */
const CSS_TEXT = `${FRAME_CSS}

/* ---- 业务界面挂载位 ---- */
.wim-root .wim-panel-body.wim-app-host {
  display: block;
  padding: 0;
  overflow: hidden;
  text-align: left;
}
.wim-root #app { width: 100%; height: 100%; }

/* ---- 通话 overlay 宿主 ----
 * 引擎把通话界面挂进驱动根节点下的 #zsjd-layer。业务层 .wim-layer 的 z-index 是 2147483000，
 * 若 overlay 留在默认层级，会被会话界面整个盖住（表现为「接听按钮点不到」）。
 * 这里把宿主抬到业务层之上：宿主本身不吃事件（pointer-events:none），
 * 只有真正显示出来的通话界面（.video 是 display:none，通话时才 flex）吃事件。
 */
.wim-root > #zsjd-layer {
  position: fixed;
  inset: 0;
  z-index: 2147483001;
  pointer-events: none;
}
.wim-root > #zsjd-layer > * { pointer-events: auto; }

${UI_CSS}`

/** 把样式注入到驱动根节点内部（不是 document.head），卸载时随根一起消失。 */
function injectStyles(doc, root) {
  const el = doc.createElement('style')
  el.setAttribute('data-module', DRIVER_ID)
  el.textContent = CSS_TEXT
  root.appendChild(el)
  return el
}

// ── engine/shim.js ──────────────────────────────────────────────
/**
 * shim.js —— 必须第一个被求值
 *
 * 冻结层（call-core / media-manager / pc-manager / adapter / beauty-engine / call-ui）
 * 原本是 classic script，靠 `window.X = ...` 注册单例、彼此通过 `window.X` 取用。
 * 打成单文件 ESM 后，浏览器里 window 天然存在；Node（契约测试）里没有。
 *
 * 这里补一个指向 globalThis 的别名：浏览器下是 no-op，Node 下让模块能安全求值。
 * 注意：单例注册发生在**模块求值期**，因此本文件必须是 engine/index.js 的第一个 import。
 */
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis
}

// ── engine/state-machine/call-core.js ──────────────────────────────────────────────
/* CallCore.js — deterministic call FSM with monotonically increasing epochs. */
(() => {
  'use strict';

  const TRANSITIONS = Object.freeze({
    IDLE:       Object.freeze({ BEGIN: 'RINGING' }),
    RINGING:    Object.freeze({ ACCEPT: 'CONNECTING', END: 'TEARDOWN' }),
    CONNECTING: Object.freeze({ CONNECTED: 'ACTIVE', END: 'TEARDOWN' }),
    ACTIVE:     Object.freeze({ END: 'TEARDOWN' }),
    TEARDOWN:   Object.freeze({ RESET: 'IDLE' })
  });

  class CallCoreClass {
    constructor() {
      this.state = 'IDLE';
      this.epoch = 0;
      this.callId = null;
      this.role = 'none';
      this.listeners = new Set();
      this.resetToken = 0;
    }

    subscribe(fn) {
      if (typeof fn !== 'function') throw new TypeError('listener must be a function');
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }

    emit(event, detail = {}) {
      const snapshot = {
        state: this.state, epoch: this.epoch, callId: this.callId,
        role: this.role, event, detail
      };
      for (const fn of [...this.listeners]) {
        try { fn(snapshot); }
        catch (err) { console.error('[CallCore] listener failed', err); }
      }
    }

    begin(role, callId) {
      if (this.state !== 'IDLE' || !callId || !['caller', 'callee'].includes(role)) return null;
      this.epoch += 1;
      this.callId = String(callId);
      this.role = role;
      this.state = 'RINGING';
      this.emit('BEGIN');
      return this.epoch;
    }

    transition(event, callId = this.callId, epoch = this.epoch, detail = {}) {
      if (event === 'END') return this.end(callId, epoch, detail);
      if (!this.isCurrent(callId, epoch)) return false;
      const next = TRANSITIONS[this.state]?.[event];
      if (!next || next === 'TEARDOWN' || next === 'IDLE') return false;
      this.state = next;
      this.emit(event, detail);
      return true;
    }

    isCurrent(callId, epoch) {
      return Boolean(callId && this.callId === callId && this.epoch === epoch &&
        this.state !== 'IDLE' && this.state !== 'TEARDOWN');
    }

    capture(callId = this.callId) {
      return this.isCurrent(callId, this.epoch) ? { callId, epoch: this.epoch } : null;
    }

    guard(epoch, callId = this.callId) { return this.isCurrent(callId, epoch); }

    end(callId = this.callId, epoch = this.epoch, detail = {}) {
      if (!this.isCurrent(callId, epoch)) return false;
      const oldCallId = this.callId;
      const oldEpoch = this.epoch;
      this.state = 'TEARDOWN';
      // Invalidate all outstanding work synchronously before notifying consumers.
      this.epoch += 1;
      const resetToken = ++this.resetToken;
      this.emit('END', { ...detail, endedCallId: oldCallId, endedEpoch: oldEpoch });
      queueMicrotask(() => {
        if (this.state !== 'TEARDOWN' || this.resetToken !== resetToken) return;
        this.state = 'IDLE';
        this.callId = null;
        this.role = 'none';
        this.emit('RESET', { endedCallId: oldCallId, endedEpoch: oldEpoch });
      });
      return true;
    }
  }

  window.CallCore = new CallCoreClass();
})();

// ── engine/media/media-manager.js ──────────────────────────────────────────────
/* MediaManager.js — single owner for physical microphone/camera tracks. */
(() => {
  'use strict';

  class MediaManagerClass {
    constructor() {
      this.cachedRawStream = null;
      this.queue = Promise.resolve();
      this.generation = 0;
    }

    get stream() { return this.cachedRawStream; }

    getRawStream(kind = 'audio') {
      const task = this.queue.then(() => this._getRawStream(kind), () => this._getRawStream(kind));
      this.queue = task.catch(() => null);
      return task;
    }

    async _getRawStream(kind) {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持媒体设备访问');
      const needVideo = kind === 'video';
      const tracks = this.cachedRawStream?.getTracks() || [];
      const live = tracks.length > 0 && tracks.every(track => track.readyState === 'live');
      const hasAudio = Boolean(this.cachedRawStream?.getAudioTracks().some(track => track.readyState === 'live'));
      const hasVideo = Boolean(this.cachedRawStream?.getVideoTracks().some(track => track.readyState === 'live'));

      if (!live || !hasAudio || (needVideo && !hasVideo)) {
        const generationAtRequest = this.generation;
        const requested = await navigator.mediaDevices.getUserMedia({ audio: true, video: needVideo });
        if (generationAtRequest !== this.generation) {
          requested.getTracks().forEach(track => { try { track.stop(); } catch {} });
          throw new Error('媒体初始化已取消');
        }
        const requestedAudio = requested.getAudioTracks().some(track => track.readyState === 'live');
        const requestedVideo = requested.getVideoTracks().some(track => track.readyState === 'live');
        if (!requestedAudio || (needVideo && !requestedVideo)) {
          requested.getTracks().forEach(track => { try { track.stop(); } catch {} });
          throw new Error('浏览器未提供所需的麦克风或摄像头轨道');
        }
        const previous = this.cachedRawStream;
        this.cachedRawStream = requested;
        this.generation += 1;
        if (previous && previous !== requested) {
          previous.getTracks().forEach(track => { try { track.stop(); } catch {} });
        }
      }

      // Only tracks needed by this call are enabled; the stream remains cached between calls.
      this.cachedRawStream.getAudioTracks().forEach(track => { track.enabled = true; });
      this.cachedRawStream.getVideoTracks().forEach(track => { track.enabled = needVideo; });
      return this.cachedRawStream;
    }

    setAllEnabled(enabled) {
      this.cachedRawStream?.getTracks().forEach(track => { track.enabled = Boolean(enabled); });
    }

    setCameraEnabled(enabled) {
      this.cachedRawStream?.getVideoTracks().forEach(track => { track.enabled = Boolean(enabled); });
    }

    release() {
      const old = this.cachedRawStream;
      this.cachedRawStream = null;
      this.generation += 1;
      if (old) old.getTracks().forEach(track => { try { track.stop(); } catch {} });
    }
  }

  window.MediaManager = new MediaManagerClass();
  window.addEventListener?.('pagehide', () => window.MediaManager.release());
})();

// ── engine/peer/pc-manager.js ──────────────────────────────────────────────
/* PeerConnectionManager.js — owns independent chat/call RTCPeerConnection instances. */
(() => {
  'use strict';

  class PeerConnectionManager {
    constructor() { this.entries = new Map(); }

    isActive(name, entry) {
      return Boolean(entry && !entry.closed && this.entries.get(name) === entry && entry.pc);
    }

    create(name, config, callbacks = {}, options = {}) {
      this.close(name);
      const pc = new RTCPeerConnection(config);
      const entry = {
        pc,
        polite: Boolean(options.polite),
        makingOffer: false,
        ignoreOffer: false,
        settingRemoteAnswerPending: false,
        pendingCandidates: [],
        closed: false,
        callbacks
      };
      this.entries.set(name, entry);

      pc.onicecandidate = event => {
        if (this.isActive(name, entry) && event.candidate) callbacks.onIceCandidate?.(event.candidate, pc);
      };
      pc.ontrack = event => {
        if (this.isActive(name, entry)) callbacks.onTrack?.(event, pc);
      };
      pc.oniceconnectionstatechange = () => {
        if (this.isActive(name, entry)) callbacks.onIceState?.(pc.iceConnectionState, pc);
      };
      pc.onconnectionstatechange = () => {
        if (this.isActive(name, entry)) callbacks.onConnectionState?.(pc.connectionState, pc);
      };
      pc.onsignalingstatechange = () => {
        if (this.isActive(name, entry)) callbacks.onSignalingState?.(pc.signalingState, pc);
      };
      return pc;
    }

    get(name) { return this.entries.get(name)?.pc || null; }

    async makeOffer(name, options) {
      const entry = this.entries.get(name);
      if (!this.isActive(name, entry)) throw new Error(`PeerConnection '${name}' is not available`);
      const pc = entry.pc;
      if (entry.makingOffer) return null;
      entry.makingOffer = true;
      try {
        const offer = await pc.createOffer(options);
        if (!this.isActive(name, entry)) return null;
        await pc.setLocalDescription(offer);
        if (!this.isActive(name, entry)) return null;
        return pc.localDescription;
      } finally {
        entry.makingOffer = false;
      }
    }

    async handleDescription(name, description, sendDescription) {
      const entry = this.entries.get(name);
      if (!this.isActive(name, entry) || !description) return false;
      const pc = entry.pc;
      const collision = description.type === 'offer' &&
        (entry.makingOffer || (pc.signalingState !== 'stable' && !entry.settingRemoteAnswerPending));
      entry.ignoreOffer = !entry.polite && collision;
      if (entry.ignoreOffer) {
        // ICE candidates queued before the colliding offer belong to the offer we ignore.
        entry.pendingCandidates.length = 0;
        return false;
      }

      try {
        entry.settingRemoteAnswerPending = description.type === 'answer';
        if (collision && entry.polite && pc.signalingState !== 'stable') {
          try { await pc.setLocalDescription({ type: 'rollback' }); }
          catch (rollbackError) {
            // Some browsers roll back implicitly when setRemoteDescription(offer) runs.
            if (!this.isActive(name, entry)) return false;
            console.debug('[PCManager] explicit rollback unavailable; trying remote offer', rollbackError?.message || '');
          }
        }
        if (!this.isActive(name, entry)) return false;
        await pc.setRemoteDescription(description);
        entry.settingRemoteAnswerPending = false;
        if (!this.isActive(name, entry)) return false;
        await this.flushCandidates(name, entry);
        if (!this.isActive(name, entry)) return false;

        if (description.type === 'offer') {
          const answer = await pc.createAnswer();
          if (!this.isActive(name, entry)) return false;
          await pc.setLocalDescription(answer);
          if (!this.isActive(name, entry)) return false;
          if (typeof sendDescription === 'function') sendDescription(pc.localDescription);
        }
        return true;
      } catch (err) {
        entry.settingRemoteAnswerPending = false;
        if (this.isActive(name, entry)) entry.callbacks.onError?.(err, pc);
        throw err;
      }
    }

    async addIceCandidate(name, candidate) {
      const entry = this.entries.get(name);
      if (!this.isActive(name, entry) || !candidate || entry.ignoreOffer) return false;
      if (!entry.pc.remoteDescription) {
        entry.pendingCandidates.push(candidate);
        if (entry.pendingCandidates.length > 256) entry.pendingCandidates.shift();
        return true;
      }
      try {
        await entry.pc.addIceCandidate(candidate);
        return true;
      } catch (err) {
        if (!entry.ignoreOffer) throw err;
        return false;
      }
    }

    async flushCandidates(name, expectedEntry = this.entries.get(name)) {
      const entry = expectedEntry;
      if (!this.isActive(name, entry) || !entry.pc.remoteDescription) return;
      const queued = entry.pendingCandidates.splice(0);
      for (const candidate of queued) {
        if (!this.isActive(name, entry)) return;
        try { await entry.pc.addIceCandidate(candidate); }
        catch (err) {
          if (!entry.ignoreOffer && this.isActive(name, entry)) entry.callbacks.onError?.(err, entry.pc);
        }
      }
    }

    close(name) {
      const entry = this.entries.get(name);
      if (!entry) return;
      entry.closed = true;
      this.entries.delete(name);
      entry.pendingCandidates.length = 0;
      const pc = entry.pc;
      if (pc) {
        pc.onicecandidate = pc.ontrack = pc.oniceconnectionstatechange = null;
        pc.onconnectionstatechange = pc.onsignalingstatechange = null;
        try { pc.close(); } catch { /* idempotent cleanup */ }
      }
      entry.pc = null;
      entry.makingOffer = false;
      entry.settingRemoteAnswerPending = false;
    }

    closeAll() { for (const name of [...this.entries.keys()]) this.close(name); }
  }

  window.PCManager = new PeerConnectionManager();
})();

// ── engine/signaling/adapter.js ──────────────────────────────────────────────
/* CallSignalingAdapter.js — isolates call signaling from the chat/data-channel bus. */
(() => {
  'use strict';

  const CALL_SIGNAL_TYPES = new Set([
    'call-invite', 'call-accept', 'call-reject', 'call-cancel',
    'call-offer', 'call-answer', 'call-ice', 'call-end', 'call-hangup', 'hangup'
  ]);

  class CallSignalingAdapter {
    constructor(deps) { this.d = deps; }

    isCallSignal(type) { return CALL_SIGNAL_TYPES.has(type); }

    async dispatch(message) {
      if (!message || !this.isCallSignal(message.type)) return false;
      switch (message.type) {
        case 'call-invite': return this.onInvite(message);
        case 'call-accept': return this.onAccept(message);
        case 'call-reject':
        case 'call-cancel':
        case 'call-end':
        case 'call-hangup':
        case 'hangup': return this.onEnd(message);
        case 'call-offer': return this.onOffer(message);
        case 'call-answer': return this.onAnswer(message);
        case 'call-ice': return this.onIce(message);
        default: return false;
      }
    }

    onInvite(message) {
      const { S, sig, CallCore, $, playRing, clearCallTimer, clearCallState } = this.d;
      if (!message.callId || S.endedCalls.has(message.callId)) return true;
      if (S.call) {
        sig({ type: 'call-reject', callId: message.callId, reason: 'busy' });
        return true;
      }
      const epoch = CallCore?.begin('callee', message.callId);
      if (epoch == null) {
        sig({ type: 'call-reject', callId: message.callId, reason: 'busy' });
        return true;
      }
      S.callCandidateQueue = [];
      S.call = {
        id: message.callId,
        kind: message.callKind === 'video' ? 'video' : 'audio',
        role: 'callee', phase: 'ringing', epoch
      };
      if ($('callBanner')) $('callBanner').style.display = 'flex';
      if ($('callAvatar')) $('callAvatar').textContent = S.call.kind === 'video' ? '📹' : '📞';
      if ($('callTitle')) $('callTitle').textContent = S.call.kind === 'video' ? '收到视频呼叫...' : '收到语音呼叫...';
      if ($('callActions')) $('callActions').style.display = 'flex';
      if ($('inCallControls')) $('inCallControls').style.display = 'none';
      if ($('video')) $('video').classList.add('on');
      playRing(S.call.kind, false);

      clearCallTimer();
      S.callTimer = setTimeout(() => {
        if (S.call?.id !== message.callId || S.call.phase !== 'ringing') return;
        sig({ type: 'call-reject', callId: message.callId, reason: 'timeout' });
        clearCallState('呼叫超时未接听', false);
      }, 30000);
      return true;
    }

    async onAccept(message) {
      const { S, CallCore, stopRingtone, clearCallTimer, startLocalAndOffer } = this.d;
      if (!S.call || S.call.id !== message.callId || S.call.role !== 'caller' || S.call.phase !== 'ringing') return true;
      stopRingtone();
      clearCallTimer();
      if (!CallCore?.transition('ACCEPT', S.call.id, S.call.epoch)) return true;
      S.call.phase = 'connecting';
      await startLocalAndOffer(S.call.kind, S.call.id, S.call.epoch);
      return true;
    }

    onEnd(message) {
      const { S, stopRingtone, clearCallState, rememberEndedCall } = this.d;
      if (!message.callId || !S.call || S.call.id !== message.callId) return true;
      const text = message.type === 'call-reject'
        ? '对方已拒绝呼叫'
        : message.type === 'call-cancel'
          ? '对方取消了呼叫'
          : '通话已结束';
      rememberEndedCall(message.callId);
      stopRingtone();
      clearCallState(text, false);
      return true;
    }

    async onOffer(message) {
      const { S, $, initCallPC, PCManager, sig } = this.d;
      if (!S.call || S.call.id !== message.callId || S.call.role !== 'callee' || S.call.phase !== 'connecting') return true;
      if (!S.callPc) initCallPC(message.callId);
      if (S.local) {
        S.local.getTracks().forEach(track => {
          if (!S.callPc.getSenders().some(sender => sender.track === track)) S.callPc.addTrack(track, S.local);
        });
      }
      const handled = await PCManager.handleDescription('call', message.offer, answer => {
        sig({ type: 'call-answer', callId: message.callId, answer });
      });
      if (!handled || !S.call || S.call.id !== message.callId) return true;
      if ($('callBanner')) $('callBanner').style.display = 'none';
      if ($('inCallControls')) $('inCallControls').style.display = 'flex';
      return true;
    }

    async onAnswer(message) {
      const { S, $, PCManager, stopRingtone } = this.d;
      if (!S.call || S.call.id !== message.callId || S.call.role !== 'caller' || !S.callPc) return true;
      await PCManager.handleDescription('call', message.answer);
      if (!S.call || S.call.id !== message.callId) return true;
      stopRingtone();
      if ($('callBanner')) $('callBanner').style.display = 'none';
      if ($('inCallControls')) $('inCallControls').style.display = 'flex';
      return true;
    }

    async onIce(message) {
      const { S, PCManager } = this.d;
      if (!message.callId || !message.candidate || !S.call || S.call.id !== message.callId) return true;
      try { await PCManager.addIceCandidate('call', message.candidate); }
      catch (error) { console.warn('[call ICE]', error); }
      return true;
    }
  }

  window.CallSignalingAdapter = CallSignalingAdapter;
})();

// ── engine/media/beauty-engine.js ──────────────────────────────────────────────
// js/BeautyEngine.js 终极稳健版
class BeautyEngineClass {
  constructor() {
    this.videoEl = null;
    this.canvas = null;
    this.gl = null;
    this.program = null;
    this.texture = null;
    this.animId = null;
    this.lastRenderTime = 0;
    this.renderInterval = 1000 / 30;
    this.rawStream = null;
    this.outputStream = null;
    this.enabled = true;
    this.isInitialized = false;
    this.isLocked = false;
    this.renderGeneration = 0;
    
    this.params = {
      whitening: 0.4,
      smoothing: 0.5,
      softLight: 0.3
    };
    
    this.uniLocs = {};
  }

  /** 装载方注入自有容器：隐藏的取帧 <video> 挂这里，不挂宿主 body。 */
  setHost(el) {
    this.hostEl = el || null;
  }

  // Canvas/WebGL resources are reusable; the captured video track is per-call.
  initCanvasPipeline() {
    if (this.canvas && this.gl && this.program && this.texture) return;
    try {
      if (!this.canvas) {
        this.canvas = document.createElement('canvas');
        this.canvas.width = 640;
        this.canvas.height = 480;
      }
      this.initWebGL();
      this.isInitialized = Boolean(this.gl && this.program && this.texture);
      if (!this.isInitialized) throw new Error('WebGL unavailable');
    } catch (e) {
      console.error("[BeautyEngine] 初始化画布管道失败:", e);
      throw e;
    }
  }

  initWebGL() {
    const gl = this.canvas.getContext('webgl', { preserveDrawingBuffer: false, alpha: false });
    this.gl = gl;
    if (!gl) return;

    const vsSource = `
      attribute vec2 a_position;
      attribute vec2 a_texCoord;
      varying vec2 v_texCoord;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = a_texCoord;
      }
    `;

    const fsSource = `
      precision mediump float;
      varying vec2 v_texCoord;
      uniform sampler2D u_image;
      uniform float u_whitening;
      uniform float u_smoothing;
      uniform float u_softLight;
      uniform vec2 u_texelSize;
      uniform int u_enabled;

      void main() {
        vec4 color = texture2D(u_image, v_texCoord);
        if (u_enabled == 0) {
          gl_FragColor = color;
          return;
        }

        if (u_smoothing > 0.01) {
          vec4 sum = color * 4.0;
          sum += texture2D(u_image, v_texCoord + vec2(u_texelSize.x * 1.5, 0.0));
          sum += texture2D(u_image, v_texCoord + vec2(-u_texelSize.x * 1.5, 0.0));
          sum += texture2D(u_image, v_texCoord + vec2(0.0, u_texelSize.y * 1.5));
          sum += texture2D(u_image, v_texCoord + vec2(0.0, -u_texelSize.y * 1.5));
          vec4 blurred = sum / 8.0;
          float diff = length(color.rgb - blurred.rgb);
          float blendFactor = smoothstep(0.0, 0.25, diff) * u_smoothing;
          color = mix(blurred, color, 0.4 + 0.6 * blendFactor);
        }

        if (u_whitening > 0.01) {
          float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));
          float whiteFactor = u_whitening * 0.2 * (1.0 - lum * 0.4);
          color.rgb += whiteFactor;
          color.rgb += u_whitening * 0.08 * (1.0 - lum);
        }

        if (u_softLight > 0.01) {
          vec3 soft = color.rgb + vec3(0.06 * u_softLight);
          color.rgb = mix(color.rgb, soft, u_softLight * 0.4);
        }

        gl_FragColor = clamp(color, 0.0, 1.0);
      }
    `;

    const createShader = (context, type, source) => {
      const shader = context.createShader(type);
      if (!shader) throw new Error('WebGL 无法创建着色器');
      context.shaderSource(shader, source);
      context.compileShader(shader);
      if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
        const message = context.getShaderInfoLog(shader) || 'unknown shader compile error';
        context.deleteShader(shader);
        throw new Error(`WebGL 着色器编译失败: ${message}`);
      }
      return shader;
    };

    const vertShader = createShader(gl, gl.VERTEX_SHADER, vsSource);
    let fragShader;
    let program;
    try {
      fragShader = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
      program = gl.createProgram();
      if (!program) throw new Error('WebGL 无法创建着色器程序');
      gl.attachShader(program, vertShader);
      gl.attachShader(program, fragShader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`WebGL 程序链接失败: ${gl.getProgramInfoLog(program) || 'unknown link error'}`);
      }
    } catch (error) {
      if (program) gl.deleteProgram(program);
      gl.deleteShader(vertShader);
      if (fragShader) gl.deleteShader(fragShader);
      throw error;
    }
    gl.deleteShader(vertShader);
    gl.deleteShader(fragShader);
    this.program = program;
    gl.useProgram(program);

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1, -1,  1,
      -1,  1,  1, -1,  1,  1,
    ]), gl.STATIC_DRAW);

    const posAttr = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(posAttr);
    gl.vertexAttribPointer(posAttr, 2, gl.FLOAT, false, 0, 0);

    const texCoordBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 1,  1, 1,  0, 0,
      0, 0,  1, 1,  1, 0,
    ]), gl.STATIC_DRAW);

    const texAttr = gl.getAttribLocation(program, "a_texCoord");
    gl.enableVertexAttribArray(texAttr);
    gl.vertexAttribPointer(texAttr, 2, gl.FLOAT, false, 0, 0);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    this.uniLocs = {
      image: gl.getUniformLocation(program, "u_image"),
      whitening: gl.getUniformLocation(program, "u_whitening"),
      smoothing: gl.getUniformLocation(program, "u_smoothing"),
      softLight: gl.getUniformLocation(program, "u_softLight"),
      texelSize: gl.getUniformLocation(program, "u_texelSize"),
      enabled: gl.getUniformLocation(program, "u_enabled")
    };
  }

  // Recreate the hidden video and captured output track for every video call.
  async init(rawStream) {
    if (this.isLocked) throw new Error("BeautyEngine is currently locked by another operation");
    this.isLocked = true;
    try {
      this.stopRender();
      this.destroyVideoElement();
      this.stopOutputStream();
      this.initCanvasPipeline();

      const videoTrack = rawStream?.getVideoTracks().find(t => t.readyState === 'live');
      const audioTrack = rawStream?.getAudioTracks().find(t => t.readyState === 'live');
      if (!videoTrack) return new MediaStream([...(audioTrack ? [audioTrack] : [])]);

      this.rawStream = rawStream;
      this.videoEl = document.createElement('video');
      this.videoEl.muted = true;
      this.videoEl.playsInline = true;
      this.videoEl.autoplay = true;
      this.videoEl.setAttribute('playsinline', '');
      this.videoEl.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-999;";
      // 适配：原版挂 document.body，那是在宿主页面里凭空插节点（违反「只向槽位渲染」）。
      // 装载方通过 setHost() 给一个自有容器，这里优先挂到容器里。
      (this.hostEl && this.hostEl.appendChild ? this.hostEl : document.body).appendChild(this.videoEl);
      this.videoEl.srcObject = new MediaStream([videoTrack]);

      await new Promise((resolve, reject) => {
        const video = this.videoEl;
        let done = false;
        const finish = (error) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          video.removeEventListener('loadedmetadata', onReady);
          video.removeEventListener('canplay', onReady);
          if (error) reject(error); else resolve();
        };
        const onReady = () => {
          if (video.videoWidth > 0 && video.videoHeight > 0) finish();
        };
        const timer = setTimeout(() => finish(new Error('摄像头画面初始化超时')), 8000);
        video.addEventListener('loadedmetadata', onReady);
        video.addEventListener('canplay', onReady);
        Promise.resolve(video.play()).then(onReady).catch(() => { /* Safari may resolve after user gesture; timeout remains bounded. */ });
        onReady();
      });

      const sourceWidth = this.videoEl.videoWidth || 640;
      const sourceHeight = this.videoEl.videoHeight || 480;
      const scale = Math.min(1, 640 / sourceWidth);
      this.canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      this.canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);

      this.outputStream = this.canvas.captureStream(30);
      const outputVideoTrack = this.outputStream.getVideoTracks()[0];
      if (!outputVideoTrack) throw new Error('无法创建美颜输出视频轨道');
      const tracks = [outputVideoTrack];
      if (audioTrack) tracks.push(audioTrack);
      this.startRender();
      return new MediaStream(tracks);
    } catch (error) {
      this.stopRender();
      this.destroyVideoElement();
      this.stopOutputStream();
      throw error;
    } finally {
      this.isLocked = false;
    }
  }

  startRender() {
    this.stopRender();
    const generation = ++this.renderGeneration;
    const render = (timestamp) => {
      if (generation !== this.renderGeneration || !this.videoEl || !this.canvas || !this.gl) return;
      if (this.videoEl.readyState >= 2 && timestamp - this.lastRenderTime >= this.renderInterval) {
        this.lastRenderTime = timestamp;
        const gl = this.gl;
        gl.useProgram(this.program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.videoEl);
          gl.uniform1i(this.uniLocs.image, 0);
          gl.uniform1f(this.uniLocs.whitening, this.enabled ? this.params.whitening : 0.0);
          gl.uniform1f(this.uniLocs.smoothing, this.enabled ? this.params.smoothing : 0.0);
          gl.uniform1f(this.uniLocs.softLight, this.enabled ? this.params.softLight : 0.0);
          gl.uniform1i(this.uniLocs.enabled, this.enabled ? 1 : 0);
          gl.uniform2f(this.uniLocs.texelSize, 1.0 / this.canvas.width, 1.0 / this.canvas.height);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        } catch (error) {
          console.warn('[BeautyEngine] frame render skipped', error);
        }
      }
      if (generation === this.renderGeneration && this.videoEl) this.animId = requestAnimationFrame(render);
    };
    this.animId = requestAnimationFrame(render);
  }

  stopRender() {
    this.renderGeneration += 1;
    if (this.animId != null) {
      try { cancelAnimationFrame(this.animId); } catch {}
      this.animId = null;
    }
  }

  stopOutputStream() {
    if (this.outputStream) {
      this.outputStream.getTracks().forEach(track => { try { track.stop(); } catch {} });
      this.outputStream = null;
    }
  }

  setBeauty(newParams) { Object.assign(this.params, newParams); }
  setEnabled(status) { this.enabled = status; }
  
  setCameraEnabled(status) {
    const enabled = Boolean(status);
    this.rawStream?.getVideoTracks().forEach(track => { track.enabled = enabled; });
  }

  destroyVideoElement() {
    if (!this.videoEl) return;
    try {
      this.videoEl.pause();
      this.videoEl.srcObject = null;
      this.videoEl.removeAttribute('src');
      this.videoEl.remove();
    } catch {}
    this.videoEl = null;
  }

  destroy(options = {}) {
    this.stopRender();
    this.destroyVideoElement();
    this.stopOutputStream();
    const stopRawTracks = options.stopRawTracks !== false;
    if (stopRawTracks && this.rawStream) {
      this.rawStream.getTracks().forEach(track => { try { track.stop(); } catch {} });
    }
    this.rawStream = null;
    this.isLocked = false;
  }
}

window.BeautyEngine = new BeautyEngineClass();

// ── engine/overlay/call-ui.js ──────────────────────────────────────────────
// call-ui.js - 音视频 UI 与交互控制独立模块（带防错保护）
(function(window) {
  "use strict";

  class CallUIModule {
    constructor() {
      this.container = null;
      this.isAudioMuted = false;
      this.volumeLevel = 1.0;
      this.onToggleCam = null;
      this.onHangup = null;
      this.onAccept = null;
      this.onReject = null;
    }

    // 初始化/注入音视频 UI 结构到页面
    init(parentElement) {
      if (!parentElement) {
        console.error("[CallUI] 父容器不存在，无法初始化音视频 UI");
        return;
      }
      if (document.getElementById("video")) return;

      const div = document.createElement("div");
      div.id = "video";
      div.className = "video";
      div.innerHTML = `
        <style>
          @keyframes audioPulse {
            0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(79, 172, 254, 0.6); }
            70% { transform: scale(1.06); box-shadow: 0 0 0 25px rgba(79, 172, 254, 0); }
            100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(79, 172, 254, 0); }
          }
          @keyframes soundWave {
            0%, 100% { transform: scaleY(0.3); }
            50% { transform: scaleY(1.2); }
          }
          .audio-wave-bar {
            width: 4px;
            height: 28px;
            background: linear-gradient(to top, #4facfe, #00f2fe);
            border-radius: 2px;
            animation: soundWave 1.2s infinite ease-in-out;
          }
          /* 音量进度条：锚定在控制栏上方居中，绝对定位不占布局 → 不会漂移 */
          .vol-bar {
            display: none;
            position: absolute;
            left: 50%;
            bottom: 100%;
            transform: translateX(-50%);
            margin-bottom: 16px;
            background: rgba(20,20,20,0.92);
            backdrop-filter: blur(8px);
            padding: 10px 16px;
            border-radius: 14px;
            flex-direction: column;
            align-items: center;
            gap: 8px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.5);
            z-index: 30;
            border: 1px solid rgba(255,255,255,0.1);
          }
          .vol-bar.on { display: flex; }
          .vol-bar span { font-size: 11px; color: #4facfe; font-weight: 600; }
          .vol-bar input[type="range"] { width: 180px; accent-color: #4facfe; cursor: pointer; }
        </style>
        
        <div class="call-banner" id="callBanner">
          <div class="avatar" id="callAvatar">📞</div>
          <div class="call-title" id="callTitle">收到呼叫…</div>
          <div class="call-actions" id="callActions">
            <button class="ctrl answer" id="acceptCall">接听</button>
            <button class="ctrl hang" id="rejectCall">拒绝</button>
          </div>
        </div>

        <!-- 音频通话专用动效视图 -->
        <div id="audioCallView" style="display:none; position:absolute; inset:0; background:radial-gradient(circle, #1a1c29 0%, #0d0e15 100%); flex-direction:column; align-items:center; justify-content:center; z-index:2;">
          <div style="width:100px; height:100px; border-radius:50%; background:linear-gradient(135deg, #4facfe, #00f2fe); display:flex; align-items:center; justify-content:center; font-size:42px; box-shadow:0 0 40px rgba(79,172,254,0.4); animation: audioPulse 2s infinite;">🎙️</div>
          <div id="audioCallTitle" style="color:#fff; font-size:18px; font-weight:600; margin-top:24px; letter-spacing:1px;">语音通话进行中</div>
          <div style="display:flex; gap:6px; margin-top:20px; align-items:center; height:40px;">
            <div class="audio-wave-bar" style="animation-delay: 0s;"></div>
            <div class="audio-wave-bar" style="animation-delay: 0.2s;"></div>
            <div class="audio-wave-bar" style="animation-delay: 0.4s;"></div>
            <div class="audio-wave-bar" style="animation-delay: 0.6s;"></div>
            <div class="audio-wave-bar" style="animation-delay: 0.8s;"></div>
          </div>
        </div>

        <video id="remote" class="remote" autoplay playsinline webkit-playsinline></video>
        <video id="local" class="local" autoplay muted playsinline webkit-playsinline></video>
        
        <div class="beauty-panel" id="beautyPanel">
          <div class="beauty-row">
            <label>美白</label>
            <input type="range" id="rangeWhitening" min="0" max="1" step="0.05" value="0.4">
          </div>
          <div class="beauty-row">
            <label>磨皮</label>
            <input type="range" id="rangeSmoothing" min="0" max="1" step="0.05" value="0.5">
          </div>
          <div class="beauty-row">
            <label>柔光</label>
            <input type="range" id="rangeSoftLight" min="0" max="1" step="0.05" value="0.3">
          </div>
          <div class="beauty-actions">
            <button class="beauty-btn active" id="btnToggleBeauty">美颜开</button>
            <button class="beauty-btn" id="btnOriginalCompare">按住看原图</button>
          </div>
        </div>

        <div class="controls" id="inCallControls" style="display:none; align-items:center; gap:12px; position:relative;">
          <!-- 音量进度条（长按声音键出现，锚定在控制栏上方居中，不漂移） -->
          <div id="volBar" class="vol-bar">
            <span id="volVal">100%</span>
            <input type="range" id="volRange" min="0" max="1" step="0.02" value="1">
          </div>

          <!-- 音频通话按钮：短按禁音（远端声音），长按弹出音量进度条 -->
          <button class="ctrl" id="soundBtn" title="短按禁音 · 长按调音量" style="touch-action:none">🔊</button>
          <button class="ctrl" id="cam" title="摄像头开关">📹</button>
          <button class="ctrl" id="beautyBtn" title="美颜">✨</button>
          <button class="ctrl hang" id="hang" title="挂断">☎</button>
        </div>
      `;
      parentElement.appendChild(div);
      this.bindEvents();
    }

    bindEvents() {
      const soundBtn = document.getElementById("soundBtn");
      const volBar = document.getElementById("volBar");
      const volRange = document.getElementById("volRange");
      const volVal = document.getElementById("volVal");
      const remoteVid = document.getElementById("remote");

      // 音频通话按钮手势：
      //   短按 = 禁音 / 取消禁音（远端声音）
      //   长按(≥260ms) = 弹出锚定的音量进度条（拖动调音量）
      let pressTimer = null;
      let longPressed = false;

      const showVol = () => { if (volBar) volBar.classList.add("on"); };
      const hideVol = () => { if (volBar) volBar.classList.remove("on"); };

      if (soundBtn) {
        soundBtn.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          longPressed = false;
          pressTimer = setTimeout(() => { longPressed = true; showVol(); }, 260);
        });
        const endPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
        soundBtn.addEventListener("pointerup", () => {
          endPress();
          if (!longPressed) this.toggleRemoteAudio();   // 短按：禁音 / 恢复远端声音
        });
        soundBtn.addEventListener("pointerleave", endPress);
        soundBtn.addEventListener("pointercancel", endPress);
        // 长按结束后浏览器会补发一次 click，这里吞掉，避免误触静音
        soundBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (longPressed) { longPressed = false; return; }
        });
      }

      // 点击空白处收起音量条
      document.addEventListener("click", hideVol);
      if (volBar) volBar.addEventListener("click", e => e.stopPropagation());

      // 实时音量调节（拖动进度条）
      if (volRange) {
        volRange.oninput = e => {
          const val = parseFloat(e.target.value);
          if (volVal) volVal.textContent = Math.round(val * 100) + "%";
          if (remoteVid) remoteVid.volume = val;
        };
      }

      // 绑定其他控制按钮
      document.getElementById("cam").onclick = () => this.onToggleCam?.();
      document.getElementById("beautyBtn").onclick = () => {
        const panel = document.getElementById("beautyPanel");
        if (panel) panel.classList.toggle("on");
      };
      document.getElementById("hang").onclick = () => this.onHangup?.();
      document.getElementById("acceptCall").onclick = () => this.onAccept?.();
      document.getElementById("rejectCall").onclick = () => this.onReject?.();
    }

    toggleRemoteAudio() {
      const remoteVid = document.getElementById("remote");
      const soundBtn = document.getElementById("soundBtn");
      if (!remoteVid) return;
      remoteVid.muted = !remoteVid.muted;
      if (soundBtn) {
        soundBtn.textContent = remoteVid.muted ? "🔇" : "🔊";
        soundBtn.style.opacity = remoteVid.muted ? "0.6" : "1";
      }
    }

    updateLayout(kind) {
      const isVideo = kind === "video";
      const videoDiv = document.getElementById("video");
      if (videoDiv) videoDiv.classList.toggle("video-mode", isVideo);
      
      const audioCallView = document.getElementById("audioCallView");
      const remoteVid = document.getElementById("remote");
      const localVid = document.getElementById("local");
      const camBtn = document.getElementById("cam");
      const beautyBtn = document.getElementById("beautyBtn");

      if (audioCallView) audioCallView.style.display = isVideo ? "none" : "flex";
      if (remoteVid) remoteVid.style.display = isVideo ? "block" : "none";
      if (localVid) localVid.style.display = isVideo ? "block" : "none";
      if (camBtn) camBtn.style.display = isVideo ? "flex" : "none";
      if (beautyBtn) beautyBtn.style.display = isVideo ? "flex" : "none";
    }
  }

  // 确保全局挂载
  window.CallUI = new CallUIModule();
})(window);

// ── engine/state.js ──────────────────────────────────────────────
/**
 * state.js — 驱动唯一状态对象（内部）
 *
 * 所有模块共享同一实例；状态变化一律经 bus.emit() 广播，组件只订阅。
 */

const S = {
  room: null,
  pass: null,
  ws: null,
  lobbyWs: null,
  peerId: null,
  name: null,
  discoverable: true,
  chatPc: null,
  dc: null,
  callPc: null,
  local: null,
  remote: null,
  caller: false,
  rx: new Map(),
  rxActive: null,
  chatCandidateQueue: [],
  callCandidateQueue: [],
  audioCtx: null,
  ringOscs: [],
  mediaRecorder: null,
  audioChunks: [],
  recTimer: null,
  recSeconds: 0,
  recPeaks: [],
  recAnalyser: null,
  recCtx: null,
  recBuf: null,
  recTick: 0,
  lastTypingSent: 0,
  typingTimer: null,
  call: null,
  callTimer: null,
  endedCalls: new Set(),
  phase: 'idle',
  roster: []
};

// ── engine/bus.js ──────────────────────────────────────────────
/**
 * bus.js — 事件总线（内部）
 *
 * 铁律：所有状态变化通过 emit() 广播，组件只订阅，不直接读内部状态。
 */

const listeners = new Set();

function emit(ev) {
  for (const cb of Array.from(listeners)) {
    try { cb(ev); } catch (e) { console.warn('[core] listener error', e); }
  }
}

function subscribe(cb) {
  if (typeof cb !== 'function') return () => {};
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function setPhase(p, detail) {
  if (S.phase === p && !detail) return;
  S.phase = p;
  emit({ type: 'state', phase: p, detail: detail || null });
}

// ── engine/utils.js ──────────────────────────────────────────────
/**
 * utils.js — 内部工具（驱动内部实现，零外露）
 *
 * $ 是唯一的 DOM 读取入口（冻结层 CallSignalingAdapter / call-ui 需要）。
 */

const $ = id => document.getElementById(id);

const esc = x => String(x).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function safeUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

const genId = () => 'm_' + safeUUID().slice(0, 8) + Date.now().toString(36).slice(-4);

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// 统一结果形状：业务失败不 reject
const ok = data => ({ ok: true, data });
const fail = (code, detail) => ({ ok: false, code, detail: detail || null });

// ── engine/env.js ──────────────────────────────────────────────
/**
 * env.js —— 引擎的宿主环境注入点
 *
 * 1. 存储：原工程直接用 localStorage（同步）。驱动在母体里不能碰宿主 localStorage
 *    （宪法第 12 条：不把用户数据写到未声明位置），改由 ctx-bridge 注入一个
 *    同步接口、底层走 ctx.kv 的适配器。
 * 2. 后端：原工程从 <meta name="zsjws-backend"> 推导；驱动改为由装载方注入，
 *    默认取 zsjws 的生产后端，保证「按 zsjws 的后端配置封装」。
 */

const mem = new Map()

/** 默认实现：纯内存。注入后会代理到注入方。 */
let adapter = null

const storage = {
  getItem(key) {
    if (adapter) {
      try { return adapter.get(String(key)) } catch (_) { return null }
    }
    return mem.has(String(key)) ? mem.get(String(key)) : null
  },
  setItem(key, value) {
    const k = String(key)
    const v = String(value)
    if (adapter) {
      try { adapter.set(k, v); return } catch (_) { /* 落回内存 */ }
    }
    mem.set(k, v)
  },
  removeItem(key) {
    const k = String(key)
    if (adapter) {
      try { adapter.remove(k); return } catch (_) { /* 落回内存 */ }
    }
    mem.delete(k)
  },
}

/** 由 ctx-bridge 注入（接口：get/set/remove，同步）。 */
function setStorage(a) {
  adapter = a || null
}

/** 驱动默认后端：与 zsjws 线上一致。装载方可覆盖。 */
const DEFAULT_BACKEND = 'https://quakeai.tech'

let backendOverride = null

function setBackend(url) {
  const v = String(url || '').trim().replace(/\/+$/, '')
  backendOverride = v || null
}

function getBackendOverride() {
  return backendOverride
}

// ── engine/config.js ──────────────────────────────────────────────
/**
 * config.js — 寻址与鉴权配置（驱动内部）
 *
 * 默认从页面环境推导（meta[name=zsjws-backend] / location.origin）；
 * mount(config) 可用 signalingUrl / backendUrl / auth 覆盖。
 * 部署在带访问控制的网关（例如带 sharecode 的分享链接）之后时，
 * 请求必须携带鉴权参数，否则网关直接 403。
 */

const deriveBackend = () => {
  try {
    const m = document.querySelector('meta[name="zsjws-backend"]');
    const v = (m && m.content ? String(m.content) : '').trim().replace(/\/+$/, '');
    return v || DEFAULT_BACKEND;
  } catch { return DEFAULT_BACKEND; }
};

const deriveWsBase = backend => {
  if (/^https?:\/\//.test(backend)) return backend.replace(/^http/, 'ws');
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
};

// URL 上的 sharecode（页面加载时取一次，作为 auth 的默认值）
const SHARE_CODE = (() => {
  try {
    const v = new URLSearchParams(location.search).get('sharecode');
    return v ? String(v).trim() : '';
  } catch { return ''; }
})();

const CFG = {
  backend: deriveBackend(),
  signalingUrl: null,   // mount(config) 覆盖：完整 WS 基址（如 wss://host/zsjws/ws）
  auth: null            // mount(config) 覆盖：鉴权参数（默认取 URL sharecode）
};

const getBackend = () => CFG.backend;
const getSignalingUrl = () => CFG.signalingUrl;
const getShareCode = () => CFG.auth ?? SHARE_CODE;

const wsBase = () => deriveWsBase(CFG.backend);
const WB = () => CFG.signalingUrl || `${wsBase()}/zsjws/ws`;
const LOBBY = () => withAuth(`${wsBase()}/zsjws/lobby`);
const API = () => `${CFG.backend}/zsjws/api`;

function withAuth(url) {
  const code = getShareCode();
  if (!code) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}sharecode=${encodeURIComponent(code)}`;
}

/** mount(config) 调用：覆盖寻址与鉴权（仅首次 mount 前有效语义） */
function configure(overrides = {}) {
  if (overrides.backendUrl) CFG.backend = String(overrides.backendUrl).replace(/\/+$/, '');
  if (overrides.signalingUrl) CFG.signalingUrl = String(overrides.signalingUrl);
  if (overrides.auth != null) CFG.auth = String(overrides.auth);
}

// ── engine/signaling/ice.js ──────────────────────────────────────────────
/**
 * signaling/ice.js — ICE 配置（驱动内部）
 *
 * 默认内置国内 STUN；mount(config.iceServers) 可覆盖。
 * STUN 策略（含谷歌 STUN 兜底议题）在此决策，不随部署扩散。
 */

let RTC_CONFIG = {
  iceServers: [{ urls: ['stun:quakeai.tech:3478', 'stun:stun.qq.com:3478', 'stun:stun.miwifi.com:3478'] }],
  iceCandidatePoolSize: 0,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
};

function getRtcConfig() {
  return RTC_CONFIG;
}

/** mount(config) 注入的自定义 ICE 覆盖（可选） */
function overrideIceServers(iceServers) {
  if (Array.isArray(iceServers) && iceServers.length) {
    RTC_CONFIG = { ...RTC_CONFIG, iceServers };
  }
}

let iceConfigPromise = null;

function loadIceConfig() {
  if (!iceConfigPromise) {
    // credentials 用 omit：跨域后端返回 Access-Control-Allow-Origin: * 时
    // 不能携带凭证（浏览器会直接拒绝），同域部署无影响
    iceConfigPromise = fetch(withAuth(`${API()}/ice`), { cache: 'no-store', credentials: 'omit' })
      .then(async r => {
        if (!r.ok) throw new Error(`ICE 配置获取失败 (${r.status})`);
        const d = await r.json();
        if (!d || !Array.isArray(d.iceServers) || !d.iceServers.length) throw new Error('ICE 配置为空');
        RTC_CONFIG = { ...RTC_CONFIG, iceServers: d.iceServers, iceCandidatePoolSize: 0, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' };
        return RTC_CONFIG;
      })
      .catch(e => {
        console.warn('[ICE] 使用内置 STUN 兜底：', e.message);
        return RTC_CONFIG;
      });
  }
  return iceConfigPromise;
}

// ── engine/constants.js ──────────────────────────────────────────────
/**
 * constants.js — 驱动内部常量（驱动内部实现，零外露）
 */

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const CHUNK_SIZE = 16 * 1024;
const SEND_HIGH_WATER = 64 * 1024;
const CALL_TIMEOUT_MS = 30000;

// typing 节流：2.5s 内只发一次；对端 4s 无新信号自动熄灭
const TYPING_THROTTLE_MS = 2500;
const TYPING_TTL_MS = 4000;

// 语音波形：桶数固定 48（与 UI 渲染的条数一致）；对端 peaks 不可信输入的上限
const PEAK_BUCKETS = 48;
const MAX_PEAKS = 128;

// 聊天表情（页面数据；组件侧自备副本，此处为驱动内部默认值）
const EMOJIS = ['😀','😂','🥹','😍','🥺','😎','👍','❤️','🔥','🎉','🚀','💯','🫣','🤣','🫡','✨','🤔','🙈','💩','🤝'];

// ── engine/messages/queue.js ──────────────────────────────────────────────
/**
 * messages/queue.js — 发送串行队列（驱动内部）
 *
 * 修并发串包：所有 DC 发送走同一队列，并按 bufferedAmount 背压。
 */

let sendQueue = Promise.resolve();

function enqueue(task) {
  const p = sendQueue.then(task, task);
  sendQueue = p.catch(() => null);
  return p;
}

async function rawSend(data) {
  while (S.dc && S.dc.bufferedAmount > SEND_HIGH_WATER) {
    await new Promise(r => setTimeout(r, 15));
    if (!S.dc) throw new Error('通道已关闭');
  }
  if (!S.dc || S.dc.readyState !== 'open') throw new Error('通道未就绪');
  S.dc.send(data);
}

// ── engine/messages/index.js ──────────────────────────────────────────────
/**
 * messages/index.js — 消息收发（驱动内部）
 *
 * 新协议 v1 + 旧协议兼容；文件分片经 queue 串行发送；
 * 对端输入（peaks/文件信息）一律校验形状。
 */

// ==================== 发送 ====================

async function sendText(text) {
  const body = String(text ?? '');
  if (!body.trim()) return fail('E_EMPTY');
  if (!S.dc || S.dc.readyState !== 'open') return fail('E_NOT_READY');

  const id = genId();
  const ts = Date.now();
  const msg = { id, dir: 'out', kind: 'text', ts, text: body, status: 'sending' };
  emit({ type: 'message', msg });

  try {
    await enqueue(() => rawSend(JSON.stringify({ v: 1, id, ts, kind: 'text', body })));
    emit({ type: 'message-update', id, patch: { status: 'sent' } });
    return ok({ id });
  } catch (e) {
    emit({ type: 'message-update', id, patch: { status: 'failed' } });
    return fail('E_SEND_FAILED', e.message);
  }
}

function sendTyping() {
  if (!S.dc || S.dc.readyState !== 'open') return false;
  const now = Date.now();
  if (now - S.lastTypingSent < TYPING_THROTTLE_MS) return false;
  S.lastTypingSent = now;
  // rawSend 是 async，不 await（typing 不需要送达保证），但必须挂 catch
  rawSend(JSON.stringify({ v: 1, kind: 'typing' })).catch(() => {});
  return true;
}

// peaks：语音波形振幅（0..1 数组）。来自对端，属不可信输入，必须校验形状：
// 限制长度并 clamp，否则一个超大数组会拖垮渲染。
function sanitizePeaks(v) {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_PEAKS) return null;
  const out = [];
  for (const n of v) {
    const x = Number(n);
    if (!Number.isFinite(x)) return null;
    out.push(Math.min(1, Math.max(0, x)));
  }
  return out;
}

function kindOf(mime, name) {
  if (mime?.startsWith('image/')) return 'image';
  if (mime?.startsWith('video/')) return 'video';
  if (mime?.startsWith('audio/')) return 'audio';
  if (/\.(png|jpe?g|gif|webm|bmp|heic)$/i.test(name || '')) return 'image';
  if (/\.(mp4|mov|webm|mkv)$/i.test(name || '')) return 'video';
  if (/\.(mp3|wav|m4a|aac|ogg|webm)$/i.test(name || '')) return 'audio';
  return 'file';
}

async function sendBlob(blob, meta = {}) {
  if (!S.dc || S.dc.readyState !== 'open') return fail('E_NOT_READY');
  if (!blob || blob.size > MAX_FILE_SIZE) return fail('E_TOO_LARGE');

  const id = genId();
  const ts = Date.now();
  const name = meta.name || blob.name || 'file';
  const mime = meta.mime || blob.type || 'application/octet-stream';
  const kind = meta.kind || kindOf(mime, name);
  const url = URL.createObjectURL(blob);
  const msg = {
    id, dir: 'out', kind, ts, status: 'sending',
    name, size: blob.size, mime, url,
    duration: meta.duration || null,
    peaks: meta.peaks || null,
    progress: 0
  };
  emit({ type: 'message', msg });

  try {
    await enqueue(async () => {
      await rawSend(JSON.stringify({
        v: 1, id, ts, kind: 'file',
        fileId: id, name, size: blob.size, mime, duration: meta.duration || null,
        peaks: meta.peaks || null
      }));
      let sent = 0;
      for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE) {
        const chunk = await blob.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
        await rawSend(chunk);
        sent += chunk.byteLength;
        const pct = Math.min(100, Math.round((sent / blob.size) * 100));
        emit({ type: 'message-update', id, patch: { progress: pct } });
      }
      await rawSend(JSON.stringify({ v: 1, type: 'file-end', fileId: id }));
    });
    emit({ type: 'message-update', id, patch: { status: 'sent', progress: 100 } });
    return ok({ id });
  } catch (e) {
    emit({ type: 'message-update', id, patch: { status: 'failed' } });
    return fail('E_SEND_FAILED', e.message);
  }
}

async function sendFiles(fileList, onEach) {
  const out = [];
  for (const f of Array.from(fileList)) {
    if (f.size > MAX_FILE_SIZE) { out.push(fail('E_TOO_LARGE', f.name)); continue; }
    out.push(await sendBlob(f, { name: f.name, mime: f.type }));
    onEach?.();
  }
  return out;
}

// ==================== 接收 ====================

function handleData(x) {
  if (typeof x === 'string') {
    let d;
    try { d = JSON.parse(x); } catch { return; }

    // ---- 新协议 v1 ----
    if (d && d.v === 1) {
      if (d.kind === 'typing') {
        emit({ type: 'typing', on: true });
        if (S.typingTimer) clearTimeout(S.typingTimer);
        S.typingTimer = setTimeout(() => {
          S.typingTimer = null;
          emit({ type: 'typing', on: false });
        }, TYPING_TTL_MS);
        return;
      }
      if (d.kind === 'text') {
        emit({ type: 'message', msg: { id: d.id || genId(), dir: 'in', kind: 'text', ts: d.ts || Date.now(), text: String(d.body ?? ''), status: 'received' } });
        return;
      }
      if (d.kind === 'file') {
        if (typeof d.fileId !== 'string' || !d.fileId) return;
        if (!Number.isSafeInteger(d.size) || d.size < 0 || d.size > MAX_FILE_SIZE) {
          emit({ type: 'system', text: '对方发送的文件信息无效或超过 100MB' });
          return;
        }
        S.rx.set(d.fileId, {
          id: d.fileId, name: String(d.name || '未命名文件').slice(0, 255),
          size: d.size, mime: String(d.mime || 'application/octet-stream').slice(0, 128),
          duration: d.duration || null, ts: d.ts || Date.now(),
          peaks: sanitizePeaks(d.peaks),
          chunks: [], received: 0
        });
        S.rxActive = d.fileId;
        return;
      }
      if (d.type === 'file-end') { finishFile(d.fileId); return; }
      return;
    }

    // ---- 旧协议兼容（无 v 字段） ----
    if (d.type === 'text') {
      emit({ type: 'message', msg: { id: genId(), dir: 'in', kind: 'text', ts: Date.now(), text: String(d.text ?? ''), status: 'received' } });
      return;
    }
    if (d.type === 'file-start') {
      if (typeof d.id !== 'string' || !d.id || !Number.isSafeInteger(d.size) || d.size < 0 || d.size > MAX_FILE_SIZE) {
        emit({ type: 'system', text: '对方发送的文件信息无效或超过 100MB' });
        return;
      }
      S.rx.set(d.id, {
        id: d.id, name: String(d.name || '未命名文件').slice(0, 255),
        size: d.size, mime: String(d.mime || 'application/octet-stream').slice(0, 128),
        duration: null, ts: Date.now(), chunks: [], received: 0
      });
      S.rxActive = d.id;
      return;
    }
    if (d.type === 'file-end') { finishFile(d.id); return; }
    return;
  }

  // ---- 二进制块：只归当前在途文件（发送端已串行，不会串包） ----
  if (!S.rxActive) return;
  const f = S.rx.get(S.rxActive);
  if (!f) return;
  const len = x.byteLength ?? x.size ?? 0;
  if (f.received + len > f.size || f.received + len > MAX_FILE_SIZE) {
    S.rx.delete(S.rxActive); S.rxActive = null;
    emit({ type: 'system', text: '接收文件大小异常，已中止' });
    return;
  }
  f.chunks.push(x);
  f.received += len;
  const pct = f.size ? Math.min(100, Math.round((f.received / f.size) * 100)) : 100;
  emit({ type: 'receive-progress', id: f.id, pct });
}

function finishFile(id) {
  const f = S.rx.get(id);
  if (!f) return;
  if (f.received !== f.size) {
    S.rx.delete(id); if (S.rxActive === id) S.rxActive = null;
    emit({ type: 'system', text: '文件接收不完整，已丢弃' });
    return;
  }
  const blob = new Blob(f.chunks, { type: f.mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  emit({
    type: 'message',
    msg: {
      id: f.id, dir: 'in', kind: kindOf(f.mime, f.name), ts: f.ts,
      name: f.name, size: f.size, mime: f.mime, url,
      duration: f.duration, peaks: f.peaks || null, status: 'received'
    }
  });
  S.rx.delete(id);
  if (S.rxActive === id) S.rxActive = null;
}

// ── engine/ringtone/index.js ──────────────────────────────────────────────
/**
 * ringtone/index.js — 提示音（驱动内部行为，零外露）
 *
 * 接通即停：onConnectionState connected 由 peer 模块调用 stopRingtone()。
 * 修 caller 侧接通后仍在响的原版遗漏（2026-10-25）。
 */

function initAudioCtx() {
  if (!S.audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) S.audioCtx = new Ctx();
  }
  if (S.audioCtx?.state === 'suspended') S.audioCtx.resume();
}

function unlockAudioPlayback() {
  initAudioCtx();
  const v = $('remote');
  if (v) {
    if (!S.remote) S.remote = new MediaStream();
    v.srcObject = S.remote;
    v.muted = false;
    v.play().catch(err => { if (err.name !== 'AbortError') console.warn('unlock audio', err); });
  }
}

function stopRingtone() {
  if (S.ringOscs.timer) { clearTimeout(S.ringOscs.timer); S.ringOscs.timer = null; }
  S.ringOscs.forEach(o => { try { o.stop(); } catch {} });
  S.ringOscs = [];
}

function playRing(kind, outgoing) {
  try {
    initAudioCtx();
    if (!S.audioCtx) return;
    stopRingtone();
    const pattern = outgoing ? [440, 480] : [480, 620];
    const beep = (freq, start, dur) => {
      const o = S.audioCtx.createOscillator();
      const g = S.audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0, S.audioCtx.currentTime + start);
      g.gain.linearRampToValueAtTime(0.09, S.audioCtx.currentTime + start + 0.03);
      g.gain.linearRampToValueAtTime(0, S.audioCtx.currentTime + start + dur);
      o.connect(g); g.connect(S.audioCtx.destination);
      o.start(S.audioCtx.currentTime + start);
      o.stop(S.audioCtx.currentTime + start + dur + 0.02);
      S.ringOscs.push(o);
    };
    beep(pattern[0], 0, 0.35);
    beep(pattern[1], 0.45, 0.35);
    S.ringOscs.timer = setTimeout(() => { if (S.call) playRing(kind, outgoing); }, 1600);
  } catch (e) { console.warn('[ring]', e); }
}

// ── engine/links.js ──────────────────────────────────────────────
/**
 * links.js —— 晚绑定注册表（唯一目的：打破循环依赖）
 *
 * 原工程的三个模块互相 import，形成两个环：
 *   peer/index.js ⇄ signaling/client.js
 *   call/index.js → peer/index.js → signaling/client.js → call/index.js
 *
 * SDK 的拼接式打包器不支持循环依赖（顺序无解，直接构建失败）。
 * 解法：本文件**不 import 任何东西**，只放函数槽位；
 * 三个模块各自在文件底部把实现挂上来，调用点改成 `links.x(...)`。
 *
 * 语义不变：仍然是一次同步函数调用，没有事件往返、没有异步化。
 * 时序安全：拼接后所有模块先求值、后运行；调用发生在运行期，此时槽位已填满。
 */
const links = {
  // signaling/client.js 提供
  sig: null,
  // peer/index.js 提供
  offer: null,
  initChatPC: null,
  closeChatPC: null,
  initCallPC: null,
  closeCallPC: null,
  // call/index.js 提供
  getCallAdapter: null,
  clearCallTimer: null,
  clearCallState: null,
}

// ── engine/peer/index.js ──────────────────────────────────────────────
/**
 * peer/index.js — PeerConnection 管理（驱动内部）
 *
 * 聊天 PC（DataChannel）+ 通话 PC（媒体轨道）。底层 perfect negotiation
 * 由冻结层 PCManager 承担，本模块只做编排。
 */

function initChatPC() {
  if (S.chatPc) { try { S.chatPc.close(); } catch {} }
  S.chatPc = window.PCManager.create('chat', getRtcConfig(), {
    polite: !S.caller,
    onIceCandidate: candidate => links.sig({ type: 'ice', candidate }),
    onTrack: () => {},
    onIceState: state => {
      if (state === 'checking') setPhase('negotiating', '正在建立安全连接…');
      if (state === 'connected' || state === 'completed') setPhase('open');
      if (state === 'disconnected') setPhase('unstable', '网络波动，等待恢复…');
      if (state === 'failed') setPhase('failed', '聊天连接失败');
    },
    onError: e => console.warn('[chat PC]', e)
  }, { polite: !S.caller });
  S.chatPc.ondatachannel = e => { S.dc = e.channel; setupDC(S.dc); };
}

function closeChatPC() {
  window.PCManager?.close('chat');
  S.chatPc = null;
  S.chatCandidateQueue = [];
}

function initCallPC(callId) {
  const callEpoch = S.call?.epoch;
  S.callPc = window.PCManager.create('call', getRtcConfig(), {
    polite: S.call?.role === 'callee',
    onIceCandidate: candidate => {
      if (S.call?.id === callId && S.call?.epoch === callEpoch) links.sig({ type: 'call-ice', callId, candidate });
    },
    onTrack: e => {
      if (e.streams && e.streams[0]) {
        S.remote = e.streams[0];
      } else {
        if (!S.remote) S.remote = new MediaStream();
        if (!S.remote.getTracks().some(t => t.id === e.track.id)) S.remote.addTrack(e.track);
      }
      const v = $('remote');
      if (v) {
        v.srcObject = S.remote;
        v.muted = false;
        const p = v.play();
        if (p && p.catch) {
          p.catch(err => {
            if (err.name === 'AbortError') return;
            console.warn('Autoplay deferred:', err);
            emit({ type: 'toast', text: '🔊 点击屏幕任意处开启声音' });
            const resume = () => {
              v.play().catch(() => {});
              document.removeEventListener('click', resume);
              document.removeEventListener('touchend', resume);
            };
            document.addEventListener('click', resume, { once: true });
            document.addEventListener('touchend', resume, { once: true });
          });
        }
      }
    },
    onIceState: state => {
      if (S.call?.id !== callId || S.call?.epoch !== callEpoch) return;
      if (state === 'checking') emit({ type: 'call', state: 'connecting', detail: '正在穿透音视频连接…' });
      if (state === 'connected' || state === 'completed') emit({ type: 'call', state: 'media-ready' });
      if (state === 'disconnected') emit({ type: 'call', state: 'unstable' });
      if (state === 'failed') emit({ type: 'call', state: 'failed' });
    },
    onConnectionState: state => {
      if (S.call?.id !== callId || S.call?.epoch !== callEpoch) return;
      if (state === 'connected') {
        S.call.phase = 'active';
        window.CallCore?.transition('CONNECTED', callId, callEpoch);
        emit({ type: 'call', state: 'active' });
        // 接通即停止拨号提示音（修 caller 侧接通后仍在响的原版遗漏）
        stopRingtone();
      }
      if (state === 'failed') emit({ type: 'call', state: 'failed' });
    },
    onError: e => console.warn('[call PC]', e)
  }, { polite: S.call?.role === 'callee' });
}

function closeCallPC() {
  window.PCManager?.close('call');
  S.callPc = null;
  S.callCandidateQueue = [];
}

async function offer() {
  if (!S.chatPc) initChatPC();
  if (!S.dc) {
    S.dc = S.chatPc.createDataChannel('chat');
    setupDC(S.dc);
  }
  const o = await window.PCManager.makeOffer('chat');
  if (o) links.sig({ type: 'offer', offer: o });
}

// ==================== DataChannel ====================

function setupDC(c) {
  c.binaryType = 'arraybuffer';
  c.onopen = () => {
    setPhase('open');
    emit({ type: 'system', text: '端到端通道已建立' });
  };
  c.onmessage = e => handleData(e.data);
  c.onclose = () => {
    setPhase('closed', '通道断开');
    emit({ type: 'system', text: '通道已断开' });
  };
}

// 晚绑定：把本模块的实现交给 links（打破 peer ⇄ signaling 的环）
links.offer = offer;
links.initChatPC = initChatPC;
links.closeChatPC = closeChatPC;
links.initCallPC = initCallPC;
links.closeCallPC = closeCallPC;

// ── engine/roster/index.js ──────────────────────────────────────────────
/**
 * roster/index.js — 在线名册（发现邻居，驱动内部）
 */

let lobbyRetry = null;

function helloLobby() {
  if (!S.lobbyWs || S.lobbyWs.readyState !== 1) return;
  S.lobbyWs.send(JSON.stringify({
    type: 'hello',
    peerId: S.peerId,
    name: S.name,
    discoverable: S.discoverable
  }));
}

function goOnline() {
  if (S.lobbyWs && (S.lobbyWs.readyState === 0 || S.lobbyWs.readyState === 1)) return ok({ already: true });
  try {
    // capability: ws:<backend>（同上，受控越界）
    const w = new WebSocket(LOBBY());
    S.lobbyWs = w;
    w.onopen = () => {
      emit({ type: 'lobby', state: 'online' });
      helloLobby();
    };
    w.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'roster') {
        S.roster = Array.isArray(m.peers) ? m.peers : [];
        emit({ type: 'roster', peers: S.roster });
      } else if (m.type === 'invite') {
        emit({ type: 'invite', from: m.from || {}, kind: m.kind || 'text' });
      } else if (m.type === 'room-ready') {
        emit({ type: 'room-ready', roomId: m.roomId, password: m.password, from: m.from || null });
      } else if (m.type === 'invite-sent') {
        emit({ type: 'invite-sent', to: m.to });
      } else if (m.type === 'invite-failed') {
        emit({ type: 'toast', text: '对方已离线或拒绝' });
      }
    };
    w.onclose = () => {
      emit({ type: 'lobby', state: 'offline' });
      S.lobbyWs = null;
      if (lobbyRetry) clearTimeout(lobbyRetry);
      lobbyRetry = setTimeout(() => { if (S.discoverable) goOnline(); }, 5000);
    };
    w.onerror = () => {};
    return ok(null);
  } catch (e) {
    return fail('E_LOBBY', e.message);
  }
}

function invite(peerId) {
  if (!S.lobbyWs || S.lobbyWs.readyState !== 1) return Promise.resolve(fail('E_LOBBY_OFFLINE'));
  if (!peerId || peerId === S.peerId) return Promise.resolve(fail('E_BAD_PEER'));
  try {
    S.lobbyWs.send(JSON.stringify({ type: 'invite', to: peerId }));
    return Promise.resolve(ok({ to: peerId }));
  } catch (e) {
    return Promise.resolve(fail('E_LOBBY', e.message));
  }
}

function answerInvite(peerId, accept) {
  if (!S.lobbyWs || S.lobbyWs.readyState !== 1) return Promise.resolve(fail('E_LOBBY_OFFLINE'));
  try {
    S.lobbyWs.send(JSON.stringify({ type: 'invite-reply', to: peerId, accept: Boolean(accept) }));
    return Promise.resolve(ok(null));
  } catch (e) {
    return Promise.resolve(fail('E_LOBBY', e.message));
  }
}

// ── engine/identity/index.js ──────────────────────────────────────────────
/**
 * identity/index.js — 身份与本地持久化（驱动内部）
 *
 * 只存房号/密码/昵称，不存消息。
 */

function persistRoom() {
  try {
    if (!S.room) return;
    storage.setItem('zsjws_last_room', JSON.stringify({ room: S.room, pass: S.pass, ts: Date.now() }));
    if (S.pass) storage.setItem('zsjws_pass_' + S.room, S.pass);
  } catch {}
}

function loadPersistedRoom() {
  try {
    const raw = storage.getItem('zsjws_last_room');
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d?.room || !d?.pass) return null;
    if (Date.now() - d.ts > 2 * 60 * 60 * 1000) { storage.removeItem('zsjws_last_room'); return null; }
    return d;
  } catch {
    storage.removeItem('zsjws_last_room');
    return null;
  }
}

function loadIdentity() {
  try {
    S.peerId = storage.getItem('zsjws_peer_id') || null;
    S.name = storage.getItem('zsjws_name') || null;
    // 新用户默认可被发现（IM 式体验）；老用户尊重已存偏好
    const saved = storage.getItem('zsjws_discoverable');
    S.discoverable = saved === null ? true : saved === '1';
  } catch {}
  if (!S.peerId) {
    S.peerId = 'p_' + safeUUID().replace(/-/g, '').slice(0, 12);
    try { storage.setItem('zsjws_peer_id', S.peerId); } catch {}
  }
  if (!S.name) {
    S.name = '访客-' + S.peerId.slice(-4).toUpperCase();
    try { storage.setItem('zsjws_name', S.name); } catch {}
  }
}

function setName(name) {
  const v = String(name || '').trim().slice(0, 24);
  if (!v) return fail('E_BAD_NAME');
  S.name = v;
  try { storage.setItem('zsjws_name', v); } catch {}
  if (S.lobbyWs && S.lobbyWs.readyState === 1) helloLobby();
  emit({ type: 'identity', peerId: S.peerId, name: S.name });
  return ok({ name: S.name });
}

function setDiscoverable(on) {
  S.discoverable = Boolean(on);
  try { storage.setItem('zsjws_discoverable', S.discoverable ? '1' : '0'); } catch {}
  if (S.lobbyWs && S.lobbyWs.readyState === 1) helloLobby();
  emit({ type: 'discoverable', value: S.discoverable });
  return ok({ discoverable: S.discoverable });
}

// ── engine/media/recording.js ──────────────────────────────────────────────
/**
 * media/recording.js — 语音录制（驱动内部）
 *
 * MediaRecorder + 波形峰值采集；波形桶数固定 48（与 UI 渲染条数一致）。
 * 录音时长不定，发送前统一重采样到 PEAK_BUCKETS。
 */

function resamplePeaks(arr, n) {
  if (!Array.isArray(arr) || !arr.length) return null;
  if (arr.length <= n) return arr.slice();
  const out = [];
  const step = arr.length / n;
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * step);
    const b = Math.min(arr.length, Math.max(a + 1, Math.floor((i + 1) * step)));
    let m = 0;
    for (let j = a; j < b; j++) if (arr[j] > m) m = arr[j];
    out.push(m);
  }
  return out;
}

function pushPeak(v) {
  S.recPeaks.push(v);
  if (S.recPeaks.length >= PEAK_BUCKETS * 2) {
    const half = [];
    for (let i = 0; i < S.recPeaks.length; i += 2) {
      half.push(Math.max(S.recPeaks[i], S.recPeaks[i + 1] ?? 0));
    }
    S.recPeaks = half;
  }
}

function stopPeakMeter() {
  if (S.recTick) { clearInterval(S.recTick); S.recTick = 0; }
  S.recAnalyser = null;
  S.recBuf = null;
  if (S.recCtx) { try { S.recCtx.close(); } catch {} S.recCtx = null; }
}

function startPeakMeter(stream) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;                       // 无 AudioContext：波形降级为静态，录音照常
  try {
    const ctx = new AC();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    S.recCtx = ctx;
    S.recAnalyser = an;
    S.recBuf = new Uint8Array(an.fftSize);
  } catch {}
}

async function startRecording() {
  if (S.mediaRecorder && S.mediaRecorder.state === 'recording') return fail('E_ALREADY_RECORDING');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    S.audioChunks = [];
    S.recPeaks = [];
    S.mediaRecorder = new MediaRecorder(stream);
    S.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) S.audioChunks.push(e.data); };
    S.mediaRecorder.start();
    S.recSeconds = 0;
    startPeakMeter(stream);
    S.recTimer = setInterval(() => {
      S.recSeconds++;
      emit({ type: 'recording', seconds: S.recSeconds, peaks: S.recPeaks.slice() });
    }, 1000);
    S.recTick = setInterval(() => {
      if (!S.recAnalyser || !S.recBuf) return;
      S.recAnalyser.getByteTimeDomainData(S.recBuf);
      let peak = 0;
      for (let i = 0; i < S.recBuf.length; i++) {
        const d = Math.abs(S.recBuf[i] - 128) / 128;
        if (d > peak) peak = d;
      }
      pushPeak(Math.min(1, peak * 1.6));
      emit({ type: 'recording', seconds: S.recSeconds, peaks: S.recPeaks.slice() });
    }, 100);
    emit({ type: 'recording', seconds: 0, peaks: [] });
    return ok(null);
  } catch (e) {
    return fail('E_MIC', e.message);
  }
}

function cancelRecording() {
  if (S.recTimer) { clearInterval(S.recTimer); S.recTimer = null; }
  stopPeakMeter();
  if (S.mediaRecorder) {
    try { S.mediaRecorder.stream.getTracks().forEach(t => t.stop()); } catch {}
    S.mediaRecorder = null;
  }
  S.audioChunks = [];
  S.recPeaks = [];
  emit({ type: 'recording', seconds: -1, peaks: [] });
  return ok(null);
}

function stopAndSendRecording() {
  return new Promise(resolve => {
    if (!S.mediaRecorder) return resolve(fail('E_NO_RECORDING'));
    const seconds = S.recSeconds;
    const peaks = S.recPeaks.slice();
    if (S.recTimer) { clearInterval(S.recTimer); S.recTimer = null; }
    stopPeakMeter();
    const rec = S.mediaRecorder;
    rec.onstop = async () => {
      try {
        const blob = new Blob(S.audioChunks, { type: rec.mimeType || 'audio/webm' });
        try { rec.stream.getTracks().forEach(t => t.stop()); } catch {}
        S.mediaRecorder = null;
        S.audioChunks = [];
        S.recPeaks = [];
        emit({ type: 'recording', seconds: -1, peaks: [] });
        if (blob.size < 1200) return resolve(fail('E_TOO_SHORT'));
        const r = await sendBlob(blob, {
          name: `voice_${Date.now()}.webm`,
          mime: blob.type,
          kind: 'audio',
          duration: seconds,
          peaks: resamplePeaks(peaks, PEAK_BUCKETS)
        });
        resolve(r);
      } catch (e) {
        resolve(fail('E_SEND_FAILED', e.message));
      }
    };
    try { rec.stop(); } catch (e) { resolve(fail('E_RECORD', e.message)); }
  });
}

// ── engine/signaling/client.js ──────────────────────────────────────────────
/**
 * signaling/client.js — 信令客户端与分派（驱动内部）
 *
 * 房间 WS 生命周期 + 信令分派（聊天协商走本模块，呼叫信令走冻结层
 * CallSignalingAdapter）。协议细节零外露。
 */

function sig(x) {
  if (S.ws?.readyState === 1) {
    try { S.ws.send(JSON.stringify(x)); } catch (e) { console.warn('[sig]', e); }
  }
}

function connect(p) {
  return new Promise((resolve, reject) => {
    cleanup();
    loadIceConfig().finally(() => {
      let settled = false;
      // capability: ws:<backend>（母体能力目录暂无 ws 项；母体 CSP 已放行，
      // 按受控越界直连。见 README「能力与越界」与 RELEASE.json）
      const url = withAuth(`${WB()}/${encodeURIComponent(S.room)}?password=${encodeURIComponent(p)}`);
      const w = new WebSocket(url);
      S.ws = w;
      setPhase('connecting');

      w.onopen = () => {
        settled = true;
        persistRoom();
        setPhase('online');
        resolve(ok({ roomId: S.room }));
      };
      w.onerror = (e) => {
        if (!settled) { settled = true; reject(new Error('WebSocket 连接失败')); }
        else if (typeof console !== 'undefined') { console.warn('[sig] 通信异常', e && e.message ? e.message : ''); }
      };
      w.onclose = (e) => {
        if (settled) {
          setPhase('offline', '通信服务连接中断');
          emit({ type: 'disconnected' });
        } else {
          settled = true;
          reject(new Error('WebSocket 连接未建立'));
        }
      };
      w.onmessage = e => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        signal(m);
      };
    });
  });
}

function cleanup(opts = {}) {
  const { keepRoom = true } = opts;
  links.clearCallTimer();
  links.clearCallState('', false);
  if (S.typingTimer) { clearTimeout(S.typingTimer); S.typingTimer = null; }
  if (S.recTimer) { clearInterval(S.recTimer); S.recTimer = null; }
  stopPeakMeter();
  links.closeChatPC();
  if (S.dc) { try { S.dc.close(); } catch {} S.dc = null; }
  if (S.ws) { try { S.ws.close(); } catch {} S.ws = null; }
  S.rx.clear();
  S.caller = false;
  if (!keepRoom) { S.room = null; S.pass = null; }
  setPhase('idle');
}

function disconnect() {
  cleanup({ keepRoom: false });
  return Promise.resolve(ok(null));
}

// ==================== 信令分派 ====================

async function signal(m) {
  try {
    if (m.type === 'peer-joined') {
      S.caller = true;
      links.closeChatPC();
      links.initChatPC();
      await links.offer();
      return;
    }
    if (m.type === 'offer' && !m.callId) {
      if (!S.chatPc) links.initChatPC();
      await window.PCManager.handleDescription('chat', m.offer, answer => sig({ type: 'answer', answer }));
      return;
    }
    if (m.type === 'answer' && !m.callId) {
      if (!S.chatPc) return;
      await window.PCManager.handleDescription('chat', m.answer);
      return;
    }
    if (m.type === 'ice' && !m.callId && m.candidate) {
      try { await window.PCManager.addIceCandidate('chat', m.candidate); } catch (e) { console.warn('[chat ICE]', e); }
      return;
    }
    if (links.getCallAdapter().isCallSignal(m.type)) {
      await links.getCallAdapter().dispatch(m);
      return;
    }
    if (m.type === 'peer-left') {
      stopRingtone();
      links.clearCallState('', false);
      links.closeChatPC();
      if (S.dc) { try { S.dc.close(); } catch {} S.dc = null; }
      setPhase('waiting', '等待对方进入…');
      emit({ type: 'system', text: '对方已离线' });
    }
  } catch (e) {
    console.error('Signal handle error:', e);
  }
}

// 晚绑定：sig 由本模块提供；其余三个由 call/index.js 提供
links.sig = sig;

// ── engine/call/index.js ──────────────────────────────────────────────
/**
 * call/index.js — 呼叫调度（驱动内部）
 *
 * 呼叫状态机由冻结层 CallCore（5 态 FSM + epoch 代际作废）承担；
 * 呼叫信令经冻结层 CallSignalingAdapter 隔离分派。
 * 注意：adapter 构造依赖 sig/peer/ringtone 等运行时函数，故惰性单例，
 * 避免 ESM 循环依赖的初始化时序问题。
 */

function clearCallTimer() {
  if (S.callTimer) { clearTimeout(S.callTimer); S.callTimer = null; }
}

function rememberEndedCall(id) {
  if (!id) return;
  S.endedCalls.add(id);
  if (S.endedCalls.size > 32) S.endedCalls.delete(S.endedCalls.values().next().value);
}

let mediaRequestId = 0;

async function getLocalMedia(kind, callId = S.call?.id, epoch = S.call?.epoch) {
  if (S.local) return S.local;
  const requestId = ++mediaRequestId;
  const work = async () => {
    if (requestId !== mediaRequestId || !window.CallCore?.guard(epoch, callId)) return null;
    try {
      const rawStream = await window.MediaManager.getRawStream(kind);
      if (requestId !== mediaRequestId || !window.CallCore?.guard(epoch, callId)) return null;

      let localStream;
      if (kind === 'video' && window.BeautyEngine) {
        try {
          localStream = await window.BeautyEngine.init(rawStream);
        } catch (error) {
          console.warn('[BeautyEngine] 美颜不可用，降级原始流：', error.message);
          localStream = new MediaStream(rawStream.getTracks().filter(t => t.readyState === 'live'));
        }
      } else {
        localStream = new MediaStream(rawStream.getAudioTracks().filter(t => t.readyState === 'live'));
      }

      if (requestId !== mediaRequestId || !window.CallCore?.guard(epoch, callId)) {
        if (kind === 'video') window.BeautyEngine?.destroy({ stopRawTracks: true });
        return null;
      }
      S.local = localStream;
      const lv = $('local');
      if (lv) {
        lv.srcObject = S.local;
        lv.play().catch(err => { if (err.name !== 'AbortError') console.warn('local video', err); });
      }
      return S.local;
    } catch (error) {
      console.error('[Media] 获取本地媒体失败:', error);
      if (requestId === mediaRequestId && window.CallCore?.guard(epoch, callId)) {
        emit({ type: 'toast', text: '❌ 无法调用摄像头或麦克风，请检查权限' });
      }
      throw error;
    }
  };
  return work();
}

async function startLocalAndOffer(kind, callId, epoch = S.call?.epoch) {
  if (!S.call || S.call.id !== callId || !window.CallCore?.guard(epoch, callId)) return;
  try {
    await getLocalMedia(kind, callId, epoch);
    if (!S.call || S.call.id !== callId || !window.CallCore?.guard(epoch, callId)) return;
    if (!S.callPc) links.initCallPC(callId);
    S.local.getTracks().forEach(t => {
      if (!S.callPc.getSenders().some(s => s.track === t)) S.callPc.addTrack(t, S.local);
    });
    const o = await window.PCManager.makeOffer('call');
    if (!o || S.call?.id !== callId || !window.CallCore?.guard(epoch, callId)) return;
    links.sig({ type: 'call-offer', callId, offer: o });
    if ($('callBanner')) $('callBanner').style.display = 'none';
    if ($('inCallControls')) $('inCallControls').style.display = 'flex';
  } catch (e) {
    links.sig({ type: 'call-end', callId, reason: 'device' });
    rememberEndedCall(callId);
    clearCallState('无法开启麦克风/摄像头', false);
    emit({ type: 'toast', text: '无法开启麦克风/摄像头：' + e.message });
  }
}

function startCall(kind) {
  if (S.call) return fail('E_BUSY');
  if (!S.dc || S.dc.readyState !== 'open') return fail('E_NOT_READY');
  unlockAudioPlayback();
  const callId = safeUUID();
  const k = kind === 'video' ? 'video' : 'audio';
  const epoch = window.CallCore?.begin('caller', callId);
  if (epoch == null) return fail('E_CALL_STATE');
  S.callCandidateQueue = [];
  S.call = { id: callId, kind: k, role: 'caller', phase: 'ringing', epoch };

  window.CallUI.updateLayout(k);
  if ($('video')) $('video').classList.add('on');
  if ($('callBanner')) $('callBanner').style.display = 'flex';
  if ($('callAvatar')) $('callAvatar').textContent = k === 'video' ? '📹' : '📞';
  if ($('callTitle')) $('callTitle').textContent = k === 'video' ? '正在呼叫对方（视频）…' : '正在呼叫对方（语音）…';
  if ($('callActions')) $('callActions').style.display = 'none';
  if ($('inCallControls')) $('inCallControls').style.display = 'flex';

  playRing(k, true);
  emit({ type: 'call', state: 'outgoing', kind: k });

  clearCallTimer();
  S.callTimer = setTimeout(() => {
    if (S.call?.id === callId && S.call.phase === 'ringing') {
      emit({ type: 'system', text: '对方无人接听' });
      hangup();
    }
  }, CALL_TIMEOUT_MS);

  links.sig({ type: 'call-invite', callId, callKind: k });
  return ok({ callId });
}

async function acceptCall() {
  if (!S.call || S.call.role !== 'callee' || S.call.phase !== 'ringing') return fail('E_CALL_STATE');
  unlockAudioPlayback();
  const id = S.call.id;
  const kind = S.call.kind;
  stopRingtone();
  clearCallTimer();
  if (!window.CallCore?.transition('ACCEPT', id, S.call.epoch)) {
    clearCallState('通话状态已失效', false);
    return fail('E_CALL_STATE');
  }
  S.call.phase = 'connecting';
  window.CallUI.updateLayout(kind);
  if ($('callActions')) $('callActions').style.display = 'none';
  if ($('callBanner')) $('callBanner').style.display = 'none';
  if ($('inCallControls')) $('inCallControls').style.display = 'flex';
  emit({ type: 'call', state: 'connecting', kind });
  try {
    const epoch = S.call.epoch;
    await getLocalMedia(kind, id, epoch);
    if (!S.call || S.call.id !== id || !window.CallCore?.guard(epoch, id)) return fail('E_CANCELLED');
    if (!S.callPc) links.initCallPC(id);
    if (S.local && S.callPc) {
      S.local.getTracks().forEach(t => {
        if (!S.callPc.getSenders().some(s => s.track === t)) S.callPc.addTrack(t, S.local);
      });
    }
    if (!S.call || S.call.id !== id || !window.CallCore?.guard(epoch, id)) return fail('E_CANCELLED');
    links.sig({ type: 'call-accept', callId: id });
    return ok({ callId: id });
  } catch (e) {
    links.sig({ type: 'call-reject', callId: id, reason: 'device' });
    rememberEndedCall(id);
    clearCallState('无法接入通话', false);
    emit({ type: 'toast', text: '无法接入通话：' + e.message });
    return fail('E_MEDIA', e.message);
  }
}

function hangup() {
  if (!S.call) return fail('E_NO_CALL');
  const id = S.call.id;
  const rejecting = S.call.role === 'callee' && S.call.phase === 'ringing';
  const cancelling = S.call.role === 'caller' && S.call.phase === 'ringing';
  links.sig({
    type: rejecting ? 'call-reject' : (cancelling ? 'call-cancel' : 'call-end'),
    callId: id,
    reason: rejecting ? 'reject' : 'hangup'
  });
  rememberEndedCall(id);
  emit({ type: 'system', text: rejecting ? '已拒绝呼叫' : (cancelling ? '已取消呼叫' : '通话已挂断') });
  clearCallState('', false);
  return ok(null);
}

function clearCallState(text = '', send = false) {
  mediaRequestId += 1;
  clearCallTimer();
  stopRingtone();

  if (window.BeautyEngine) {
    try { window.BeautyEngine.destroy({ stopRawTracks: true }); } catch {}
  }

  if (send && S.call) links.sig({ type: 'call-end', callId: S.call.id, reason: 'hangup' });
  const oldCall = S.call;
  closeMediaCall();
  if (oldCall?.id) {
    rememberEndedCall(oldCall.id);
    window.CallCore?.end(oldCall.id, oldCall.epoch, { reason: text || 'cleanup' });
  }
  S.local = null;
  S.remote = null;
  S.call = null;
  if (text) emit({ type: 'system', text });
  emit({ type: 'call', state: 'ended' });
}

function closeMediaCall() {
  stopRingtone();

  for (const id of ['local', 'remote']) {
    const v = $(id);
    if (v) {
      try { v.pause(); v.srcObject = null; v.load(); } catch {}
    }
  }

  if (S.local) {
    S.local.getTracks().forEach(t => { try { t.stop(); } catch {} });
    S.local = null;
  }

  window.MediaManager?.setAllEnabled?.(false);

  if (S.remote) {
    S.remote.getTracks().forEach(t => { try { t.stop(); } catch {} });
    S.remote = null;
  }

  links.closeCallPC();
  const vd = $('video');
  if (vd) vd.classList.remove('on');
  if ($('audioCallView')) $('audioCallView').style.display = 'none';
  if ($('callBanner')) $('callBanner').style.display = 'flex';
  if ($('callActions')) $('callActions').style.display = 'flex';
  if ($('inCallControls')) $('inCallControls').style.display = 'none';
}

function toggleCamera() {
  const track = S.local?.getVideoTracks()[0];
  if (!track) return fail('E_NO_VIDEO');
  const enabled = !track.enabled;
  track.enabled = enabled;
  if (window.BeautyEngine?.rawStream?.getVideoTracks().length) {
    window.BeautyEngine.setCameraEnabled(enabled);
  } else {
    window.MediaManager?.setCameraEnabled(enabled);
  }
  const btn = $('cam');
  if (btn) {
    btn.textContent = enabled ? '📹' : '🚫';
    btn.style.opacity = enabled ? '1' : '0.6';
  }
  emit({ type: 'camera', enabled });
  return ok({ enabled });
}

/**
 * 把美颜面板的三个滑杆与两个按钮接到 BeautyEngine。
 *
 * 注意：原项目里这几个控件只有 DOM、没有任何事件绑定（call-ui.js 只绑了
 * 音量/摄像头/挂断/接听/拒绝），拖滑杆不会有反应。这里只补线，
 * BeautyEngine 本体（shader、渲染管线）一个字节都没改。
 */
function bindBeautyControls() {
  const BE = window.BeautyEngine;
  if (!BE) return fail('E_NO_BEAUTY');

  const w = $('rangeWhitening');
  const s = $('rangeSmoothing');
  const sl = $('rangeSoftLight');

  const sync = () => {
    BE.setBeauty({
      whitening: w ? Number(w.value) : 0.4,
      smoothing: s ? Number(s.value) : 0.5,
      softLight: sl ? Number(sl.value) : 0.3
    });
  };
  [w, s, sl].forEach(el => { if (el) el.oninput = sync; });
  sync();

  const toggle = $('btnToggleBeauty');
  if (toggle) {
    toggle.onclick = () => {
      BE.setEnabled(!BE.enabled);
      toggle.textContent = BE.enabled ? '美颜开' : '美颜关';
      toggle.classList.toggle('active', BE.enabled);
    };
  }

  const cmp = $('btnOriginalCompare');
  if (cmp) {
    const off = () => BE.setEnabled(false);
    const on = () => {
      BE.setEnabled(true);
      const t = $('btnToggleBeauty');
      if (t) { t.textContent = '美颜开'; t.classList.add('active'); }
    };
    cmp.onmousedown = off;
    cmp.onmouseup = on;
    cmp.onmouseleave = on;
    cmp.ontouchstart = e => { e.preventDefault(); off(); };
    cmp.ontouchend = on;
    cmp.ontouchcancel = on;
  }
  return ok(null);
}

// ==================== 呼叫信令适配（冻结层）====================

let callSignalingAdapter = null;

/** 惰性单例：首次信号分派时构造，避开 ESM 循环依赖的初始化时序 */
function getCallAdapter() {
  if (!callSignalingAdapter) {
    callSignalingAdapter = new window.CallSignalingAdapter({
      S, $, sig,
      CallCore: window.CallCore,
      PCManager: window.PCManager,
      playRing, stopRingtone, clearCallTimer, clearCallState,
      rememberEndedCall, startLocalAndOffer, initCallPC,
      sys: t => emit({ type: 'system', text: t }),
      st: () => {}
    });
  }
  return callSignalingAdapter;
}

// 晚绑定：本模块对外提供的三个函数
links.getCallAdapter = getCallAdapter;
links.clearCallTimer = clearCallTimer;
links.clearCallState = clearCallState;

// ── engine/index.js ──────────────────────────────────────────────
/**
 * engine/index.js — 引擎组合根（内部，不对外暴露）
 *
 * 来源：zsjws@3b57750 driver/src/index.js，改动仅四处：
 *   1. 首个 import 是 shim（冻结层靠 window 注册单例，Node 里没有 window）；
 *   2. mount → mountEngine / unmount → unmountEngine（与 SDK 契约的 mount(ctx) 区分）；
 *   3. 删除 `window.ZsjwsDriver = {...}` 全局暴露（宪法第 7 条：不得同时提供两种导出形态）；
 *   4. overlay 宿主从 `document.body` 改为「装载方传入的容器」，document 从容器推导。
 *
 * 装载顺序（冻结层先行，字节不变）：
 *   CallCore → MediaManager → PCManager → CallSignalingAdapter
 *   → BeautyEngine → CallUI → 内部模块
 */

// ---- 冻结层（字节不变，仅加载副作用）----

// 晚绑定注册：peer 模块对外提供 offer / initChatPC / closeChatPC / initCallPC / closeCallPC。
// 打破循环后没有任何模块 import 它，必须显式引入，否则它不会进产物（拼接器按 import 图收集）。

// ---- 内部模块 ----

const VERSION = '1.0.0';
const LIMITS = { maxFileSize: MAX_FILE_SIZE };

const rejectCall = () => hangup();

// ==================== 装载（引擎生命周期） ====================

let mounted = false;
let hostEl = null;

/**
 * 装载引擎。容器必须是驱动自有的 DOM 节点（槽位内的层根），
 * 通话 overlay 挂到它下面 —— 不再挂 document.body（契约 L13：只向槽位渲染）。
 *
 * @param {HTMLElement} container
 * @param {{ backendUrl?:string, signalingUrl?:string, auth?:string,
 *           name?:string, discoverable?:boolean, iceServers?:object,
 *           storage?:{get:Function,set:Function,remove:Function} }} config
 */
function mountEngine(container, config = {}) {
  if (mounted) return fail('E_ALREADY_MOUNTED');
  mounted = true;

  const doc = (container && container.ownerDocument) ||
    (typeof document !== 'undefined' ? document : null);

  if (config.storage) setStorage(config.storage);

  configure({
    backendUrl: config.backendUrl,
    signalingUrl: config.signalingUrl,
    auth: config.auth
  });
  if (config.iceServers) overrideIceServers(config.iceServers);

  loadIdentity();
  if (config.name != null) setName(config.name);
  if (config.discoverable != null) setDiscoverable(config.discoverable);

  // 通话 overlay：驱动自己的 UI，挂在驱动自有容器下
  const host = doc.createElement('div');
  host.id = 'zsjd-layer';
  host.setAttribute('data-module', 'org.quake.webrtc.im');
  (container && typeof container.appendChild === 'function' ? container : doc.body).appendChild(host);
  hostEl = host;

  const callUI = typeof window !== 'undefined' ? window.CallUI : null;
  if (callUI) {
    callUI.init(host);
    callUI.onToggleCam = () => toggleCamera();
    callUI.onHangup = () => hangup();
    callUI.onAccept = () => acceptCall();
    callUI.onReject = () => rejectCall();
    bindBeautyControls();
  }
  // 美颜取帧用的隐藏 <video> 也挂到自有容器里（原版挂 document.body，会污染宿主）
  if (typeof window !== 'undefined' && window.BeautyEngine && window.BeautyEngine.setHost) {
    window.BeautyEngine.setHost(host);
  }

  loadIceConfig();

  // 页面隐藏时释放物理设备（避免相机指示灯常亮）
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', () => {
      try { if (window.MediaManager) window.MediaManager.release(); } catch (_) { /* 忽略 */ }
    });
  }

  emit({ type: 'ready', identity: { peerId: S.peerId, name: S.name } });
  return { ok: true, data: { version: VERSION, limits: LIMITS } };
}

/** 卸载：释放 PC/WS/媒体设备/定时器与全部引擎状态，移除 overlay 宿主。 */
function unmountEngine() {
  if (!mounted) return fail('E_NOT_MOUNTED');
  mounted = false;
  try { cleanup({ keepRoom: false }); } catch (_) { /* 尽力释放 */ }
  // 容器要销毁了，先把美颜的挂载点摘掉，免得下次装载指向一个已移除的节点
  if (typeof window !== 'undefined' && window.BeautyEngine && window.BeautyEngine.setHost) {
    window.BeautyEngine.setHost(null);
  }
  if (hostEl && hostEl.parentNode) hostEl.parentNode.removeChild(hostEl);
  hostEl = null;
  return { ok: true, data: null };
}

// ==================== 观测（唯一真相通道） ====================

function state() {
  return {
    phase: S.phase,
    room: S.room,
    channel: S.dc ? S.dc.readyState : 'closed',
    call: S.call ? { id: S.call.id, kind: S.call.kind, role: S.call.role, phase: S.call.phase } : null,
    online: Boolean(S.lobbyWs && S.lobbyWs.readyState === 1),
    identity: { peerId: S.peerId, name: S.name, discoverable: S.discoverable },
    limits: LIMITS
  };
}

// ==================== 功能命令（UI 层触发的） ====================

function driverConnect({ roomId, password, name } = {}) {
  if (name != null) setName(name);
  if (roomId) S.room = roomId;
  if (password != null) S.pass = password;
  if (!S.room) return Promise.resolve(fail('E_NO_ROOM'));
  if (!S.pass) return Promise.resolve(fail('E_NO_PASS'));
  return connect(S.pass).catch(e => fail('E_CONNECT', e.message));
}

// ── ui/app.js ──────────────────────────────────────────────
/* ============================================================
 * ui.js — 页面层（只做渲染与交互，不碰 PC/DC/WebSocket）
 *
 * 依赖：由 createUi 注入的引擎门面 D（不读任何全局）
 * 铁律：本文件不得出现 RTCPeerConnection / WebSocket / getUserMedia
 * ============================================================ */
function createUi(opts) {
  'use strict';

  // 宿主注入：root（驱动层内的容器）、D（引擎门面）、storage（ctx.kv 适配）、config
  const root = opts.root;
  const doc = root.ownerDocument;
  const D = opts.D;
  const storage = opts.storage;
  const config = opts.config || {};

  // 业务根：#app 仍由本层创建，但只在 root 内查询，绝不碰宿主 DOM
  const app = root.ownerDocument.createElement('div');
  app.id = 'app';
  root.appendChild(app);

  // 组件侧自备（驱动原子化后，页面数据/工具移回组件，不再由内核导出）
  const EMOJIS = ['😀','😂','🥹','😍','🥺','😎','👍','❤','🔥','🎉','🚀','💯','🫣','🤣','🫡','✨','🤔','🙈','💩','🤝'];
  const MAX_FILE_SIZE = 100 * 1024 * 1024;
  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }
  const $ = id => root.querySelector('#' + id);
  const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

  // ==================== 分享链接鉴权 ====================
  // 网关（如带 sharecode 的分享链接）要求每个请求都带 sharecode。
  // 这里缓存页面 URL 上的 sharecode，并保证：
  //   1) 所有 fetch / WebSocket 自动附带；
  //   2) history.replaceState 不会把它抹掉（否则刷新即 403）；
  //   3) 生成的房间分享链接保留它（否则对方打开就是 403）。
  const SHARE = String(config.shareCode || '').trim();

  const keepShare = (path) => {
    if (!SHARE) return path;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}sharecode=${encodeURIComponent(SHARE)}`;
  };

  const authUrl = (url) => {
    if (!SHARE) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}sharecode=${encodeURIComponent(SHARE)}`;
  };

  // ==================== 图标 ====================

  const I = {
    back: '<path d="M12 4l1.4 1.4L7.8 11H20v2H7.8l5.6 5.6L12 20l-8-8z" fill="currentColor"/>',
    phone: '<path d="M19.44 13c-.22 0-.45-.07-.67-.12a9.44 9.44 0 0 1-1.31-.39 2 2 0 0 0-2.48 1l-.22.45a12.18 12.18 0 0 1-2.66-2 12.18 12.18 0 0 1-2-2.66l.42-.28a2 2 0 0 0 1-2.48 10.33 10.33 0 0 1-.39-1.31c-.05-.22-.09-.45-.12-.68a2 2 0 0 0-2-1.73H7a2 2 0 0 0-2 2.33 15.64 15.64 0 0 0 13.67 13.67 2 2 0 0 0 2.33-2v-2.1a2 2 0 0 0-1.56-1.7z" fill="currentColor"/>',
    video: '<path d="M3.27 7.125v9.75c0 .975.825 1.8 1.8 1.8h9c.975 0 1.8-.825 1.8-1.8v-3.375l3.9 3.375V7.125l-3.9 3.375V7.125c0-.975-.825-1.8-1.8-1.8h-9c-.975 0-1.8.825-1.8 1.8z" fill="currentColor"/>',
    menu: '<path d="M12 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" fill="currentColor"/>',
    emoji: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm-3.5-9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm7 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM12 17.5c2.3 0 4.2-1.4 4.8-3.5H7.2c.6 2.1 2.5 3.5 4.8 3.5z" fill="currentColor"/>',
    attach: '<path d="M16.5 6.5v9a4.5 4.5 0 0 1-9 0V7a3 3 0 0 1 6 0v8a1.5 1.5 0 0 1-3 0V7.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    send: '<path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.993.993 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z" fill="currentColor"/>',
    mic: '<path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" fill="currentColor"/>',
    close: '<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor"/>',
    download: '<path d="M12 3v10.6l3.3-3.3 1.4 1.4-5.7 5.7-5.7-5.7 1.4-1.4 3.3 3.3V3h2zM5 19h14v2H5z" fill="currentColor"/>',
    play: '<path d="M8 5v14l11-7z" fill="currentColor"/>',
    pause: '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" fill="currentColor"/>',
    clock: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm.5-13H11v6l5.2 3.1.8-1.3-4.5-2.7V7z" fill="currentColor"/>',
    check: '<path d="M11.071.653a.457.457 0 0 0-.304-.102.493.493 0 0 0-.381.178l-6.19 7.636-2.011-2.175a.463.463 0 0 0-.349-.158.467.467 0 0 0-.338.131.537.537 0 0 0-.14.353.54.54 0 0 0 .13.363l2.39 2.576a.465.465 0 0 0 .349.158.457.457 0 0 0 .368-.189l6.596-8.14a.504.504 0 0 0 .103-.36.516.516 0 0 0-.223-.271z" fill="currentColor"/>',
    check2: '<path d="M11.071.653a.457.457 0 0 0-.304-.102.493.493 0 0 0-.381.178l-6.19 7.636-2.011-2.175a.463.463 0 0 0-.349-.158.467.467 0 0 0-.338.131.537.537 0 0 0-.14.353.54.54 0 0 0 .13.363l2.39 2.576a.465.465 0 0 0 .349.158.457.457 0 0 0 .368-.189l6.596-8.14a.504.504 0 0 0 .103-.36.516.516 0 0 0-.223-.271z" fill="currentColor"/><path d="M15.071.653a.457.457 0 0 0-.304-.102.493.493 0 0 0-.381.178l-6.19 7.636-1.2-1.298-.728.897 1.58 1.704a.465.465 0 0 0 .349.158.457.457 0 0 0 .368-.189l6.596-8.14a.504.504 0 0 0 .103-.36.516.516 0 0 0-.193-.484z" fill="currentColor"/>',
    warn: '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" fill="currentColor"/>',
    chat: '<path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z" fill="currentColor"/>'
  };

  const svg = (name, size = 24) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${I[name] || ''}</svg>`;

  const CHECK_SVG = (status) => {
    const wrap = (inner, cls) => `<span class="wa-status ${cls}"><svg viewBox="0 0 16 12" width="16" height="12">${inner}</svg></span>`;
    if (status === 'sending') return wrap(I.clock, 'sending');
    if (status === 'sent') return wrap(I.check, 'sent');
    if (status === 'delivered') return wrap(I.check2, 'delivered');
    if (status === 'read') return wrap(I.check2, 'read');
    if (status === 'failed') return `<span class="wa-status failed"><svg viewBox="0 0 24 24" width="14" height="14">${I.warn}</svg></span>`;
    return '';
  };

  // ==================== 状态 ====================

  const U = {
    view: 'roster',        // roster | chat
    msgs: [],              // { id, dir, kind, ts, ... }
    index: new Map(),      // id -> { el, msg }
    roster: [],
    identity: null,
    call: null,
    lastDate: null,
    invite: null,          // 待处理的呼叫邀请
    unsub: null,
    audioEls: new Map()
  };

  // ==================== 工具 ====================

  const AVATAR_COLORS = ['#dba685', '#53a6fd', '#25d366', '#fc9775', '#ff72a1', '#a791ff', '#fb5061', '#53bdeb', '#42c7b8', '#ffd279'];

  // 身份以 core 为准，UI 不缓存（否则 discoverable 变更后会读到旧值）
  const me = () => D.state().identity;

  function avatarColor(name) {
    let h = 0;
    const s = String(name || '?');
    for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
    return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
  }

  function initials(name) {
    const s = String(name || '?').trim();
    if (!s) return '?';
    if (/[\u4e00-\u9fa5]/.test(s)) return s.slice(-2);
    return s.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  }

  function avatarHtml(name, size = 'md', online = false) {
    return `<div class="wa-avatar ${size}" style="background:${avatarColor(name)}">
      <span>${esc(initials(name))}</span>${online ? '<i class="online"></i>' : ''}
    </div>`;
  }

  function hhmm(ts) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function dayLabel(ts) {
    const d = new Date(ts);
    const now = new Date();
    const same = d.toDateString() === now.toDateString();
    if (same) return '今天';
    const y = new Date(now.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return '昨天';
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  }

  function linkify(text) {
    const safe = esc(text);
    return safe.replace(/((?:https?:\/\/|www\.)[^\s<]+)/g, m => {
      const href = m.startsWith('http') ? m : 'https://' + m;
      return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${m}</a>`;
    });
  }

  let toastTimer = null;
  function toast(text) {
    let el = root.querySelector('.wa-toast');
    if (!el) {
      el = doc.createElement('div');
      el.className = 'wa-toast';
      root.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
  }

  let enterRoomInflight = null;
  async function enterRoom(roomId, password) {
    if (!roomId || !password) {
      // 房间号/口令任一缺失都进不去（口令是服务端下发的，本地不兜底）
      return toast('房间信息不完整')
    }
    if (enterRoomInflight) return enterRoomInflight; // boot 与 ready 事件可能重复触发，去重
    enterRoomInflight = (async () => {
      const r = await D.connect({ roomId, password });
      if (!r.ok) {
        toast('密码错误、链接失效或连接超时');
        mountRoster();
        return;
      }
      /* 不回写宿主 URL（母体地址不归驱动管） */
      mountChat();
    })();
    try { await enterRoomInflight; } finally { enterRoomInflight = null; }
  }

  // ==================== 名册 ====================

  function renderRosterInto(host) {
    if (!host) return;
    const self = me();
    const others = U.roster.filter(p => p.peerId !== self.peerId);

    if (!self.discoverable) {
      host.innerHTML = '<div class="wa-side-note">开启「可被发现」后，别人才会看到你</div>';
      return;
    }
    if (!others.length) {
      host.innerHTML = '<div class="wa-side-note">暂时没有其他人<br>把链接发给对方，或用同一个服务器上的另一台设备打开</div>';
      return;
    }
    host.innerHTML = `<div class="wa-side-label">附近的人</div>` + others.map(p => `
      <button class="wa-list-item" data-peer="${esc(p.peerId)}">
        ${avatarHtml(p.name, 'md', true)}
        <div class="li-body">
          <div class="li-name">${esc(p.name)}</div>
          <div class="li-sub">在线</div>
        </div>
        <span class="li-cta">呼叫</span>
      </button>`).join('');

    host.querySelectorAll('[data-peer]').forEach(el => {
      el.onclick = async () => {
        const peerId = el.dataset.peer;
        const r = await D.invite(peerId);
        if (!r.ok) return toast('呼叫失败：' + (r.code || ''));
        toast('已发送呼叫，等待对方接受');
      };
    });
  }

  function refreshRoster() {
    renderRosterInto($('sideRoster'));                    // 会话页侧栏
    if (U.view === 'roster') renderVisitorList();         // 访客列表（IM 式首页）
  }

  // ==================== 访客列表（IM 式，取代本地房间页） ====================

  function loadHistory() {
    try { return JSON.parse(storage.getItem('zsjws_history') || '{}'); } catch { return {}; }
  }
  function saveHistory(h) {
    try { storage.setItem('zsjws_history', JSON.stringify(h)); } catch {}
  }
  function rememberVisitors(list) {
    const self = me();
    const h = loadHistory();
    const now = Date.now();
    let changed = false;
    for (const p of list) {
      if (p.peerId === self.peerId) continue;
      const ex = h[p.peerId];
      if (!ex || ex.name !== p.name) { h[p.peerId] = { name: p.name, lastSeen: now }; changed = true; }
      else if (now - (ex.lastSeen || 0) > 60000) { ex.lastSeen = now; changed = true; }
    }
    if (changed) saveHistory(h);
  }
  function ago(ts) {
    if (!ts) return '';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    if (s < 86400 * 7) return Math.floor(s / 86400) + ' 天前';
    return new Date(ts).toLocaleDateString();
  }

  function mountRoster() {
    U.view = 'roster';
    const app = $('app');
    if (!app) return;
    const self = me();
    const disc = self.discoverable;
    app.innerHTML = `
      <div class="wa-visitors">
        <div class="wa-visitors-head">
          ${avatarHtml(self.name, 'md')}
          <div class="vh-me">
            <b>${esc(self.name)}</b>
            <span>${disc ? '在线 · 可被发现' : '在线 · 仅自己可见'}</span>
          </div>
          <button class="wa-btn ghost" id="vToggleDiscover" style="width:auto;height:34px;margin:0;padding:0 12px;font-size:13px">
            ${disc ? '隐藏自己' : '可被发现'}
          </button>
        </div>
        <div class="wa-visitors-body" id="visitorList"></div>
      </div>`;
    bindRoster();
    renderVisitorList();
  }

  function bindRoster() {
    const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    on('vToggleDiscover', () => {
      const cur = D.state().identity.discoverable;
      D.setDiscoverable(!cur);
      D.goOnline();
      mountRoster();
    });
  }

  function renderVisitorList() {
    const host = $('visitorList');
    if (!host) return;
    const self = me();
    const online = (U.roster || []).filter(p => p.peerId !== self.peerId);
    rememberVisitors(online);
    const hist = loadHistory();
    const onlineIds = new Set(online.map(p => p.peerId));
    const offline = Object.keys(hist)
      .filter(id => id !== self.peerId && !onlineIds.has(id))
      .map(id => ({ peerId: id, name: hist[id].name, lastSeen: hist[id].lastSeen }))
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

    if (!online.length && !offline.length) {
      host.innerHTML = '<div class="wa-side-note">附近还没有其他人<br>把本页发给对方，或用同一服务上的另一台设备打开</div>';
      return;
    }
    let html = '';
    if (online.length) {
      html += '<div class="wa-side-label">在线 · 附近的人</div>';
      html += online.map(p => visitorItem(p, true)).join('');
    }
    if (offline.length) {
      html += '<div class="wa-side-label">历史访客</div>';
      html += offline.map(p => visitorItem(p, false)).join('');
    }
    host.innerHTML = html;
    host.querySelectorAll('[data-peer][data-on="1"]').forEach(el => {
      el.onclick = async () => {
        const r = await D.invite(el.dataset.peer);
        if (!r.ok) return toast('呼叫失败：' + (r.code || ''));
        toast('已发送，等待对方接受…');
      };
    });
  }

  function visitorItem(p, on) {
    return `
      <button class="wa-list-item${on ? '' : ' off'}" data-peer="${esc(p.peerId)}" data-on="${on ? 1 : 0}" ${on ? '' : 'disabled'}>
        ${avatarHtml(p.name, 'md', on)}
        <div class="li-body">
          <div class="li-name">${esc(p.name)}</div>
          <div class="li-sub">${on ? '在线' : ('离线 · ' + ago(p.lastSeen))}</div>
        </div>
        <span class="li-cta">${on ? '聊天' : ''}</span>
      </button>`;
  }

  // ==================== 会话页 ====================

  function mountChat() {
    U.view = 'chat';
    U.msgs = [];
    U.index.clear();
    U.lastDate = null;
    const self = me();
    const app = $('app');
    if (!app) return;

    app.innerHTML = `
      <div class="wa-shell">
        <aside class="wa-sidebar">
          <div class="wa-side-head">
            ${avatarHtml(self.name, 'md')}
            <div class="wa-me">
              <b>${esc(self.name)}</b>
              <span>${self.discoverable ? '在线 · 可被发现' : '在线 · 仅链接可见'}</span>
            </div>
            <button class="wa-iconbtn" id="sideRefresh" title="刷新名册">${svg('menu', 20)}</button>
          </div>
          <div class="wa-side-body" id="sideRoster"></div>
          <div style="padding:10px;border-top:1px solid var(--wa-border)">
            <button class="wa-btn ghost" style="margin:0;height:40px;font-size:13.5px" id="sideLeave">返回列表</button>
          </div>
        </aside>

        <main class="wa-main">
          <header class="wa-header">
            <button class="wa-iconbtn wa-back" id="openDrawer">${svg('back', 22)}</button>
            ${avatarHtml(peerName(), 'sm')}
            <div class="hd-body">
              <div class="hd-name">${esc(peerName())}</div>
              <div class="hd-status" id="hdStatus">正在建立连接…</div>
            </div>
            <button class="wa-iconbtn" id="btnAudio" title="语音通话">${svg('phone', 21)}</button>
            <button class="wa-iconbtn" id="btnVideo" title="视频通话">${svg('video', 22)}</button>
            <button class="wa-iconbtn" id="btnMenu" title="更多">${svg('menu', 20)}</button>
          </header>

          <div class="wa-banner" id="banner"></div>

          <div class="wa-wallpaper">
            <div class="wa-msgs" id="msgs"><div class="wa-spacer"></div></div>
          </div>

          <div class="wa-recbar" id="recbar">
            <i class="wa-recdot"></i>
            <span id="recTime">录音中 0s</span>
            <span class="grow"></span>
            <button class="wa-btn ghost" style="width:auto;height:34px;margin:0;padding:0 12px;font-size:13px" id="recCancel">取消</button>
            <button class="wa-btn primary" style="width:auto;height:34px;margin:0;padding:0 14px;font-size:13px" id="recSend">发送</button>
          </div>

          <div class="wa-emoji" id="emoji"></div>

          <div class="wa-composer">
            <button class="wa-iconbtn" id="btnEmoji" title="表情">${svg('emoji', 24)}</button>
            <button class="wa-iconbtn" id="btnAttach" title="附件">${svg('attach', 22)}</button>
            <button class="wa-iconbtn" id="btnRec" title="按住说话">${svg('mic', 22)}</button>
            <div class="box">
              <textarea id="input" rows="1" placeholder="输入消息…" enterkeyhint="send"></textarea>
            </div>
            <button class="wa-send" id="btnSend" title="发送">${svg('send', 22)}</button>
          </div>

          <div class="wa-menu" id="chatMenu">
            <button data-act="clear">清空本地记录</button>
            <button data-act="leave">返回列表</button>
          </div>
        </main>
      </div>

      <div class="wa-drawer" id="drawer">
        <div class="mask" data-close></div>
        <div class="panel">
          <div class="wa-side-head">
            ${avatarHtml(self.name, 'md')}
            <div class="wa-me"><b>${esc(self.name)}</b><span>附近的人</span></div>
            <button class="wa-iconbtn" data-close>${svg('close', 20)}</button>
          </div>
          <div class="wa-side-body" id="sideRoster"></div>
        </div>
      </div>`;

    // 通话 overlay 与美颜接线由驱动 mount() 内部完成（原子内部行为）

    bindChat();
    refreshRoster();
  }

  function peerName() {
    return U.peerName || '对方';
  }

  function bindChat() {
    const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };

    on('openDrawer', () => $('drawer')?.classList.add('on'));
    root.querySelectorAll('[data-close]').forEach(el => {
      el.onclick = () => $('drawer')?.classList.remove('on');
    });

    on('btnAudio', () => {
      const r = D.startCall('audio');
      if (!r.ok) toast(r.code === 'E_NOT_READY' ? '对方尚未连接' : r.code === 'E_BUSY' ? '当前正在通话' : '无法发起通话');
    });
    on('btnVideo', () => {
      const r = D.startCall('video');
      if (!r.ok) toast(r.code === 'E_NOT_READY' ? '对方尚未连接' : r.code === 'E_BUSY' ? '当前正在通话' : '无法发起通话');
    });

    on('btnMenu', e => {
      e.stopPropagation();
      $('chatMenu')?.classList.toggle('on');
    });
    root.addEventListener('click', () => $('chatMenu')?.classList.remove('on'));
    $('chatMenu')?.addEventListener('click', e => {
      const act = e.target?.dataset?.act;
      if (!act) return;
      $('chatMenu').classList.remove('on');
      if (act === 'clear') clearLocalMessages();
      if (act === 'leave') leaveRoom();
    });

    on('sideLeave', leaveRoom);

    // 输入区
    const input = $('input');
    const send = () => {
      const v = input.value;
      if (!v.trim()) return;
      input.value = '';
      autoGrow(input);
      D.sendText(v);
      $('emoji')?.classList.remove('on');
      scrollBottom(true);
    };
    on('btnSend', send);
    if (input) {
      input.addEventListener('input', () => {
        autoGrow(input);
        // 只有真有内容才广播正在输入，清空输入框不该让对端还亮着
        if (input.value.trim()) D.sendTyping();
      });
      input.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || e.shiftKey) return;
        // 中文/日文输入法选词时的回车不是发送
        if (e.isComposing || e.keyCode === 229) return;
        // 触摸键盘的 Enter 是换行，发送靠按钮（与 WhatsApp 移动端一致）
        if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return;
        e.preventDefault();
        send();
      });
    }

    // 表情
    const emoji = $('emoji');
    if (emoji) {
      emoji.innerHTML = EMOJIS.map(e => `<button type="button">${e}</button>`).join('');
      emoji.addEventListener('click', e => {
        const b = e.target.closest('button');
        if (!b || !input) return;
        input.value += b.textContent;
        input.focus();
        autoGrow(input);
      });
    }
    on('btnEmoji', e => { e.stopPropagation(); $('emoji')?.classList.toggle('on'); });

    // 附件
    on('btnAttach', () => {
      const f = doc.createElement('input');
      f.type = 'file';
      f.multiple = true;
      f.onchange = async () => {
        if (!f.files?.length) return;
        const files = Array.from(f.files);
        for (const file of files) {
          if (file.size > MAX_FILE_SIZE) { toast(file.name + ' 超过 100MB'); continue; }
          await D.sendFile(file);
        }
      };
      f.click();
    });

    // 语音录制（菜单入口保底，主入口是输入框旁的录音键）
    let recActive = false;
    on('recCancel', () => { D.cancelRecording(); recActive = false; $('recbar')?.classList.remove('on'); });
    on('recSend', async () => {
      $('recbar')?.classList.remove('on');
      recActive = false;
      const r = await D.stopAndSendRecording();
      if (!r.ok && r.code === 'E_TOO_SHORT') toast('录音太短');
    });

    const menu = $('chatMenu');
    if (menu && !menu.querySelector('[data-act="record"]')) {
      const b = doc.createElement('button');
      b.dataset.act = 'record';
      b.textContent = '录一段语音';
      b.onclick = async () => {
        menu.classList.remove('on');
        if (recActive) return;
        const r = await D.startRecording();
        if (!r.ok) return toast('无法开启麦克风');
        recActive = true;
        $('recbar')?.classList.add('on');
      };
      menu.insertBefore(b, menu.firstChild);
    }

    // 录音键：按住 220ms 开始录音，松开发送，上滑取消
    const recBtn = $('btnRec');
    if (recBtn) {
      let holdTimer = null;
      let recording = false;
      let cancelled = false;
      let startY = 0;

      const finish = async () => {
        clearTimeout(holdTimer);
        recBtn.classList.remove('on');
        if (!recording) return;
        recording = false;
        recActive = false;
        $('recbar')?.classList.remove('on');
        if (cancelled) { D.cancelRecording(); toast('已取消'); return; }
        const r = await D.stopAndSendRecording();
        if (!r.ok && r.code === 'E_TOO_SHORT') toast('录音太短');
      };

      recBtn.addEventListener('pointerdown', e => {
        e.preventDefault();
        if (recActive) return;
        cancelled = false;
        startY = e.clientY;
        holdTimer = setTimeout(async () => {
          const r = await D.startRecording();
          if (!r.ok) { toast('无法开启麦克风'); return; }
          recording = true;
          recActive = true;
          cancelled = false;
          recBtn.classList.add('on');
          $('recbar')?.classList.add('on');
        }, 220);
      });
      recBtn.addEventListener('pointermove', e => {
        // 上滑超过 60px 视为取消（微信式滑动取消）
        if (recording && startY - e.clientY > 60 && !cancelled) {
          cancelled = true;
          toast('松开手指，取消发送');
        }
      });
      recBtn.addEventListener('pointerup', finish);
      recBtn.addEventListener('pointercancel', finish);
      recBtn.addEventListener('lostpointercapture', finish);
      // 防止移动端长按弹出选中菜单/上下文菜单
      recBtn.addEventListener('contextmenu', e => e.preventDefault());
    }

    // 全屏查看器
    root.addEventListener('click', e => {
      const img = e.target.closest?.('.wa-img');
      if (img) openViewer('image', img.dataset.full || img.src);
    });
  }

  function autoGrow(el) {
    el.style.height = '24px';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }

  function leaveRoom() {
    D.disconnect();
    U.msgs = [];
    U.index.clear();
    U.peerName = null;
    /* 不回写宿主 URL（母体地址不归驱动管） */
    mountRoster();
  }

  function clearLocalMessages() {
    const list = $('msgs');
    if (list) list.innerHTML = '<div class="wa-spacer"></div>';
    U.msgs = [];
    U.index.clear();
    U.lastDate = null;
    addSystem('已清空本地记录（不影响对方）');
  }

  // ==================== 消息渲染 ====================

  function scrollBottom(force) {
    const el = $('msgs');
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (force || near) el.scrollTop = el.scrollHeight;
  }

  function ensureDate(ts) {
    const label = dayLabel(ts);
    if (label === U.lastDate) return;
    U.lastDate = label;
    const d = doc.createElement('div');
    d.className = 'wa-date';
    d.textContent = label;
    $('msgs')?.appendChild(d);
  }

  function addSystem(text) {
    const el = doc.createElement('div');
    el.className = 'wa-system';
    el.textContent = text;
    $('msgs')?.appendChild(el);
    scrollBottom(true);
  }

  function tailSvg(out) {
    const fill = out ? 'var(--wa-bubble-outgoing)' : 'var(--wa-bubble-incoming)';
    const d = out
      ? ['M5.188 12H0V0.807l6.467 8.625C7.526 10.844 6.958 12 5.188 12z', 'M5.188 13H0V1.807l6.467 8.625C7.526 11.844 6.958 13 5.188 13z']
      : ['M2.812 12H8V0.807L1.533 9.432C0.474 10.844 1.042 12 2.812 12z', 'M2.812 13H8V1.807L1.533 10.432C0.474 11.844 1.042 13 2.812 13z'];
    return `<svg class="wa-tail" viewBox="0 0 8 13" width="8" height="13">
      <path opacity="0.13" d="${d[0]}" fill="var(--wa-always-black)"/>
      <path d="${d[1]}" fill="${fill}"/>
    </svg>`;
  }

  function renderMessage(msg) {
    const out = msg.dir === 'out';
    const row = doc.createElement('div');
    row.className = 'wa-row ' + (out ? 'out' : 'in');
    row.dataset.id = msg.id;
    row.dataset.dir = msg.dir;

    let inner = '';
    let media = false;

    if (msg.kind === 'text') {
      inner = `<div class="wa-text">${linkify(msg.text || '')}</div>`;
    } else if (msg.kind === 'image') {
      media = true;
      inner = `<img class="wa-img" src="${esc(msg.url)}" data-full="${esc(msg.url)}" alt="图片" loading="lazy">`;
    } else if (msg.kind === 'video') {
      media = true;
      inner = `<div class="wa-video-wrap"><video src="${esc(msg.url)}" controls playsinline preload="metadata"></video>
        ${msg.duration ? `<span class="wa-video-badge">${fmtDur(msg.duration)}</span>` : ''}</div>`;
    } else if (msg.kind === 'audio') {
      inner = renderVoice(msg);
    } else {
      inner = renderFile(msg);
    }

    const cls = 'wa-bubble' + (media ? ' media' : '');
    row.innerHTML = `
      <div class="${cls}">
        ${inner}
        ${out && msg.progress != null && msg.progress < 100 && msg.status === 'sending'
          ? `<div class="wa-sending-mask"><div class="wa-spin"></div></div><div class="wa-progress-text">${msg.progress}%</div>` : ''}
        <div class="wa-meta">
          <span class="t">${hhmm(msg.ts || Date.now())}</span>
          ${out ? CHECK_SVG(msg.status) : ''}
        </div>
      </div>`;

    U.index.set(msg.id, { el: row, msg });
    return row;
  }

  function renderFile(msg) {
    const kind = msg.kind === 'image' ? 'image' : msg.kind === 'video' ? 'video' : msg.kind === 'audio' ? 'audio' : 'file';
    const ext = (msg.name || '').split('.').pop().slice(0, 4).toUpperCase() || 'FILE';
    return `<div class="wa-file" data-kind="${kind}">
      <div class="fi">${svg('chat', 18)}<span>${esc(ext)}</span></div>
      <div class="fb">
        <div class="fn">${esc(msg.name || '文件')}</div>
        <div class="fs">${fmtSize(msg.size || 0)}</div>
      </div>
      <a class="fa" href="${esc(msg.url)}" download="${esc(msg.name || 'file')}" title="下载">${svg('download', 18)}</a>
    </div>`;
  }

  // 无 peaks（旧端或 AudioContext 不可用）时的静态波形，形状固定但不呆板
  const VOICE_FALLBACK = [3, 5, 8, 6, 10, 7, 4, 9, 6, 5, 8, 10, 7, 4, 6, 9, 5, 8, 3, 6, 10, 7, 5, 8, 4, 9];

  // 真实振幅 → 像素高度。+3 是保底，否则静音段会变成 0 高度不可见
  function voiceBars(msg) {
    const p = msg.peaks;
    if (Array.isArray(p) && p.length) return p.map(v => Math.max(3, Math.round(v * 22)));
    return VOICE_FALLBACK;
  }

  function renderVoice(msg) {
    const bars = voiceBars(msg);
    return `<div class="wa-voice" data-audio="${esc(msg.url)}">
      <button class="vp" type="button" data-play>${svg('play', 20)}</button>
      <div class="vw" data-wave>${bars.map((h, i) => `<i style="height:${h + 3}px" data-i="${i}"></i>`).join('')}</div>
      <span class="vd">${msg.duration ? fmtDur(msg.duration) : ''}</span>
    </div>`;
  }

  function fmtDur(sec) {
    const s = Math.max(0, Math.round(sec));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // 连续图片合并为网格的窗口。协议层仍是逐条独立消息，
  // 这里只是渲染层聚合，因此重传/进度/历史回放都不受影响。
  const GROUP_WINDOW_MS = 60000;
  const GROUP_MAX = 4;

  function appendMessage(msg) {
    if (!msg || !msg.id) return;
    if (U.index.has(msg.id)) return;

    // 收到新消息即视为对方打完了字
    showTyping(false);

    ensureDate(msg.ts || Date.now());

    const list = $('msgs');

    // 上一条是同向的近期图片 → 并进同一条网格，而不是新建一行
    const last = U.msgs[U.msgs.length - 1];
    const prevEl = list?.querySelector('.wa-row:last-of-type');
    if (msg.kind === 'image' && last && last.kind === 'image' && last.dir === msg.dir &&
        (msg.ts - last.ts) < GROUP_WINDOW_MS && prevEl && prevEl.dataset.id === last.id) {
      if (appendToImageGroup(prevEl, msg)) return;
    }

    // 上一条同向时去掉它的尾巴（WhatsApp 的连续气泡规则）
    const prev = prevEl;
    if (prev && prev.dataset.dir === msg.dir) {
      prev.classList.remove('tail');
      prev.querySelector('.wa-tail')?.remove();
    }

    const el = renderMessage(msg);
    el.classList.add('tail');
    // 尾巴是绝对定位的 SVG，必须显式插入（气泡本身只负责圆角缺口）
    const bubble = el.querySelector('.wa-bubble');
    if (bubble) bubble.insertAdjacentHTML('beforeend', tailSvg(msg.dir === 'out'));
    list?.appendChild(el);

    U.msgs.push(msg);
    scrollBottom(false);

    // 语音播放
    el.querySelector('[data-play]')?.addEventListener('click', () => toggleAudio(el, msg));
  }

  // 把一张图并进上一条消息的网格。返回 false 表示网格已满，调用方应另起一行。
  function appendToImageGroup(row, msg) {
    const bubble = row.querySelector('.wa-bubble');
    if (!bubble) return false;

    let grid = bubble.querySelector('.wa-img-grid');
    if (!grid) {
      if (bubble.querySelectorAll('img.wa-img').length >= GROUP_MAX) return false;
      grid = doc.createElement('div');
      grid.className = 'wa-img-grid';
      // 首图原本是裸 <img>，搬到网格容器里
      Array.from(bubble.querySelectorAll('img.wa-img')).forEach(img => grid.appendChild(img));
      const meta = bubble.querySelector('.wa-meta');
      if (meta) bubble.insertBefore(grid, meta); else bubble.appendChild(grid);
    } else if (grid.querySelectorAll('img.wa-img').length >= GROUP_MAX) {
      return false;
    }

    const img = doc.createElement('img');
    img.className = 'wa-img';
    img.src = msg.url;
    img.dataset.full = msg.url;
    img.alt = '图片';
    img.loading = 'lazy';
    grid.appendChild(img);
    grid.dataset.n = String(grid.querySelectorAll('img.wa-img').length);
    // 行身份跟随组内最新一张，否则下一张来时对不上 prevEl.dataset.id 会另起一行
    row.dataset.id = msg.id;
    row.dataset.dir = msg.dir;

    // 尾巴与时间跟随组内最后一张
    row.classList.remove('tail');
    row.querySelector('.wa-tail')?.remove();
    row.classList.add('tail');
    bubble.insertAdjacentHTML('beforeend', tailSvg(msg.dir === 'out'));
    const t = bubble.querySelector('.wa-meta .t');
    if (t) t.textContent = hhmm(msg.ts);

    U.msgs.push(msg);
    U.index.set(msg.id, { el: row, msg });
    scrollBottom(false);
    return true;
  }

  // 对方「正在输入」。不进消息索引，纯装饰行，随时可丢弃。
  function showTyping(on) {
    const list = $('msgs');
    if (!list) return;
    const el = list.querySelector('.wa-typing-row');
    if (!on) { el?.remove(); return; }
    if (el) return;
    const row = doc.createElement('div');
    row.className = 'wa-row in wa-typing-row';
    row.innerHTML = '<div class="wa-bubble"><div class="wa-typing"><i></i><i></i><i></i></div></div>';
    list.appendChild(row);
    scrollBottom(false);
  }

  function patchMessage(id, patch) {
    const rec = U.index.get(id);
    if (!rec) return;
    Object.assign(rec.msg, patch);
    const row = rec.el;
    const bubble = row.querySelector('.wa-bubble');

    // 状态图标
    const meta = row.querySelector('.wa-meta');
    if (meta) {
      meta.innerHTML = `<span class="t">${hhmm(rec.msg.ts)}</span>${rec.msg.dir === 'out' ? CHECK_SVG(rec.msg.status) : ''}`;
    }
    // 进度
    const mask = row.querySelector('.wa-sending-mask');
    if (patch.progress != null) {
      const txt = row.querySelector('.wa-progress-text');
      if (txt) txt.textContent = patch.progress + '%';
      if (patch.progress >= 100 || patch.status === 'sent' || patch.status === 'failed') {
        mask?.remove();
        txt?.remove();
      }
    }
    if (patch.status === 'failed') {
      mask?.remove();
      row.querySelector('.wa-progress-text')?.remove();
      bubble?.classList.add('failed');
    }
  }

  function toggleAudio(row, msg) {
    const key = msg.id;
    let a = U.audioEls.get(key);
    if (!a) {
      a = new Audio(msg.url);
      U.audioEls.set(key, a);
      a.addEventListener('timeupdate', () => {
        const pct = a.duration ? a.currentTime / a.duration : 0;
        row.querySelectorAll('[data-wave] i').forEach((bar, i, all) => {
          bar.classList.toggle('on', i / all.length <= pct);
        });
      });
      a.addEventListener('ended', () => {
        row.querySelector('[data-play]')?.replaceChildren(...[svgEl('play', 20)]);
        row.querySelectorAll('[data-wave] i').forEach(b => b.classList.remove('on'));
      });
    }
    const btn = row.querySelector('[data-play]');
    if (a.paused) {
      a.play().catch(() => toast('无法播放'));
      btn?.replaceChildren(...[svgEl('pause', 20)]);
    } else {
      a.pause();
      btn?.replaceChildren(...[svgEl('play', 20)]);
    }
  }

  function svgEl(name, size) {
    const d = doc.createElement('div');
    d.innerHTML = svg(name, size);
    return d.firstElementChild;
  }

  // ==================== 全屏查看 ====================

  function openViewer(kind, url) {
    let v = root.querySelector('.wa-viewer');
    if (!v) {
      v = doc.createElement('div');
      v.className = 'wa-viewer';
      v.innerHTML = `<button class="close">${svg('close', 22)}</button>`;
      root.appendChild(v);
      v.addEventListener('click', e => {
        if (e.target === v || e.target.closest('.close')) v.classList.remove('on');
      });
    }
    const close = v.querySelector('.close');
    v.querySelectorAll('img,video').forEach(n => n.remove());
    const node = doc.createElement(kind === 'video' ? 'video' : 'img');
    node.src = url;
    if (kind === 'video') { node.controls = true; node.autoplay = true; }
    v.insertBefore(node, close);
    v.classList.add('on');
  }

  // ==================== 状态与事件 ====================

  function setHeaderStatus(text, live) {
    const el = $('hdStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('live', Boolean(live));
  }

  function showBanner(text, actionLabel, action) {
    const b = $('banner');
    if (!b) return;
    if (!text) { b.classList.remove('on'); b.innerHTML = ''; return; }
    b.innerHTML = `<span>${esc(text)}</span>${actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : ''}`;
    b.classList.add('on');
    if (actionLabel && action) b.querySelector('button').onclick = action;
  }

  function handleEvent(ev) {
    switch (ev.type) {
      case 'ready':
        U.identity = ev.identity;
        if (U.view !== 'chat') mountRoster();
        D.goOnline();
        break;

      case 'identity':
        if (U.view === 'roster') mountRoster();
        break;

      case 'discoverable':
        refreshRoster();
        break;

      case 'roster':
        U.roster = ev.peers || [];
        refreshRoster();
        break;

      case 'lobby':
        // 大厅断线由 core 静默重连，这里不打扰
        break;

      case 'invite':
        U.invite = ev.from;
        showInviteDialog(ev.from);
        break;

      case 'room-ready':
        if (U.invite) U.invite = null;
        root.querySelector('.wa-invite')?.remove();
        toast('对方已接受，正在建立连接…');
        enterRoom(ev.roomId, ev.password);
        break;

      case 'state': {
        const map = {
          connecting: '正在连接…',
          online: '已连接服务器',
          negotiating: '正在建立安全连接…',
          open: '已连接',
          unstable: '网络波动，等待恢复…',
          failed: '连接失败',
          offline: '已断线',
          waiting: '等待对方进入…',
          idle: '未连接'
        };
        if (U.view === 'chat') {
          setHeaderStatus(ev.detail || map[ev.phase] || ev.phase, ev.phase === 'open');
          if (ev.phase === 'offline' || ev.phase === 'failed') {
            showBanner(ev.detail || '连接已断开', '重连', () => {
              const st = D.state();
              if (st.room) enterRoom(st.room, storage.getItem('zsjws_pass_' + st.room) || '');
            });
          } else if (ev.phase === 'open') {
            showBanner(null);
          }
        }
        break;
      }

      case 'typing':
        showTyping(!!ev.on);
        break;

      case 'message':
        if (U.view === 'chat') appendMessage(ev.msg);
        break;

      case 'message-update':
        patchMessage(ev.id, ev.patch);
        break;

      case 'receive-progress':
        break;

      case 'system':
        if (U.view === 'chat') addSystem(ev.text);
        break;

      case 'toast':
        toast(ev.text);
        break;

      case 'call':
        handleCallEvent(ev);
        break;

      case 'recording':
        if (ev.seconds < 0) {
          $('recbar')?.classList.remove('on');
        } else {
          $('recbar')?.classList.add('on');
          const t = $('recTime');
          if (t) t.textContent = `录音中 ${ev.seconds}s`;
        }
        break;

      case 'camera':
        break;

      case 'disconnected':
        if (U.view === 'chat') {
          setHeaderStatus('连接已断开', false);
          showBanner('与服务器的连接已断开', '重连', () => {
            const st = D.state();
            if (st.room) enterRoom(st.room, storage.getItem('zsjws_pass_' + st.room) || '');
          });
        }
        break;
    }
  }

  function handleCallEvent(ev) {
    if (U.view !== 'chat') return;
    if (ev.state === 'incoming') {
      showInviteDialog(U.peerName || '对方', ev.kind, true);
    } else if (ev.state === 'outgoing') {
      setHeaderStatus('正在呼叫…', true);
    } else if (ev.state === 'active') {
      setHeaderStatus('通话中', true);
    } else if (ev.state === 'ended') {
      setHeaderStatus('已连接', true);
    } else if (ev.state === 'failed') {
      toast('通话连接失败');
    }
  }

  function showInviteDialog(from, kind, isCall) {
    root.querySelector('.wa-invite')?.remove();
    const who = from?.name || from || '对方';
    const el = doc.createElement('div');
    el.className = 'wa-invite';
    el.style.cssText = 'position:fixed;inset:0;z-index:80;display:grid;place-items:center;background:rgba(0,0,0,.45);padding:24px';
    el.innerHTML = `
      <div style="background:var(--wa-panel-bg);border-radius:16px;padding:24px;width:100%;max-width:320px;text-align:center">
        ${avatarHtml(who, 'md', true)}
        <div style="margin:14px 0 6px;font-size:16px;font-weight:600">${esc(who)}</div>
        <div style="font-size:13px;color:var(--wa-text-secondary);margin-bottom:20px">
          ${isCall ? (kind === 'video' ? '发起视频通话' : '发起语音通话') : '想和你建立会话'}
        </div>
        <div style="display:flex;gap:10px">
          <button class="wa-btn ghost" style="margin:0" data-no>拒绝</button>
          <button class="wa-btn primary" data-yes>接受</button>
        </div>
      </div>`;
    root.appendChild(el);

    el.querySelector('[data-no]').onclick = () => {
      el.remove();
      if (isCall) D.rejectCall();
      else D.answerInvite(from?.peerId || from, false);
      U.invite = null;
    };
    el.querySelector('[data-yes]').onclick = () => {
      el.remove();
      if (isCall) D.acceptCall();
      else D.answerInvite(from?.peerId || from, true);
    };
  }

  // ==================== 启动 ====================

  function boot() {
    // 引擎由驱动外层（懒装载）负责 mount，这里不再重复装载
    U.identity = D.state().identity;
    U.unsub = D.subscribe(handleEvent);

    // 旧分享链接（?room=&pass=）仍可直接进入会话；否则进入 IM 式访客列表
    const room = config.room || null;
    const pass = config.pass || null;
    if (room && pass && /^\d{6}$/.test(pass)) {
      enterRoom(room, pass);
    } else if (U.view !== 'chat') {
      mountRoster();
    }
    D.goOnline();

    // 禁止移动端双指缩放（与原有行为一致）
    root.addEventListener('gesturestart', e => e.preventDefault());
  }

  boot();

  return {
    dispose() {
      try { if (U.unsub) U.unsub(); } catch (_) { /* 忽略 */ }
      try { if (app.parentNode) app.parentNode.removeChild(app); } catch (_) { /* 忽略 */ }
    },
  };
}

// ── index.js ──────────────────────────────────────────────
/**
 * index.js —— SDK 契约面（唯一入口）
 *
 * 导出形状：只有命名导出，**没有 `export default`**
 * （母体取 `mod.default ?? mod`，两者并存时只读 default，命名导出会被静默忽略）。
 *
 * 形态（宪法第 10 条）：
 *   - `form=capability` 或没有槽位 → headless：不渲染任何 DOM，能力照常可用；
 *   - `form=ui` 且有槽位       → 在槽位里放一个几何按钮，点击展开整块业务。
 *
 * 懒装载：`mount` 只建 DOM，**不建任何网络连接**；引擎（含 WS）在用户第一次点击
 * 按钮时才装载。这样契约测试（Node 里模拟 ctx）不会因为发网络请求而挂起。
 *
 * 清理（第 7/8 条）：一切子资源登记到 `ctx.onDispose`，不使用 mount 返回值；
 * `unmount()` 幂等，未 mount 过调用是 no-op。
 */
// 注意：拼接式打包器对 `x as y` 别名导入处理不完整（会丢绑定），这里不用别名

/**
 * 引擎门面：UI 层只依赖这一组方法名（与原工程的 window.ZsjwsDriver 面孔一致）。
 * 不把引擎模块直接交给 UI，避免 UI 摸到内部实现。
 */
const engineApi = {
  state, subscribe,
  connect: driverConnect, disconnect,
  sendText, sendTyping, sendFile: sendBlob,
  startRecording, cancelRecording, stopAndSendRecording,
  goOnline, invite, answerInvite,
  startCall, acceptCall, rejectCall,
  setName, setDiscoverable,
}

/** @type {null | object} */
let inst = null

/** 母体在 `LOADED` 之后、`ACTIVE` 之前调用。 */
export async function mount(ctx) {
  const c = ctx || {}
  const id = c.id || DRIVER_ID

  if (inst) {
    try { if (typeof c.log === 'function') c.log(`[${id}] 已装载，忽略重复 mount`) } catch (_) {}
    return
  }

  const bridge = createBridge(c, id)
  const log = bridge.log

  // 业务路径的总线同步（I-7 预备件）：**装载即申请一次订阅**，成不成由总线裁决。
  // 被拒就停在 denied、不发布、不重试——审批前与审批后跑的是同一份代码。
  const busSync = createImBusSync({ bus: bridge.bus, snapshot: busSnapshot, log })
  const offEngineState = subscribe((ev) => {
    if (ev && ev.type === 'state') busSync.notify()
  })
  busSync.attach()

  // 形态裁决结果由母体给；旧母体不注入 form 时按槽位是否授予推断（契约 L4 的兼容分支）
  const slot = c.slots ? c.slots[SLOT_NAME] : null
  const form = c.form || (slot ? 'ui' : 'capability')
  const headless = form !== 'ui' || !slot

  inst = {
    id, bridge, busSync, root: null, launcher: null, layer: null,
    headless, form, engineReady: false,
    backendUrl: attr(slot, 'data-backend'),
    shareCode: attr(slot, 'data-sharecode'),
  }

  // 退订与引擎事件监听都挂在 bridge 上：headless 与 ui 两条路径共用同一套清理
  bridge.onDispose(() => {
    try { offEngineState() } catch (_) { /* 引擎事件总线可能已随引擎一起卸了 */ }
    try { busSync.detach() } catch (_) { /* 总线已关时退订会抛，忽略 */ }
  })

  if (headless) {
    log(`headless 装载（form=${form}，槽位${slot ? '已' : '未'}授予）：不渲染 DOM`)
    bridge.onDispose(() => { inst = null })
    return
  }

  const doc = slot.ownerDocument || (typeof document !== 'undefined' ? document : null)
  if (!doc) {
    log('槽位没有 ownerDocument，降级 headless')
    inst.headless = true
    bridge.onDispose(() => { inst = null })
    return
  }

  // 根节点：驱动自己的容器，所有 DOM 都挂在它下面，卸载时整棵移除
  const root = doc.createElement('div')
  root.setAttribute('class', ROOT_CLASS)
  root.setAttribute('data-module', id)
  root.setAttribute('data-wim-root', '')
  injectStyles(doc, root)

  const layer = createLayer(doc, id, () => { /* 关闭层：引擎保持在线，不主动断连 */ })
  const launcher = createLauncher(doc, id, () => {
    layer.open()
    ensureEngine()
  })

  root.appendChild(launcher.el)
  root.appendChild(layer.el)

  // 槽位可能是空的，也可能已有别的节点；只追加，不清理别人的东西
  slot.appendChild(root)

  inst.root = root
  inst.launcher = launcher
  inst.layer = layer

  // ---- 业务界面：引擎就绪后挂进层体，之后常驻（关闭层只是隐藏，不断连）----
  let ui = null
  function mountUi() {
    if (ui) return
    try {
      layer.body.setAttribute('class', 'wim-panel-body wim-app-host')
      layer.setBody(null)
      // 业务界面自带身份与导航，宿主条只留标题与关闭，避免重复
      layer.setStatus('')
      // 业务壳是全屏的，标题栏会被盖住 → 转 bare，改用左侧收起把手
      layer.setBare(true)
      ui = createUi({
        root: layer.body,
        D: engineApi,
        storage: {
          get: (k) => bridge.storage.get(k),
          set: (k, v) => bridge.storage.set(k, v),
          remove: (k) => bridge.storage.remove(k),
        },
        config: { shareCode: inst.shareCode, room: inst.room, pass: inst.pass },
      })
      inst.ui = ui
    } catch (e) {
      layer.setStatus('界面加载失败')
      layer.setBody(textNode(doc, '业务界面加载失败：' + (e && e.message ? e.message : e)))
      log('UI 装载异常：' + (e && e.message ? e.message : e))
    }
  }

  // ---- 懒装载引擎：第一次点开才建 WS / 拉 ICE ----
  let enginePromise = null
  function ensureEngine() {
    if (inst.engineReady) return Promise.resolve(true)
    if (enginePromise) return enginePromise
    enginePromise = (async () => {
      try {
        // 先把 kv 里的旧身份灌进同步镜像，再装引擎 —— 否则重装会生成新身份
        await bridge.storage.preloadAll()
        // preload 是异步的，期间母体可能已经 unmount；这时 inst 已被置空，不能再往下走
        if (!inst) return false
        const r = mountEngine(root, {
          backendUrl: inst.backendUrl,
          auth: inst.shareCode,
          storage: {
            get: (k) => bridge.storage.get(k),
            set: (k, v) => bridge.storage.set(k, v),
            remove: (k) => bridge.storage.remove(k),
          },
        })
        if (!inst) { try { unmountEngine() } catch (_) {} return false }
        inst.engineReady = Boolean(r && r.ok)
        if (inst.engineReady) {
          const st = state()
          layer.setStatus(st.identity && st.identity.name ? st.identity.name : '已就绪')
          mountUi()
          log('引擎已装载')
        } else {
          layer.setStatus('装载失败')
          log(`引擎装载失败：${r && r.code ? r.code : 'unknown'}`)
        }
        return inst.engineReady
      } catch (e) {
        // Node/无浏览器环境、或被宿主限制时走到这里：不冒泡，界面给出可行动提示
        try { unmountEngine() } catch (_) {}
        if (!inst) return false
        inst.engineReady = false
        layer.setStatus('当前环境不支持')
        layer.setBody(textNode(doc, '当前环境没有浏览器媒体能力，无法建立会话。请在浏览器中打开。'))
        log(`引擎装载异常：${e && e.message ? e.message : e}`)
        return false
      } finally {
        enginePromise = null
      }
    })()
    return enginePromise
  }

  bridge.onDispose(() => {
    try { if (inst && inst.ui) inst.ui.dispose() } catch (_) {}
    try { if (inst && inst.engineReady) unmountEngine() } catch (_) {}
    try { layer.dispose() } catch (_) {}
    try { launcher.dispose() } catch (_) {}
    try {
      if (root.parentNode) root.parentNode.removeChild(root)
    } catch (_) { /* 宿主 DOM 异常不应冒泡给母体 */ }
    inst = null
  })

  log(`已装载：槽位 ${SLOT_NAME} 出现几何按钮`)
}

/** 母体在 `STOPPING` 之后调用；必须幂等，未 mount 过时是 no-op。 */
export function unmount() {
  if (!inst) return
  const { bridge, layer, launcher, root, engineReady, ui } = inst
  try { if (ui) ui.dispose() } catch (_) {}
  try { if (engineReady) unmountEngine() } catch (_) {}
  try { if (layer) layer.dispose() } catch (_) {}
  try { if (launcher) launcher.dispose() } catch (_) {}
  try { if (root && root.parentNode) root.parentNode.removeChild(root) } catch (_) {}
  try { if (bridge) bridge.disposeAll() } catch (_) {}
  inst = null
}

/** 诊断快照（宿主页面与测试用；母体不依赖它）。 */
export function describe() {
  if (!inst) return null
  const st = inst.engineReady ? state() : null
  return Object.freeze({
    id: inst.id,
    form: inst.form,
    headless: inst.headless,
    uiMounted: Boolean(inst.root),
    layerOpen: Boolean(inst.layer && inst.layer.isOpen()),
    engineReady: Boolean(inst.engineReady),
    businessUi: Boolean(inst.ui),
    phase: st ? st.phase : null,
    online: st ? st.online : false,
    room: st ? st.room : null,
    channel: st ? st.channel : null,
    identity: st ? st.identity : null,
    call: st ? st.call : null,
    persistentStorage: Boolean(inst.bridge && inst.bridge.persistent()),
    /**
     * 总线状态（I-4）：unknown / ready / unavailable / denied / error / absent。
     * **只用于诊断**：母体不读它，业务降级也不由它决定（那是驱动自己的事）。
     */
    busState: inst.bridge ? inst.bridge.busState() : 'absent',
    /**
     * 业务同步状态（I-7）：active 表示订阅已被总线接受、状态变化会发布；
     * denied/unavailable 表示未获授权或总线未装配——业务此时是纯本地模式。
     */
    busSync: inst.busSync ? inst.busSync.status() : 'absent',
    busSessions: inst.busSync ? inst.busSync.sessions().length : 0,
  })
}

/** 发布到总线的业务快照：只放可序列化的轻量字段，不放消息正文与媒体对象。 */
function busSnapshot() {
  const st = state()
  return {
    schema: 'im/state@0',
    phase: st.phase,
    online: Boolean(st.online),
    room: st.room || null,
    channel: st.channel || null,
    peerId: st.identity ? st.identity.peerId || null : null,
    name: st.identity ? st.identity.name || null : null,
    call: st.call ? { kind: st.call.kind, phase: st.call.phase } : null,
  }
}

function attr(el, name) {
  if (!el || typeof el.getAttribute !== 'function') return null
  const v = el.getAttribute(name)
  return v ? String(v) : null
}

function textNode(doc, text) {
  const p = doc.createElement('p')
  p.textContent = text
  return p
}
