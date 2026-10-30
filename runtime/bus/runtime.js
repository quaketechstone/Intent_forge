/**
 * IB-B：Intent Bus 运行时。
 *
 * 职责：路由、订阅、队列、超时、取消、背压。
 * **不做**：审计落盘（只调 `AuditPort`）、母体装配（P3）、门判定（v1 不启用）。
 *
 * 与 IB-A 的关系：本文件调 `contract.ts` 做信封校验、调 `authz.ts` 做授权判定。
 * 所有安全判定都在纯函数里，本文件只负责时序与状态——这样"判定对不对"和
 * "时序对不对"可以分开测，出问题能定位。
 *
 * 契约来源：docs/PROTOCOL.md §3（语义）§5（背压）§6（超时）§7（订阅）、
 *           docs/LIFECYCLE.md §2（总线 4 态）§3（端点 5 态）、
 *           docs/ARCHITECTURE.md §9（BusApi）。
 */
import { BUS_LIMITS, busError, checkPayload, isBusError, validateEnvelope, validateTopic } from './contract.js';
import { decide, remainingQuota, resolveGrants } from './authz.js';
import { systemClock } from './clock.js';
import { createAuditSink } from './audit.js';
import { BUS_SELF_ID, createGovernanceDispatcher, createGovernanceThrottle, governanceTopic, } from './governance.js';
export const DEFAULT_LIMITS = {
    queueMax: BUS_LIMITS.queueMax,
    inflightMax: 256,
    commandsPerMinute: BUS_LIMITS.commandsPerMinute,
    subscriptionsPerEndpoint: BUS_LIMITS.subscriptionsPerEndpoint,
    defaultDeadlineMs: BUS_LIMITS.defaultDeadlineMs,
    maxDeadlineMs: BUS_LIMITS.maxDeadlineMs,
    minDeadlineMs: 100,
    drainMs: 2000,
    auditCapacity: 200,
};
let nonceSeq = 0;
function nextId() {
    // Node 22 / 浏览器均有全局 crypto；不引第三方 uuid 依赖
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function')
        return c.randomUUID();
    // 兜底：非密码学随机，仅用于无法获得 crypto 的环境（测试桩）
    nonceSeq += 1;
    const r = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
    return `${r()}${r()}-${r()}-4${r().slice(1)}-8${r().slice(1)}-${r()}${r()}${r()}`;
}
// ---------------------------------------------------------------------------
// createBus
// ---------------------------------------------------------------------------
export function createBus(options = {}) {
    var _a;
    const clock = (_a = options.clock) !== null && _a !== void 0 ? _a : systemClock;
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    const endpoints = new Map();
    const pending = new Map();
    let busState = 'CREATED';
    let drainResolve = null;
    let drainTimer = null;
    /** 进行中的 close Promise。并发 close 复用同一实例，避免各自抢占 drainResolve */
    let closePromise = null;
    // -- 审计 --------------------------------------------------------------
    /**
     * 总线**始终**自带一个内存环形缓冲，外部端口都是可选的。
     *
     * 为什么不把 sink 放到装配层（`app.ts` 里 `createBus({ auditPort })`）：
     * 那样"审计是否开着"就成了装配参数，装配层少写一行，审计就静默消失，
     * 而且没有任何地方能发现。审计是总线的内建行为，不是可选插件。
     *
     * 外部持久化是**追加**的：内存缓冲先记下，再异步落盘。存储挂了不影响
     * 缓冲里有记录可查（虽然只到容量上限）。
     */
    const sink = createAuditSink({
        clock,
        capacity: limits.auditCapacity,
        store: options.auditStore,
        fanout: options.auditPort,
    });
    function audit(kind, result, extra = {}) {
        // sink.record 内部已包了 try/catch：审计实现抛错不得影响投递
        sink.record({ kind, result, at: clock.now(), ...extra });
    }
    // -- 治理事件（O-18）----------------------------------------------------
    /**
     * `bus:` 订阅计数。只用于"有没有人听"这一件事——没人听就不构造事件。
     *
     * 为什么不在每次拒绝时遍历端点找 `bus:` 订阅：拒绝路径可能被攻击者打满，
     * 遍历（端点 × 订阅）会把一次拒绝变成几百次操作。计数器在两处维护：
     * `subscribe` / `off` 增减，`clearSubs` 整端点清零。
     */
    let govSubs = 0;
    const govThrottle = createGovernanceThrottle(options.governance);
    /**
     * 治理事件投递。
     *
     * **刻意不经过 `publish`**：`publish` 会拒绝 `bus:` 前缀（R-E7）、会走授权表
     * （出厂没有 publish 授权）、还会写审计（`event/ok`）——三者都会让治理事件
     * 要么发不出去，要么把审计变成环。
     */
    const govDispatcher = createGovernanceDispatcher((ev) => {
        for (const ep of endpoints.values()) {
            if (ep.state !== 'LIVE' && ep.state !== 'DRAINING')
                continue;
            const subs = ep.subs.get(ev.topic);
            if (!subs)
                continue;
            for (const sub of subs.values()) {
                try {
                    sub.handler(ev);
                }
                catch {
                    // 订阅者抛错只吞掉：不审计、不再发治理事件。否则一次门实现 bug
                    // 会变成事件风暴，而风暴本身又是新的治理事件来源
                }
            }
        }
    });
    /**
     * 发一条治理事件。同步返回，投递在微任务里。
     *
     * 三条不变量（改动此处前先读 `governance.ts` 顶部注释）：
     *   1. 不调 `audit()`；
     *   2. 不因投递结果再发事件；
     *   3. 被限流/去重抑制时只累加计数，由下一条带出 `dropped`。
     */
    function emitGovernance(kind, fields) {
        var _a, _b, _c, _d;
        if (govSubs === 0)
            return;
        const now = clock.now();
        const key = `${(_a = fields.subject) !== null && _a !== void 0 ? _a : ''}|${(_b = fields.target) !== null && _b !== void 0 ? _b : ''}|${(_c = fields.op) !== null && _c !== void 0 ? _c : ''}|${(_d = fields.relatedTopic) !== null && _d !== void 0 ? _d : ''}|${fields.reason}`;
        const verdict = govThrottle.check(kind, key, now);
        if (!verdict.allow)
            return;
        govDispatcher.enqueue({
            topic: governanceTopic(kind),
            from: BUS_SELF_ID,
            ts: now,
            payload: {
                kind,
                at: now,
                reason: fields.reason,
                ...(fields.subject !== undefined ? { subject: fields.subject } : {}),
                ...(fields.target !== undefined ? { target: fields.target } : {}),
                ...(fields.op !== undefined ? { op: fields.op } : {}),
                ...(fields.relatedTopic !== undefined ? { relatedTopic: fields.relatedTopic } : {}),
                dropped: verdict.dropped,
            },
        });
    }
    /**
     * 清空端点订阅，并同步治理订阅计数。
     *
     * 所有清空点都必须走这里。漏一处会让 `govSubs` 偏高——偏高只会多做无用功，
     * 偏低才会漏事件。计数器的方向是"宁可偏高"，但 `clearSubs` 保证精确。
     */
    function clearSubs(ep) {
        for (const [topic, m] of ep.subs) {
            if (topic.startsWith('bus:'))
                govSubs -= m.size;
        }
        ep.subs.clear();
    }
    // -- 状态 --------------------------------------------------------------
    function refreshBusState() {
        if (busState === 'DRAINING' || busState === 'CLOSED')
            return;
        const hasLive = [...endpoints.values()].some((e) => e.state === 'LIVE' || e.state === 'DRAINING');
        busState = hasLive ? 'READY' : 'CREATED';
    }
    function checkSettled() {
        if (pending.size === 0 && drainResolve) {
            const resolve = drainResolve;
            drainResolve = null;
            if (drainTimer !== null) {
                clock.clearTimeout(drainTimer);
                drainTimer = null;
            }
            resolve();
        }
    }
    function rejectPending(p, error) {
        if (p.settled)
            return;
        p.settled = true;
        clock.clearTimeout(p.timer);
        pending.delete(p.corr);
        p.controller.abort();
        p.reject(error);
        checkSettled();
    }
    // -- 速率 --------------------------------------------------------------
    function consumeRate(endpoint) {
        const now = clock.now();
        if (now - endpoint.usageWindowStart >= 60000) {
            endpoint.usageWindowStart = now;
            endpoint.usageCount = 0;
        }
        const quota = remainingQuota({ perMinute: endpoint.usageCount }, { perMinute: limits.commandsPerMinute });
        if (quota.allowed)
            endpoint.usageCount += 1;
        return quota;
    }
    // -- 投递 --------------------------------------------------------------
    function pump(endpoint) {
        if (endpoint.running)
            return;
        if (endpoint.queue.length === 0)
            return;
        if (endpoint.state !== 'LIVE' && endpoint.state !== 'DRAINING')
            return;
        endpoint.running = true;
        const item = endpoint.queue.shift();
        if (!item) {
            endpoint.running = false;
            return;
        }
        void runOne(endpoint, item).finally(() => {
            endpoint.running = false;
            pump(endpoint);
        });
    }
    async function runOne(endpoint, item) {
        var _a;
        const { envelope, pending: p } = item;
        if (p.settled)
            return;
        const handler = endpoint.handlers.get((_a = envelope.op) !== null && _a !== void 0 ? _a : '');
        if (!handler) {
            rejectPending(p, busError('BUS_NO_ROUTE', 'target has no handler for this operation', { op: envelope.op }));
            audit('command', 'no_route', { subject: p.from, target: p.target, op: p.op, corr: p.corr });
            return;
        }
        let outcome;
        try {
            outcome = await handler(envelope.payload, {
                from: envelope.from,
                corr: p.corr,
                signal: p.controller.signal,
            });
        }
        catch (err) {
            if (p.settled)
                return;
            const name = err instanceof Error ? err.constructor.name : 'Unknown';
            rejectPending(p, busError('BUS_HANDLER_ERROR', 'handler threw', { error: name }));
            audit('command', 'error', { subject: p.from, target: p.target, op: p.op, corr: p.corr, detail: name });
            return;
        }
        if (p.settled)
            return;
        p.settled = true;
        clock.clearTimeout(p.timer);
        pending.delete(p.corr);
        p.resolve(outcome);
        audit('command', 'ok', { subject: p.from, target: p.target, op: p.op, corr: p.corr });
        checkSettled();
    }
    // -- 授权 --------------------------------------------------------------
    function authorize(endpoint, req) {
        return decide(endpoint.grants, req, clock.now());
    }
    // -- 端点 API ----------------------------------------------------------
    function makeApi(endpoint) {
        const self = endpoint;
        return {
            command(target, op, payload, opts) {
                var _a;
                // 顺序：总线终态 → 端点态 → （兜底）未就绪。
                //
                // 为什么 `CREATED` 的检查挪到端点之后（F-3）：最后一个端点注销会把总线
                // 打回 `CREATED`，若先判总线，死句柄就会拿到 BUS_NOT_READY（"等一等就好"），
                // 而注销是终态，等多久都不会好。死句柄必须拿到 BUS_DENIED。
                //
                // 为什么 `CLOSED/DRAINING` 仍在最前：那是**总线级**终态，调用方该停的是
                // 整条总线，而不是只换一个端点——这个信息比"你这个句柄没了"更重要。
                if (busState === 'CLOSED' || busState === 'DRAINING') {
                    return Promise.reject(busError('BUS_CLOSED', 'bus is not accepting commands'));
                }
                if (self.state !== 'LIVE') {
                    return Promise.reject(endpointStateError(self));
                }
                if (busState === 'CREATED') {
                    // 活端点在册即 READY，走到这里说明状态机自身出错：宁可拒绝
                    return Promise.reject(busError('BUS_NOT_READY', 'bus has no live endpoint'));
                }
                if ((_a = opts === null || opts === void 0 ? void 0 : opts.signal) === null || _a === void 0 ? void 0 : _a.aborted) {
                    return Promise.reject(busError('BUS_CANCELLED', 'signal already aborted'));
                }
                const deadlineMs = normalizeDeadline(opts === null || opts === void 0 ? void 0 : opts.deadlineMs, limits);
                const corr = nextId();
                const built = validateEnvelope({
                    v: 1,
                    id: corr,
                    ts: clock.now(),
                    kind: 'command',
                    to: target,
                    op,
                    payload,
                    deadline_ms: deadlineMs,
                }, self.identity.moduleId);
                if (isBusError(built))
                    return Promise.reject(built);
                const decision = authorize(self, {
                    kind: 'command',
                    subject: self.identity.moduleId,
                    target,
                    operation: op,
                    payloadBytes: payloadByteEstimate(built),
                });
                if (decision.status === 'DENY') {
                    audit('denied', 'denied', { subject: self.identity.moduleId, target, op, detail: decision.error.code });
                    emitGovernance('denied', {
                        subject: self.identity.moduleId,
                        target,
                        op,
                        reason: decision.error.code,
                    });
                    return Promise.reject(decision.error);
                }
                if (decision.status === 'UNAVAILABLE') {
                    audit('denied', 'unavailable', { subject: self.identity.moduleId, target, op });
                    emitGovernance('denied', {
                        subject: self.identity.moduleId,
                        target,
                        op,
                        reason: decision.error.code,
                    });
                    return Promise.reject(decision.error);
                }
                const quota = consumeRate(self);
                if (!quota.allowed) {
                    audit('denied', 'backpressure', { subject: self.identity.moduleId, target, op, detail: 'rate' });
                    emitGovernance('pressure', { subject: self.identity.moduleId, target, op, reason: 'rate' });
                    return Promise.reject(busError('BUS_BACKPRESSURE', 'command rate limit exceeded'));
                }
                const dest = endpoints.get(target);
                if (!dest) {
                    audit('command', 'no_route', { subject: self.identity.moduleId, target, op });
                    return Promise.reject(busError('BUS_NO_ROUTE', 'target endpoint is not registered'));
                }
                if (dest.state !== 'LIVE') {
                    audit('command', 'peer_gone', { subject: self.identity.moduleId, target, op });
                    return Promise.reject(busError('BUS_PEER_GONE', dest.state === 'REVOKED' ? 'target is revoked' : 'target is not live'));
                }
                if (pending.size >= limits.inflightMax) {
                    audit('command', 'backpressure', { subject: self.identity.moduleId, target, op, detail: 'inflight' });
                    emitGovernance('pressure', { subject: self.identity.moduleId, target, op, reason: 'inflight' });
                    return Promise.reject(busError('BUS_BACKPRESSURE', 'inflight limit reached'));
                }
                // 容量必须算上"正在执行的那一条"：只数 queue.length 会让
                // queueMax=1 时永远放行第二条——它入队后不消费，调用方悬挂到超时
                const occupancy = dest.queue.length + (dest.running ? 1 : 0);
                if (occupancy >= limits.queueMax) {
                    audit('command', 'backpressure', { subject: self.identity.moduleId, target, op, detail: 'queue' });
                    emitGovernance('pressure', { subject: self.identity.moduleId, target, op, reason: 'queue' });
                    return Promise.reject(busError('BUS_BACKPRESSURE', 'target queue is full'));
                }
                const controller = new AbortController();
                let resolveFn;
                let rejectFn;
                const promise = new Promise((res, rej) => {
                    resolveFn = res;
                    rejectFn = rej;
                });
                const timer = clock.setTimeout(() => {
                    const p = pending.get(corr);
                    if (!p)
                        return;
                    // rejectPending 内部会 abort controller，目标的 handler 经 signal 感知。
                    // 不额外投递 cancel 消息：取消是 best-effort，signal 已足够（R-X1/R-X3）
                    rejectPending(p, busError('BUS_TIMEOUT', 'command deadline exceeded', { corr }));
                    audit('command', 'timeout', { subject: self.identity.moduleId, target, op, corr });
                }, deadlineMs);
                const p = {
                    corr,
                    from: self.identity.moduleId,
                    target,
                    op,
                    timer,
                    controller,
                    settled: false,
                    resolve: resolveFn,
                    reject: rejectFn,
                };
                pending.set(corr, p);
                if (opts === null || opts === void 0 ? void 0 : opts.signal) {
                    opts.signal.addEventListener('abort', () => {
                        const cur = pending.get(corr);
                        if (cur)
                            rejectPending(cur, busError('BUS_CANCELLED', 'command cancelled by caller', { corr }));
                    }, { once: true });
                }
                dest.queue.push({ envelope: built, pending: p });
                pump(dest);
                return promise;
            },
            publish(topic, payload) {
                if (busState === 'CLOSED' || busState === 'DRAINING') {
                    throw busError('BUS_CLOSED', 'bus is not accepting events');
                }
                if (self.state !== 'LIVE')
                    throw endpointStateError(self);
                if (!validateTopic(topic)) {
                    audit('event', 'error', { subject: self.identity.moduleId, topic, detail: 'invalid topic' });
                    throw busError('BUS_MALFORMED', 'invalid topic');
                }
                // `bus:` 前缀保留给总线自身。驱动若能发 `bus:denied`，
                // 治理事件就变成可伪造的——这是必须堵住的一条
                if (topic.startsWith('bus:')) {
                    audit('denied', 'denied', { subject: self.identity.moduleId, topic, detail: 'reserved prefix' });
                    emitGovernance('denied', {
                        subject: self.identity.moduleId,
                        relatedTopic: topic,
                        reason: 'reserved prefix',
                    });
                    throw busError('BUS_DENIED', 'topic prefix bus: is reserved');
                }
                // O-17：发布也要过授权表。只校验主题格式是不够的——那等于"任何能调
                // publish 的驱动都能伪造任何主题的事件"，订阅方无从分辨真伪。
                const decision = authorize(self, {
                    kind: 'publish',
                    subject: self.identity.moduleId,
                    topic,
                });
                if (decision.status !== 'ALLOW') {
                    audit('denied', decision.status === 'DENY' ? 'denied' : 'unavailable', {
                        subject: self.identity.moduleId,
                        topic,
                        detail: decision.error.code,
                    });
                    emitGovernance('denied', {
                        subject: self.identity.moduleId,
                        relatedTopic: topic,
                        reason: decision.error.code,
                    });
                    throw decision.error;
                }
                // BUS-LIMIT-1：`publish()` 不走 `validateEnvelope()`，载荷上限必须在这里
                // 显式执行（与 `command()` 共用 `checkPayload`，不存在第二份实现）。
                //
                // 位置在授权**之后**：未授权方连"限额是多少"都不该探测到——先拿 BUS_DENIED。
                // 位置在构造 `BusEvent` **之前**：载荷根本没进入任何队列，不存在"先入队后丢弃"。
                // 位置在遍历订阅者**之前**：拒绝时订阅者 handler 一次都不会被调用。
                const payloadError = checkPayload(payload);
                if (payloadError !== null) {
                    audit('event', 'error', {
                        subject: self.identity.moduleId,
                        topic,
                        detail: payloadError.code,
                    });
                    throw payloadError;
                }
                const ev = {
                    topic,
                    from: self.identity.moduleId,
                    payload,
                    ts: clock.now(),
                };
                let matched = 0;
                let delivered = 0;
                let failed = 0;
                for (const ep of endpoints.values()) {
                    if (ep.state !== 'LIVE' && ep.state !== 'DRAINING')
                        continue;
                    const subs = ep.subs.get(topic);
                    if (!subs)
                        continue;
                    for (const sub of subs.values()) {
                        matched += 1;
                        try {
                            sub.handler(ev);
                            delivered += 1;
                        }
                        catch {
                            failed += 1;
                            // R-E3：单个订阅者抛错不影响其他订阅者。
                            // detail 用错误码而不是自由文本，让"订阅者抛错"这件事可机器统计
                            audit('event', 'error', {
                                subject: ep.identity.moduleId,
                                topic,
                                detail: 'BUS_SUBSCRIBER_ERROR',
                            });
                        }
                    }
                }
                // 三态必须分开：
                //   ok       至少一个订阅者收到
                //   error    有订阅者，但**全部**抛错
                //   unrouted 真的没人订阅
                // 把"全失败"记成 unrouted，运维会去查"驱动为什么没订阅这个主题"，
                // 而实际是订阅者的 handler 崩了——排查方向完全相反。
                audit('event', delivered > 0 ? 'ok' : matched > 0 ? 'error' : 'unrouted', {
                    subject: self.identity.moduleId,
                    topic,
                    ...(failed > 0 ? { detail: `${failed}/${matched} subscriber(s) threw` } : {}),
                });
            },
            subscribe(topic, handler) {
                if (self.state !== 'LIVE') {
                    // 订阅失败必须显式，不能返回一个什么都不做的 off——
                    // 那会让驱动以为订阅成功，之后永远收不到事件也查不出原因
                    throw endpointStateError(self);
                }
                if (!validateTopic(topic)) {
                    throw busError('BUS_MALFORMED', 'invalid topic');
                }
                const decision = authorize(self, {
                    kind: 'subscribe',
                    subject: self.identity.moduleId,
                    topic,
                });
                if (decision.status !== 'ALLOW') {
                    audit('denied', decision.status === 'DENY' ? 'denied' : 'unavailable', {
                        subject: self.identity.moduleId,
                        topic,
                        detail: decision.error.code,
                    });
                    emitGovernance('denied', {
                        subject: self.identity.moduleId,
                        relatedTopic: topic,
                        reason: decision.error.code,
                    });
                    throw decision.error;
                }
                let byTopic = self.subs.get(topic);
                if (!byTopic) {
                    // 上限按**订阅条数**算，不是主题数——一个主题挂 32 个 handler
                    // 与挂 32 个主题同样耗资源
                    if (countSubscriptions(self) >= limits.subscriptionsPerEndpoint) {
                        throw busError('BUS_BACKPRESSURE', 'subscription limit reached');
                    }
                    byTopic = new Map();
                    self.subs.set(topic, byTopic);
                }
                const existing = byTopic.get(handler);
                if (existing)
                    return existing.off; // R-S5：幂等
                const off = () => {
                    const m = self.subs.get(topic);
                    if (!m)
                        return;
                    // 只有真的删掉才减计数：重复调用 off 不能让 govSubs 变负，
                    // 变负会让"没人听就不构造事件"的短路永久失效（静默漏事件）
                    if (m.delete(handler) && topic.startsWith('bus:'))
                        govSubs -= 1;
                    if (m.size === 0)
                        self.subs.delete(topic);
                };
                byTopic.set(handler, { handler, off });
                if (topic.startsWith('bus:'))
                    govSubs += 1;
                return off;
            },
            cancel(corrId) {
                const p = pending.get(corrId);
                if (!p)
                    return false; // R-X4：取消已完成/不存在的 corr 返回 false，不报错
                rejectPending(p, busError('BUS_CANCELLED', 'command cancelled', { corr: corrId }));
                audit('cancel', 'cancelled', { subject: p.from, target: p.target, op: p.op, corr: corrId });
                return true;
            },
            handle(op, fn) {
                if (self.handlers.has(op)) {
                    throw busError('BUS_MALFORMED', 'handler already registered for this operation', { op });
                }
                self.handlers.set(op, fn);
                return () => {
                    if (self.handlers.get(op) === fn)
                        self.handlers.delete(op);
                };
            },
        };
    }
    // -- 公共 API ----------------------------------------------------------
    /**
     * 端点下线：清订阅、清队列、在飞命令按 PEER_GONE 收尾。
     *
     * 必须先于 `endpoints.delete` 调用，否则在飞命令找不到目标。
     */
    function teardown(ep, reason) {
        ep.state = 'GONE';
        clearSubs(ep);
        ep.queue.length = 0;
        for (const p of [...pending.values()]) {
            if (p.target === ep.identity.moduleId) {
                rejectPending(p, busError(reason === 'closed' ? 'BUS_CLOSED' : 'BUS_PEER_GONE', 'target endpoint gone'));
            }
        }
    }
    /**
     * 解析端点授权表。
     *
     * 注入 `grantsFor` 时走注入（测试用）；否则走 `resolveGrants`，
     * 并把"声明被拒"写进审计——否则驱动会看到"我声明了但没生效"却查不出原因。
     */
    function resolveEndpointGrants(identity) {
        const subject = { id: identity.moduleId, trust: identity.trust };
        if (options.grantsFor)
            return options.grantsFor(subject, identity.declared);
        const resolved = resolveGrants(subject, identity.declared);
        if (resolved.rejected !== undefined) {
            audit('reauth', 'denied', { subject: identity.moduleId, detail: resolved.rejected });
        }
        return resolved.grants;
    }
    return {
        get state() {
            return busState;
        },
        register(identity) {
            if (busState === 'CLOSED' || busState === 'DRAINING') {
                throw busError('BUS_CLOSED', 'bus is closing');
            }
            // 保留 id：治理事件的 `from` 恒为 `intent.bus`。若允许驱动占用，
            // 订阅方就无法分辨"总线说的"和"某个驱动冒充总线说的"
            if (identity.moduleId === BUS_SELF_ID) {
                throw busError('BUS_DENIED', 'moduleId is reserved for the bus itself');
            }
            const previous = endpoints.get(identity.moduleId);
            if (previous) {
                // 同 id 重装：旧实例作废，在飞命令按 PEER_GONE 处理。
                // 复用旧端点会让旧 instanceNonce 的凭证继续生效（ARCHITECTURE.md §4.1）
                teardown(previous, 'peer_gone');
            }
            const endpoint = {
                identity,
                state: 'LIVE',
                grants: resolveEndpointGrants(identity),
                handlers: new Map(),
                subs: new Map(),
                queue: [],
                running: false,
                usageWindowStart: clock.now(),
                usageCount: 0,
            };
            endpoints.set(identity.moduleId, endpoint);
            refreshBusState();
            audit('register', 'ok', { subject: identity.moduleId });
            return makeApi(endpoint);
        },
        revoke(moduleId) {
            const ep = endpoints.get(moduleId);
            if (!ep || ep.state === 'GONE')
                return;
            ep.state = 'REVOKED';
            ep.grants = [];
            clearSubs(ep);
            // 在飞命令立即 BUS_DENIED（LIFECYCLE.md §3.2）。
            // 同时拦截本端点**已发出**的在飞命令（p.from === moduleId）：revoke 语义是
            // "不可收发"，只拦入站会留下"已撤销模块仍能收到响应"的残口——调用方拿着
            // 死句柄还能 await 出结果，等于授权撤销不彻底（授权绕过残余）。
            for (const p of [...pending.values()]) {
                if (p.target === moduleId || p.from === moduleId) {
                    rejectPending(p, busError('BUS_DENIED', 'endpoint authorization revoked'));
                }
            }
            ep.queue.length = 0;
            refreshBusState();
            audit('unregister', 'denied', { subject: moduleId, detail: 'revoked' });
            emitGovernance('revoked', { subject: moduleId, reason: 'revoked' });
        },
        unregister(moduleId) {
            const ep = endpoints.get(moduleId);
            if (!ep)
                return;
            teardown(ep, 'peer_gone');
            endpoints.delete(moduleId);
            refreshBusState();
            audit('unregister', 'ok', { subject: moduleId });
        },
        async close() {
            if (busState === 'CLOSED')
                return closePromise !== null && closePromise !== void 0 ? closePromise : Promise.resolve();
            // 已有一次 close 在进行：复用其 Promise，不再进入排空逻辑。否则两个并发
            // close 会各自抢占 `drainResolve`——后到的覆盖先到的，先进入的那个永远等
            // 不到 resolve，Promise.all([close(), close()]) 永久悬挂。复用一个实例，
            // 两侧都等同一份完成。
            if (closePromise)
                return closePromise;
            busState = 'DRAINING';
            // 只**入队**，不在这里 await。此处 await 会让 close() 在装载排空定时器
            // 之前让出：假时钟测试推进时钟时定时器还没挂上，于是永远不触发，
            // close() 永久悬挂。投递统一放在排空之后（那时端点还在，收得到）
            emitGovernance('closed', { reason: 'bus closing' });
            closePromise = (async () => {
                if (pending.size > 0) {
                    await new Promise((resolve) => {
                        drainResolve = resolve;
                        drainTimer = clock.setTimeout(() => {
                            drainTimer = null;
                            const r = drainResolve;
                            drainResolve = null;
                            r === null || r === void 0 ? void 0 : r();
                        }, limits.drainMs);
                    });
                }
                // 排空超时后仍在飞的命令一律超时收尾，不留悬挂 Promise
                for (const p of [...pending.values()]) {
                    rejectPending(p, busError('BUS_CLOSED', 'bus closed during drain'));
                }
                // 端点尚未清空，此时投递 `bus:closed` 才有人能收到。
                // 排在排空之后而不是之前，是为了让 close() 的同步段不被打断
                await govDispatcher.drain();
                for (const ep of endpoints.values()) {
                    ep.state = 'GONE';
                    clearSubs(ep);
                    ep.queue.length = 0;
                    ep.handlers.clear();
                }
                endpoints.clear();
                govDispatcher.discard();
                busState = 'CLOSED';
                audit('closed', 'ok');
                // 关闭后仍要把待落盘的一批交出去，否则最后几条审计永远留在内存里。
                // 失败不影响 close 成功——审计落盘不该成为关停的阻塞点
                await sink.close();
            })();
            return closePromise;
        },
        stats() {
            let live = 0;
            let queued = 0;
            for (const ep of endpoints.values()) {
                if (ep.state === 'LIVE')
                    live += 1;
                queued += ep.queue.length;
            }
            return {
                state: busState,
                endpoints: endpoints.size,
                liveEndpoints: live,
                inflight: pending.size,
                queued,
                pendingTimers: pending.size,
            };
        },
        auditSnapshot(limit) {
            return sink.snapshot(limit);
        },
        auditStats() {
            return sink.stats();
        },
        flushAudit() {
            return sink.flush();
        },
    };
}
// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------
/**
 * 端点非 LIVE 时的错误（F-3）。
 *
 * 区分三种情况，因为调用方该做的事不同：
 *   - `REVOKED` → BUS_DENIED：权限被撤，重试无意义；
 *   - `GONE`    → BUS_DENIED：端点已注销（模块被销毁/重装）。**曾经**这里返回
 *                 `BUS_NOT_READY`，语义是"等一等就好了"——但注销是终态，等多久
 *                 都不会好，那个码会诱导调用方在死句柄上无限重试；
 *   - 其余      → BUS_NOT_READY：真的还没就绪。
 *
 * 为什么 GONE 不用 `BUS_CLOSED`：那是**总线级**状态，会让调用方以为整条总线
 * 停了，从而停掉其他仍然健康的端点。
 */
function endpointStateError(ep) {
    if (ep.state === 'REVOKED')
        return busError('BUS_DENIED', 'endpoint authorization revoked');
    if (ep.state === 'GONE')
        return busError('BUS_DENIED', 'endpoint is no longer registered');
    return busError('BUS_NOT_READY', 'endpoint is not live');
}
function countSubscriptions(ep) {
    let n = 0;
    for (const m of ep.subs.values())
        n += m.size;
    return n;
}
function normalizeDeadline(requested, limits) {
    if (requested === undefined || !Number.isFinite(requested))
        return limits.defaultDeadlineMs;
    if (requested < limits.minDeadlineMs)
        return limits.minDeadlineMs;
    if (requested > limits.maxDeadlineMs)
        return limits.maxDeadlineMs;
    return Math.floor(requested);
}
/** 估算 payload 字节数。IB-A 已校验过可序列化，这里只算长度 */
function payloadByteEstimate(envelope) {
    if (envelope.payload === undefined)
        return 0;
    try {
        const json = JSON.stringify(envelope.payload);
        return json === undefined ? 0 : json.length;
    }
    catch {
        return 0;
    }
}
