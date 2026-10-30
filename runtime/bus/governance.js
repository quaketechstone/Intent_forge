/**
 * 治理事件（`bus:` 命名空间的生产者）—— 关闭 `O-18`。
 *
 * ## 这是什么
 *
 * 出厂授权表给安全门 `intent.sec.kernel` 一条 `bus:` 订阅权，但此前**没有任何
 * 代码路径发布 `bus:*` 事件**，那条授权是空转的。本文件补上生产者。
 *
 * ## 为什么放在总线内部而不是"让驱动发"
 *
 * `bus:` 前缀对驱动是禁发区（`runtime.ts` 的 R-E7）。治理事件如果允许驱动发布，
 * 任何驱动都能伪造一条"某人被拒了"，而门无从分辨——这正是 O-17 的翻版。
 * 所以生产者只能是总线自己。
 *
 * ## 四类事件
 *
 * | 事件 | 触发 | 消费方拿它做什么 |
 * |---|---|---|
 * | `bus:denied` | 授权拒绝（command / subscribe / publish） | 发现越权尝试、发现配置漏授权 |
 * | `bus:pressure` | 背压拒绝（速率 / inflight / 队列） | 判断是否需要扩容或限流策略 |
 * | `bus:revoked` | 端点被 `revoke` | 同步自己的撤销视图 |
 * | `bus:closed` | 总线进入 `DRAINING` | 停止投递、准备卸载 |
 *
 * **不产生**治理事件的动作：`register` / `unregister` / `timeout` / `no_route`。
 * 那些是正常生命周期与正常故障，不是"需要治理方介入"的信号。把它们也发出去，
 * 门会被噪声淹没，真正的越权尝试反而被埋掉。
 *
 * ## 三条硬约束（每条对应一个真实风险）
 *
 * 1. **不阻塞投递**。治理事件走**微任务队列**，拒绝路径先返回。
 *    同步投递等于让门的 handler 站在总线的热路径上——门一慢，全总线跟着慢。
 *
 * 2. **不产生新的治理事件，也不产生审计**。否则成环：
 *    拒绝 → 审计 → 事件 → 门处理 → 门重试 → 再拒绝 → …… 无界放大。
 *    治理事件的投递失败（订阅者抛错）也只吞掉，不再触发任何东西。
 *
 * 3. **限流 + 去重**。同一 `(kind, subject, target, op, reason)` 在窗口内只发一次；
 *    每窗口总条数有上限。被抑制的条数随下一条发出的事件带出（`dropped`），
 *    让消费方知道"你看到的不是全部"——**不静默丢**是这条约束的核心。
 *
 * 第 3 条同时是防循环的最后一道闸：即使门陷入"收到 denied 就重试"的循环，
 * 同一组参数的拒绝每窗口最多发一次，不会自激。
 */
/** 总线自身的 moduleId。**保留**：驱动不得用这个 id 注册（见 runtime.ts `register`） */
export const BUS_SELF_ID = 'intent.bus';
/**
 * 全部治理主题。
 *
 * **必须导出**：出厂授权给门的是前缀 `bus:`，但 `TOPIC_RE` 要求两段式，
 * 门没法用 `bus:` 一个订阅覆盖全部——它得逐条订阅。不给清单，
 * 门只能靠读总线源码猜有哪些事件，而"猜"在协议层面是不可接受的。
 *
 * 新增事件名 = 兼容变更（订阅方会漏掉新事件，但不会出错）；
 * 改名/删除 = **破坏性**，需与门同版本发布。
 */
export const GOVERNANCE_TOPICS = ['bus:denied', 'bus:pressure', 'bus:revoked', 'bus:closed'];
/** 事件主题名。与 `kind` 一一对应，避免"topic 里写 denied、payload 里写 pressure" */
export function governanceTopic(kind) {
    return `bus:${kind}`;
}
export const GOVERNANCE_DEFAULTS = {
    windowMs: 1000,
    maxPerWindow: 20,
};
/**
 * 限流 + 去重。
 *
 * 窗口是**滑动**的（从首次放行起算），不是固定边界——固定边界会让
 * "刚好跨边界"的突发量翻倍。实现上仍然是简单的窗口起点重置，
 * 因为治理事件量级小（每窗口几十条），滑动精度没有实际收益。
 */
