/**
 * Test Harness —— SDK 的核心。
 *
 * 设计约束（逐条对应任务书）：
 *   1. 只通过 `src/index.ts` 的公开导出接入真实总线（见 `bus.ts`）。
 *   2. 不伪造身份：`registerDriver` 如实传 `trust`；测试扮演 loader 时才发
 *      `builtin`，并在报告里标注。默认 `remote`。
 *   3. 不绕过授权：默认用总线真实 `resolveGrants`；需要构造场景时经公开
 *      `grantsFor` 注入显式授权表（与仓库自身测试同一钩子）。
 *   4. 轨迹取 `bus.auditSnapshot()`——总线自己的审计，不是 SDK 编的。
 *   5. 清理幂等：dispose → unregister → close，任何一步失败都不阻断后续。
 */
import { createBus } from './bus.js';
import { EVIDENCE_SCHEMA, SDK_BUS_BASELINE, SDK_VERSION, } from './types.js';
class SkipSignal extends Error {
    constructor(reason) {
        super(reason);
        this.name = 'SkipSignal';
        this.reason = reason;
    }
}
class ContractPendingSignal extends Error {
    constructor(reason) {
        super(reason);
        this.name = 'ContractPendingSignal';
        this.reason = reason;
    }
}
/**
 * 把任意 rejection 值规整成可写进证据的**错误快照**。
 *
 * 总线的 `BusError` 是**纯对象**（`{code, message, detail?, corr?}`，见
 * `intent-bus/src/types.ts`），不是 `Error` 实例。早期实现只做
 * `e instanceof Error ? e.message : String(e)`，导致证据里出现
 * `message: "[object Object]"`——真实文案与 `detail`/`corr` 全部丢失，
 * 错误序列化无法核验。这里按「Error 实例 → 带 message 的对象 → 其它」逐级降级。
 */
