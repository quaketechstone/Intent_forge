/**
 * IB-B：审计汇集器。
 *
 * 位置：总线内部，**不是**驱动可见接口。驱动拿到的 `ctx.bus` 只有五个方法，
 * 读不到审计记录——审计一旦对驱动可读，"谁在跟谁说话"的元数据就泄漏了。
 *
 * 三条设计约束：
 *
 * 1. **永不阻塞投递**。`record()` 是同步函数，只做入环 + 入批两件事；
 *    落盘走异步 flush，失败只计数不抛错。日志系统坏掉不能把通信一起带停。
 *
 * 2. **只记元数据，不记 payload**。`BusAuditEntry` 的字段里没有 payload 位，
 *    汇集器也不做"顺手把 payload 序列化进去"这种方便事——那会让业务数据
 *    流进日志与存储，且往往没人发现，直到日志被导出。
 *
 * 3. **有界**。环形缓冲固定容量，满了挤掉最旧的并计数。审计量由投递量驱动，
 *    而投递量可能被恶意驱动打满；无界缓冲等于给攻击者一个内存放大杠杆。
 *
 * 编号（`seq` + `sessionId`）在这里生成而不是在 `ports.ts` 的旁路端口里：
 * 存储侧要按主键去重，主键必须由**单一**权威源分配。
 */
import { systemClock } from './clock.js';
/** 出厂默认值。容量对齐 `docs/SECURITY_MODEL.md` 的 `AUDIT_QUEUE_CAP` */
export const AUDIT_DEFAULTS = {
    capacity: 200,
    batchMax: 32,
    flushMs: 1000,
};
let sessionSeq = 0;
function newSessionId(now) {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function')
        return c.randomUUID();
    // 兜底路径：非安全上下文（局域网 `http://` 打开）没有 `randomUUID`。
    //
    // 这里必须**跨标签页**唯一，不能只满足"本进程内唯一"：`(sessionId, seq)`
    // 是存储侧的去重主键，两个标签页撞了 id 不会表现为"重复"，而是**互相覆盖**
    // ——审计静默丢记录，而且丢的那条看上去从未发生。这比报错难查得多。
    //
    // 因此掺三样：时间戳（跨进程、粗粒度）+ 进程内计数（同毫秒同标签页）
    // + 32 位随机（同毫秒跨标签页）。不追求密码学强度，够用即可。
    sessionSeq += 1;
    const rand = c && typeof c.getRandomValues === 'function'
        ? c.getRandomValues(new Uint32Array(1))[0].toString(36)
        : Math.floor(Math.random() * 0x100000000).toString(36);
    return `s${now.toString(36)}-${sessionSeq.toString(36)}-${rand}`;
}
function clampInt(value, fallback, min) {
    if (value === undefined || !Number.isFinite(value))
        return fallback;
    return Math.max(min, Math.floor(value));
}
export function createAuditSink(options = {}) {
    var _a, _b;
    const clock = (_a = options.clock) !== null && _a !== void 0 ? _a : systemClock;
    const capacity = clampInt(options.capacity, AUDIT_DEFAULTS.capacity, 1);
    const batchMax = clampInt(options.batchMax, AUDIT_DEFAULTS.batchMax, 1);
    const flushMs = clampInt(options.flushMs, AUDIT_DEFAULTS.flushMs, 0);
    const store = options.store;
    const fanout = options.fanout;
    const sessionId = (_b = options.sessionId) !== null && _b !== void 0 ? _b : newSessionId(clock.now());
    const ring = [];
    let seq = 0;
    let received = 0;
    let evicted = 0;
    let storeBatches = 0;
    let storeWritten = 0;
    let storeFailed = 0;
    let pending = [];
    let timer = null;
    let closed = false;
    /** 落盘串行链：避免两批并发写导致顺序颠倒 */
    let chain = Promise.resolve();
    function disarm() {
        if (timer === null)
            return;
        clock.clearTimeout(timer);
        timer = null;
    }
    function arm() {
        if (timer !== null || closed || !store)
            return;
        timer = clock.setTimeout(() => {
            timer = null;
            void flush();
        }, flushMs);
    }
    async function drain() {
        disarm();
        while (store && pending.length > 0) {
            const batch = pending;
            pending = [];
            storeBatches += 1;
            try {
                await store.append(batch);
                storeWritten += batch.length;
            }
            catch {
                // 落盘失败：该批丢弃并计数。**不重试**——重试会造成重复记录，
                // 而审计的"条数对账"一旦失真，整条证据链就不可信了
                storeFailed += batch.length;
            }
        }
    }
    function flush() {
        chain = chain.then(drain, drain);
        return chain;
    }
    function record(entry) {
        if (closed)
            return;
        received += 1;
        seq += 1;
        const rec = { ...entry, seq, sessionId };
        if (ring.length >= capacity) {
            ring.shift();
            evicted += 1;
        }
        ring.push(rec);
        if (fanout) {
            try {
                fanout.record(rec);
            }
            catch {
                // 旁路实现抛错不得影响投递
            }
        }
        if (!store)
            return;
        pending.push(rec);
        if (pending.length >= batchMax)
            void flush();
        else
            arm();
    }
    return {
        record,
        snapshot(limit) {
            if (limit === undefined)
                return ring.slice();
            const n = clampInt(limit, ring.length, 0);
            return ring.slice(Math.max(0, ring.length - n));
        },
        stats() {
            return {
                received,
                retained: ring.length,
                evicted,
                storeBatches,
                storeWritten,
                storeFailed,
                storePending: pending.length,
                closed,
            };
        },
        flush,
        async close() {
            if (closed) {
                await flush();
                return;
            }
            closed = true;
            disarm();
            await flush();
        },
    };
}