export function createGovernanceThrottle(options = {}) {
    const windowMs = clampInt(options.windowMs, GOVERNANCE_DEFAULTS.windowMs, 1);
    const maxPerWindow = clampInt(options.maxPerWindow, GOVERNANCE_DEFAULTS.maxPerWindow, 1);
    let windowStart = Number.NEGATIVE_INFINITY;
    let emittedInWindow = 0;
    let emitted = 0;
    let suppressed = 0;
    /** 自上次成功发出以来被抑制的条数，随下一条带出 */
    let pendingDropped = 0;
    const seen = new Set();
    return {
        check(kind, dedupeKey, now) {
            // 已知边界：系统时钟回拨（NTP 校正 / 用户改时间）时 `now - windowStart` 为负，
            // 窗口不会重置，治理事件会一直被抑制到时钟追平。
            //
            // 不特殊处理，理由：① 治理事件是观测数据，不是投递路径，抑制不影响业务；
            // ② 抑制会累加进 `suppressed`，并在下一条成功发出时以 `dropped` 带出，
            //    不是静默丢失；③ 加"负值即重置"会让窗口在时钟抖动时被反复清空，
            //    等于关掉限流——那是更坏的失败方向。时钟单调性由部署环境保证。
            if (now - windowStart >= windowMs) {
                windowStart = now;
                emittedInWindow = 0;
                seen.clear();
            }
            const key = `${kind}\u0000${dedupeKey}`;
            if (seen.has(key) || emittedInWindow >= maxPerWindow) {
                suppressed += 1;
                pendingDropped += 1;
                return { allow: false, dropped: 0 };
            }
            seen.add(key);
            emittedInWindow += 1;
            emitted += 1;
            const dropped = pendingDropped;
            pendingDropped = 0;
            return { allow: true, dropped };
        },
        stats() {
            return { emitted, suppressed };
        },
    };
}
function clampInt(value, fallback, min) {
    if (value === undefined || !Number.isFinite(value))
        return fallback;
    return Math.max(min, Math.floor(value));
}
/**
 * 微任务投递队列。
 *
 * 为什么不用 `clock.setTimeout(fn, 0)`：真实环境下 0ms 定时器有最小延迟
 * （嵌套后 4ms），会把"拒绝 → 门知道"的延迟放大到不可预测；而假时钟测试里
 * 又要额外推进时钟才能看到事件，容易写成"测试自己推时钟才过"。
 * 微任务在两种环境下的语义一致，且不需要时钟参与。
 *
 * 代价：同一轮事件循环内的多条事件会合并成一次投递（这是想要的——
 * 拒绝风暴时不该逐条打给门）。
 */
export function createGovernanceDispatcher(sink) {
    let queue = [];
    let scheduled = false;
    let delivered = 0;
    let chain = Promise.resolve();
    function run() {
        scheduled = false;
        const batch = queue;
        queue = [];
        for (const ev of batch) {
            try {
                sink(ev);
                delivered += 1;
            }
            catch {
                // 订阅者抛错不得影响总线，也不得再触发任何治理事件（防环）
            }
        }
    }
    return {
        enqueue(ev) {
            queue.push(ev);
            if (scheduled)
                return;
            scheduled = true;
            chain = chain.then(() => {
                if (queue.length > 0)
                    run();
            }, () => {
                if (queue.length > 0)
                    run();
            });
        },
        drain() {
            chain = chain.then(() => {
                if (queue.length > 0)
                    run();
            }, () => {
                if (queue.length > 0)
                    run();
            });
            return chain;
        },
        discard() {
            queue = [];
        },
        stats() {
            return { queued: queue.length, delivered };
        },
    };
}