function errorSnapshot(e) {
    if (e instanceof Error) {
        const out = {
            message: e.message,
        };
        const code = codeOf(e);
        if (code)
            out.code = code;
        return out;
    }
    if (e && typeof e === 'object') {
        const rec = e;
        const out = {
            message: typeof rec.message === 'string' ? rec.message : String(e),
        };
        if (typeof rec.code === 'string')
            out.code = rec.code;
        if (rec.detail && typeof rec.detail === 'object') {
            out.detail = rec.detail;
        }
        if (typeof rec.corr === 'string')
            out.corr = rec.corr;
        return out;
    }
    return { message: String(e) };
}
function codeOf(e) {
    if (e && typeof e === 'object' && 'code' in e) {
        const code = e.code;
        if (typeof code === 'string')
            return code;
    }
    return undefined;
}
/** JSON 深比较；总线 payload 契约是 JSON 可序列化，故 JSON 等价即可。 */
function jsonEqual(a, b) {
    if (a === b)
        return true;
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    }
    catch {
        return false;
    }
}
function detectEngine(ua) {
    if (/firefox/i.test(ua))
        return 'firefox';
    if (/edg|chrome|chromium/i.test(ua))
        return 'chromium';
    if (/safari/i.test(ua))
        return 'webkit';
    return 'unknown';
}
function environmentInfo(busCommit) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const g = globalThis;
    const commit = busCommit !== null && busCommit !== void 0 ? busCommit : SDK_BUS_BASELINE;
    if ((_b = (_a = g.process) === null || _a === void 0 ? void 0 : _a.versions) === null || _b === void 0 ? void 0 : _b.node) {
        return {
            runtime: 'node',
            runtimeVersion: (_c = g.process.version) !== null && _c !== void 0 ? _c : 'unknown',
            platform: (_d = g.process.platform) !== null && _d !== void 0 ? _d : 'unknown',
            busCommit: commit,
            busSource: 'real',
        };
    }
    const ua = (_f = (_e = g.navigator) === null || _e === void 0 ? void 0 : _e.userAgent) !== null && _f !== void 0 ? _f : 'unknown';
    return {
        runtime: 'browser',
        runtimeVersion: ua,
        platform: (_h = (_g = g.navigator) === null || _g === void 0 ? void 0 : _g.platform) !== null && _h !== void 0 ? _h : 'unknown',
        busCommit: commit,
        busSource: 'real',
        engine: detectEngine(ua),
        userAgent: ua,
    };
}
function summarize(results) {
    const count = (status) => results.filter((r) => r.status === status).length;
    return {
        total: results.length,
        pass: count('pass'),
        fail: count('fail'),
        skip: count('skip'),
        unverified: count('unverified'),
        contractPending: count('contract-pending'),
    };
}
export function createTestHarness(options = {}) {
    var _a, _b;
    const grants = options.grants;
    const useReal = (_a = options.useRealGrantRules) !== null && _a !== void 0 ? _a : grants === undefined;
    if (!useReal && !grants) {
        throw new Error('createTestHarness: `grants` is required when useRealGrantRules is false');
    }
    const table = grants;
    // 公开测试钩子：显式表替代 resolveGrants。仅用于构造场景；
    // 信任边界测试必须用 useRealGrantRules: true 走真实规则。
    const grantsForOption = !useReal && table
        ? {
            grantsFor: (subject) => table.filter((g) => g.subject === subject.id),
        }
        : {};
    const busOptions = {
        // drainMs 调小只为让测试清理快；不改变投递语义（只在 close 排空时用）。
        limits: { drainMs: 150, ...options.limits },
        ...(options.clock ? { clock: options.clock } : {}),
        ...grantsForOption,
    };
    const bus = createBus(busOptions);
    const observerId = (_b = options.observerId) !== null && _b !== void 0 ? _b : 'test.observer';
    const drivers = new Map();
    const faultLog = [];
    const events = [];
    const watched = new Set();
    let observer = null;
    let observerDenied = false;
    let closed = false;
    let nonceSeq = 0;
    let lastSuite = null;
    function registerDriver(spec) {
        var _a, _b, _c;
        const identity = {
            moduleId: spec.moduleId,
            instanceNonce: (_a = spec.instanceNonce) !== null && _a !== void 0 ? _a : `${spec.moduleId}#${++nonceSeq}`,
            trust: (_b = spec.trust) !== null && _b !== void 0 ? _b : 'remote',
            ...(spec.declared ? { declared: spec.declared } : {}),
        };
        const api = bus.register(identity);
        const handlerOffs = new Map();
        const offs = [];
        const handle = {
            id: spec.moduleId,
            trust: identity.trust,
            api,
            label: spec.label,
            spec,
            handlerOffs,
            handle(op, fn) {
                const off = api.handle(op, fn);
                handlerOffs.set(op, off);
                offs.push(off);
                return off;
            },
            replaceHandler(op, fn) {
                const old = handlerOffs.get(op);
                if (old) {
                    old();
                    handlerOffs.delete(op);
                }
                const off = api.handle(op, fn);
                handlerOffs.set(op, off);
                offs.push(off);
            },
            subscribe(topic, fn) {
                const off = api.subscribe(topic, fn);
                offs.push(off);
                return off;
            },
            dispose() {
                for (const off of offs.splice(0)) {
                    try {
                        off();
                    }
                    catch {
                        // 端点已被注销时 off 可能已失效；清理不应因此中断。
                    }
                }
                handlerOffs.clear();
            },
        };
        for (const [op, fn] of Object.entries((_c = spec.handlers) !== null && _c !== void 0 ? _c : {})) {
            handle.handle(op, fn);
        }
        drivers.set(spec.moduleId, handle);
        return handle;
    }
    function ensureObserver(topic) {
        var _a;
        if (options.observer === false)
            return null;
        if (!observer) {
            try {
                registerDriver({ moduleId: observerId, trust: 'remote', label: 'test observer' });
                observer = (_a = drivers.get(observerId)) !== null && _a !== void 0 ? _a : null;
            }
            catch {
                observer = null;
                return null;
            }
        }
        if (!observer)
            return null;
        if (!watched.has(topic)) {
            try {
                observer.subscribe(topic, (ev) => {
                    if (events.length >= 512)
                        events.shift();
                    events.push({ topic: ev.topic, from: ev.from, payload: ev.payload, ts: ev.ts });
                });
                watched.add(topic);
            }
            catch {
                // 真实规则下 remote 观察者没有订阅授权：如实标记，退化为审计元数据。
                observerDenied = true;
            }
        }
        return observer;
    }
    async function injectFault(spec) {
        var _a, _b, _c;
        const at = Date.now();
        const record = (applied, detail) => {
            const r = {
                type: spec.type,
                driver: spec.driver,
                op: spec.op,
                appliedAt: at,
                applied,
                ...(detail ? { detail } : {}),
            };
            faultLog.push(r);
            return r;
        };
        const target = spec.driver ? drivers.get(spec.driver) : undefined;
        if (!target) {
            return record(false, `driver ${(_a = spec.driver) !== null && _a !== void 0 ? _a : '(none)'} is not registered`);
        }
        switch (spec.type) {
            case 'timeout': {
                const op = (_b = spec.op) !== null && _b !== void 0 ? _b : 'default';
                target.replaceHandler(op, () => new Promise(() => { }));
                return record(true, `handler ${op} now hangs; issue the command with a short deadlineMs`);
            }
            case 'handler-error': {
                const op = (_c = spec.op) !== null && _c !== void 0 ? _c : 'default';
                target.replaceHandler(op, () => {
                    throw new Error('injected handler failure');
                });
                return record(true, `handler ${op} now throws BUS_HANDLER_ERROR`);
            }
            case 'peer-gone': {
                bus.unregister(target.id);
                drivers.delete(target.id);
                return record(true, `endpoint ${target.id} unregistered (in-flight commands become BUS_PEER_GONE)`);
            }
            case 'revoke': {
                bus.revoke(target.id);
                return record(true, `endpoint ${target.id} revoked (new sends/receives are BUS_DENIED)`);
            }
            case 'exit-restart': {
                const saved = target.spec;
                bus.unregister(target.id);
                drivers.delete(target.id);
                registerDriver({
                    ...saved,
                    instanceNonce: `${saved.moduleId}#restart-${++nonceSeq}`,
                });
                return record(true, `endpoint ${target.id} restarted with a fresh nonce`);
            }
        }
    }
    async function expectResult(promise, expected, label = 'result') {
        try {
            const actual = await promise;
            if (expected.error) {
                return {
                    kind: 'result-error',
                    status: 'fail',
                    label,
                    expected: { error: expected.error },
                    actual,
                    detail: 'expected rejection but the command resolved',
                };
            }
            if ('value' in expected && !jsonEqual(actual, expected.value)) {
                return {
                    kind: 'result-value',
                    status: 'fail',
                    label,
                    expected: expected.value,
                    actual,
                };
            }
            return {
                kind: 'result-value',
                status: 'pass',
                label,
                expected: expected.value,
                actual,
            };
        }
        catch (e) {
            const actual = errorSnapshot(e);
            if (expected.error) {
                if (actual.code === expected.error) {
                    return {
                        kind: 'result-error',
                        status: 'pass',
                        label,
                        expected: { error: expected.error },
                        actual,
                    };
                }
                return {
                    kind: 'result-error',
                    status: 'fail',
                    label,
                    expected: { error: expected.error },
                    actual,
                    detail: 'rejected with a different error code',
                };
            }
            return {
                kind: 'result-error',
                status: 'fail',
                label,
                expected: expected.value,
                actual,
                detail: 'unexpected rejection',
            };
        }
    }
    async function expectEvent(topic, opts = {}, label = 'event') {
        var _a;
        const timeoutMs = (_a = opts.timeoutMs) !== null && _a !== void 0 ? _a : 800;
        const matches = (e) => e.topic === topic &&
            (!opts.from || e.from === opts.from) &&
            (!opts.payload || opts.payload(e.payload));
        const buffered = events.find(matches);
        if (buffered) {
            return {
                kind: 'event',
                status: 'pass',
                label,
                expected: { topic, from: opts.from },
                actual: { topic: buffered.topic, from: buffered.from, payload: buffered.payload },
            };
        }
        // 订阅发生在首次 await 之前，因此 `expectEvent(...)` 不 await 先发起、
        // 再触发动作的写法是可靠的。
        const obs = ensureObserver(topic);
        if (!obs || observerDenied) {
            const audit = bus
                .auditSnapshot(500)
                .find((r) => r.kind === 'event' &&
                r.topic === topic &&
                (!opts.from || r.subject === opts.from));
            if (!audit) {
                return {
                    kind: 'event',
                    status: 'unverified',
                    label,
                    expected: { topic },
                    actual: null,
                    detail: 'no subscribe grant for the observer and no matching audit event',
                };
            }
            if (opts.payload) {
                return {
                    kind: 'event',
                    status: 'unverified',
                    label,
                    expected: { topic },
                    actual: { topic: audit.topic, from: audit.subject },
                    detail: 'audit records metadata only; payload predicate needs a subscribe grant',
                };
            }
            return {
                kind: 'event',
                status: 'pass',
                label,
                expected: { topic, from: opts.from },
                actual: { topic: audit.topic, from: audit.subject },
                detail: 'observed via audit metadata',
            };
        }
        return await new Promise((resolve) => {
            const started = Date.now();
            const timer = setInterval(() => {
                const hit = events.find(matches);
                if (hit) {
                    clearInterval(timer);
                    resolve({
                        kind: 'event',
                        status: 'pass',
                        label,
                        expected: { topic, from: opts.from },
                        actual: { topic: hit.topic, from: hit.from, payload: hit.payload },
                    });
                    return;
                }
                if (Date.now() - started >= timeoutMs) {
                    clearInterval(timer);
                    resolve({
                        kind: 'event',
                        status: 'fail',
                        label,
                        expected: { topic, from: opts.from },
                        actual: null,
                        detail: `no matching event within ${timeoutMs}ms`,
                    });
                }
            }, 10);
        });
    }
    function trace(limit = 200) {
        return bus.auditSnapshot(limit).map((r) => ({
            seq: r.seq,
            kind: r.kind,
            result: r.result,
            at: r.at,
            subject: r.subject,
            target: r.target,
            op: r.op,
            topic: r.topic,
            corr: r.corr,
            detail: r.detail,
        }));
    }
    function captureEvidence(suite = null) {
        return {
            schema: EVIDENCE_SCHEMA,
            sdkVersion: SDK_VERSION,
            generatedAt: new Date().toISOString(),
            environment: environmentInfo(options.busCommit),
            suite: suite !== null && suite !== void 0 ? suite : lastSuite,
            trace: trace(500),
            faults: [...faultLog],
            busStats: bus.stats(),
        };
    }
    async function cleanup() {
        if (closed)
            return;
        closed = true;
        for (const d of drivers.values())
            d.dispose();
        for (const id of [...drivers.keys()]) {
            try {
                bus.unregister(id);
            }
            catch {
                // 已注销 / 已撤销：清理继续。
            }
        }
        drivers.clear();
        observer = null;
        watched.clear();
        try {
            await bus.close();
        }
        catch {
            // close 对已关闭总线幂等；异常不应阻断清理。
        }
    }
    const harness = {
        bus,
        options,
        observerId,
        registerDriver,
        driver(id) {
            const d = drivers.get(id);
            if (!d)
                throw new Error(`driver ${id} is not registered`);
            return d;
        },
        drivers() {
            return [...drivers.values()];
        },
        defineScenario(name, fn, meta = {}) {
            if (!name.trim())
                throw new Error('defineScenario: name is required');
            return {
                name,
                fn,
                ...(meta.tags ? { tags: meta.tags } : {}),
                ...(meta.skip !== undefined ? { skip: meta.skip } : {}),
                ...(meta.contractPending ? { contractPending: meta.contractPending } : {}),
                ...(meta.options ? { options: meta.options } : {}),
            };
        },
        injectFault,
        expectResult,
        expectEvent,
        watch(topic) {
            ensureObserver(topic);
        },
        trace,
        faults() {
            return [...faultLog];
        },
        captureEvidence,
        async runSuite(scenarios, opts) {
            const report = await runSuite(scenarios, options, opts);
            lastSuite = report;
            return report;
        },
        cleanup,
    };
    return harness;
}
/**
 * 执行测试集。
 *
 * 隔离策略：每条场景一个**全新 harness / 全新总线**，避免场景间通过
 * 残留订阅、限流窗口或端点状态互相污染。代价是每条场景重建总线，可接受。
 */
export async function runSuite(scenarios, options = {}, runOpts = {}) {
    var _a;
    const results = [];
    for (const scenario of scenarios) {
        const started = Date.now();
        if (scenario.skip) {
            results.push({
                name: scenario.name,
                status: 'skip',
                durationMs: 0,
                steps: [],
                assertions: [],
                trace: [],
                reason: typeof scenario.skip === 'string' ? scenario.skip : 'skipped by declaration',
            });
            continue;
        }
        if (scenario.contractPending) {
            results.push({
                name: scenario.name,
                status: 'contract-pending',
                durationMs: 0,
                steps: [],
                assertions: [],
                trace: [],
                reason: scenario.contractPending,
            });
            continue;
        }
        const child = createTestHarness({ ...options, ...((_a = scenario.options) !== null && _a !== void 0 ? _a : {}) });
        const assertions = [];
        const steps = [];
        let status = 'pass';
        let error;
        let reason;
        const ctx = {
            harness: child,
            bus: child.bus,
            driver: (id) => child.driver(id),
            async step(name, fn) {
                const at = Date.now();
                try {
                    await fn();
                    steps.push({ name, at, ok: true });
                }
                catch (e) {
                    steps.push({ name, at, ok: false, detail: errorSnapshot(e).message });
                    throw e;
                }
            },
            async expectResult(promise, expected, label) {
                const r = await child.expectResult(promise, expected, label);
                assertions.push(r);
                return r;
            },
            async expectEvent(topic, opts, label) {
                const r = await child.expectEvent(topic, opts, label);
                assertions.push(r);
                return r;
            },
            skip(r) {
                throw new SkipSignal(r);
            },
            contractPending(r) {
                throw new ContractPendingSignal(r);
            },
        };
        try {
            await scenario.fn(ctx);
            if (assertions.some((a) => a.status === 'fail')) {
                status = 'fail';
            }
            else if (assertions.some((a) => a.status === 'unverified')) {
                status = 'unverified';
            }
            else if (assertions.length === 0 && steps.length === 0) {
                status = 'unverified';
                reason = 'scenario produced no assertions or steps';
            }
        }
        catch (e) {
            if (e instanceof SkipSignal) {
                status = 'skip';
                reason = e.reason;
            }
            else if (e instanceof ContractPendingSignal) {
                status = 'contract-pending';
                reason = e.reason;
            }
            else {
                status = 'fail';
                error = errorSnapshot(e);
            }
        }
        const scenarioTrace = child.trace(200);
        await child.cleanup();
        results.push({
            name: scenario.name,
            status,
            durationMs: Date.now() - started,
            steps,
            assertions,
            trace: scenarioTrace,
            ...(error ? { error } : {}),
            ...(reason ? { reason } : {}),
        });
        if (runOpts.stopOnFail && status === 'fail')
            break;
    }
    return {
        schema: EVIDENCE_SCHEMA,
        sdkVersion: SDK_VERSION,
        generatedAt: new Date().toISOString(),
        environment: environmentInfo(options.busCommit),
        scenarios: results,
        summary: summarize(results),
    };
}
/** 便于测试/报告复用：把 `TestGrant` 表转成公开钩子可用的过滤函数。 */
export function grantsFor(grants) {
    return (subject) => grants.filter((g) => g.subject === subject.id);
}
