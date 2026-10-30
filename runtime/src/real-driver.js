/**
 * 真实驱动适配层 —— 把「锻造器交付的驱动包」装进「冻结版总线」。
 *
 * 三条不可越的线：
 *   1. **不改驱动**：适配层只提供 `ctx`，不 patch、不 monkey-patch 驱动的导出，
 *      也不替驱动发任何业务消息。驱动产物字节由 `INTAKE.json` 的内容指纹锁定。
 *   2. **不绕授权**：`ctx.bus` 就是 `bus.register()` 返回的那个 `BusApi`，
 *      身份由适配层签发（`trust` 缺省 `'remote'`，如实标注；只有复现"已部署为内置"
 *      这一事实时才显式传 `builtin`，并与产物部署位交叉核对），授权一律走总线自己的
 *      `resolveGrants`；只有显式构造场景时才用总线的公开测试钩子 `grantsFor`，
 *      并在证据里标注「构造」。
 *   3. **不替代生产接入**：适配层复刻 `web/src/loader` 的装载/销毁**顺序**，
 *      但它不是 loader。它证明的是「这份驱动字节 + 这个总线版本 + 这条装载顺序
 *      能跑到什么程度」，不证明母体生产装配已接通。
 *
 * 装载顺序（对齐 `web/src/loader/loader.ts`）：
 *   register(endpoint) → makeCtx(bus=api) → mount(ctx)
 * 销毁顺序（对齐 `destroy()`）：
 *   revoke → drain → disposers → unmount → unregister
 */
import { createBus } from './bus.js';
import { SDK_VERSION } from './types.js';
const BUS_METHODS = ['command', 'publish', 'subscribe', 'handle', 'cancel'];
function nowIso() {
    return new Date().toISOString();
}
function errorText(e) {
    if (e instanceof Error)
        return `${e.name}: ${e.message}`;
    if (e && typeof e === 'object' && 'code' in e) {
        const rec = e;
        return `${String(rec.code)}: ${String(rec.message)}`;
    }
    return String(e);
}
/**
 * 装载一份真实驱动包。
 *
 * 抛错即代表装载失败（包损坏 / 导出缺失 / mount 抛错）；失败也会先把端点注销，
 * 避免留下半个端点。
 */
export async function loadRealDriver(options) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
    const { bus, pkg } = options;
    const manifest = pkg.manifest;
    const startedAt = nowIso();
    const t0 = Date.now();
    const logs = [];
    const disposers = [];
    const log = (msg) => {
        var _a;
        logs.push(msg);
        try {
            (_a = options.log) === null || _a === void 0 ? void 0 : _a.call(options, msg);
        }
        catch {
            // 观测失败不影响被测对象
        }
    };
    const instanceNonce = (_a = options.instanceNonce) !== null && _a !== void 0 ? _a : `${manifest.id}#${t0.toString(36)}`;
    const identity = {
        moduleId: manifest.id,
        instanceNonce,
        trust: (_b = options.trust) !== null && _b !== void 0 ? _b : 'remote',
        ...(((_c = options.declared) !== null && _c !== void 0 ? _c : manifest.bus) ? { declared: (_d = options.declared) !== null && _d !== void 0 ? _d : manifest.bus } : {}),
    };
    // 1) 端点登记先于 ctx：ctx.bus 必须绑定本次实例的身份闭包（同 loader）
    const api = bus.register(identity);
    // 透明计数代理：只数调用，不改语义、不改返回、不改身份。
    const busCalls = { command: 0, publish: 0, subscribe: 0, handle: 0, cancel: 0 };
    const instrument = options.instrument !== false;
    const ctxBus = instrument
        ? new Proxy(api, {
            get(target, prop, receiver) {
                const value = Reflect.get(target, prop, receiver);
                if (typeof value === 'function' && BUS_METHODS.includes(String(prop))) {
                    return (...args) => {
                        var _a;
                        busCalls[String(prop)] = ((_a = busCalls[String(prop)]) !== null && _a !== void 0 ? _a : 0) + 1;
                        return value.apply(target, args);
                    };
                }
                return value;
            },
        })
        : api;
    const ctx = {
        id: manifest.id,
        bus: ctxBus,
        log,
        kv: (_f = (_e = options.host) === null || _e === void 0 ? void 0 : _e.kv) !== null && _f !== void 0 ? _f : null,
        http: (_h = (_g = options.host) === null || _g === void 0 ? void 0 : _g.http) !== null && _h !== void 0 ? _h : null,
        onDispose(fn) {
            if (typeof fn !== 'function')
                return () => { };
            const entry = { fn, ran: false };
            disposers.push(entry);
            return () => {
                const i = disposers.indexOf(entry);
                if (i >= 0)
                    disposers.splice(i, 1);
            };
        },
        hostVersion: (_l = (_k = (_j = options.host) === null || _j === void 0 ? void 0 : _j.hostVersion) !== null && _k !== void 0 ? _k : manifest.min_host) !== null && _l !== void 0 ? _l : null,
        ...(((_m = options.host) === null || _m === void 0 ? void 0 : _m.form) ? { form: options.host.form } : {}),
        ...(((_o = options.host) === null || _o === void 0 ? void 0 : _o.slots) ? { slots: options.host.slots } : {}),
    };
    let mod;
    try {
        mod = await options.importModule({ href: pkg.source, source: undefined, filename: pkg.entryPath });
    }
    catch (e) {
        bus.unregister(manifest.id);
        throw new Error(`驱动模块装载失败（${pkg.entryPath}）：${errorText(e)}`);
    }
    const exports = Object.keys(mod).sort();
    if (typeof mod.mount !== 'function') {
        bus.unregister(manifest.id);
        throw new Error(`驱动缺少 mount 导出（实际导出：${exports.join(',') || '(空)'}）`);
    }
    const record = {
        moduleId: manifest.id,
        version: manifest.version,
        instanceNonce,
        entrySha256: pkg.entrySha256,
        startedAt,
        mountedAt: null,
        mountMs: null,
        exports,
        ctxKeys: Object.keys(ctx).sort(),
        describe: null,
        busCalls,
        logs,
        registered: true,
    };
    const describeFn = mod.describe;
    const unmountFn = mod.unmount;
    const handleDescribe = () => {
        if (typeof describeFn !== 'function')
            return null;
        try {
            return describeFn();
        }
        catch (e) {
            log(`describe() 抛错：${errorText(e)}`);
            return null;
        }
    };
    try {
        await mod.mount(ctx);
    }
    catch (e) {
        // 装载失败不得留半个端点：清 disposer + 注销，再把错误抛给调用方
        for (const d of disposers.splice(0)) {
            try {
                d.fn();
                d.ran = true;
            }
            catch {
                /* 清理阶段的异常不覆盖原始装载错误 */
            }
        }
        bus.unregister(manifest.id);
        throw new Error(`驱动 mount 失败：${errorText(e)}`);
    }
    const mountedAt = nowIso();
    const mutableRecord = record;
    mutableRecord.mountedAt = mountedAt;
    mutableRecord.mountMs = Date.now() - t0;
    mutableRecord.describe = handleDescribe();
    let teardown = null;
    async function unload() {
        var _a;
        if (teardown)
            return teardown;
        const tStart = nowIso();
        const endpointsBefore = bus.stats().endpoints;
        const inflightBeforeRevoke = bus.stats().inflight;
        // ① 撤权先于排空（STOPPING 起驱动不该再发起新命令）
        bus.revoke(manifest.id);
        const revokedAt = nowIso();
        // ② 排空：等存量调用结束，超时如实记录（超时不等于已取消）
        const drainMs = (_a = options.drainMs) !== null && _a !== void 0 ? _a : 500;
        const drainStart = Date.now();
        let inflight = bus.stats().inflight;
        const inflightAtDrain = inflight;
        while (inflight > 0 && Date.now() - drainStart < drainMs) {
            await new Promise((r) => setTimeout(r, 10));
            inflight = bus.stats().inflight;
        }
        const drainedMs = Date.now() - drainStart;
        const drainTimedOut = inflight > 0;
        // ③ disposer（驱动经 ctx.onDispose 登记的清理）
        const disposerErrors = [];
        for (const d of disposers.splice(0)) {
            try {
                d.fn();
                d.ran = true;
            }
            catch (e) {
                disposerErrors.push(errorText(e));
            }
        }
        // ④ 模块自身的 unmount（幂等；未 mount 过是 no-op）
        let unmountError;
        if (typeof unmountFn === 'function') {
            try {
                await unmountFn();
            }
            catch (e) {
                unmountError = errorText(e);
            }
        }
        // ⑤ 注销端点：清订阅、清队列，在飞命令按 PEER_GONE 收尾
        bus.unregister(manifest.id);
        const unregisteredAt = nowIso();
        const stats = bus.stats();
        teardown = {
            startedAt: tStart,
            revokedAt,
            drainedMs,
            inflightBeforeRevoke,
            inflightAtDrain,
            drainTimedOut,
            disposerErrors,
            ...(unmountError ? { unmountError } : {}),
            unregisteredAt,
            endpointsBefore,
            endpointsAfter: stats.endpoints,
            pendingTimersAfter: stats.pendingTimers,
            inflightAfter: stats.inflight,
            queuedAfter: stats.queued,
            describeAfter: handleDescribe(),
        };
        return teardown;
    }
    return {
        moduleId: manifest.id,
        version: manifest.version,
        instanceNonce,
        api,
        ctx,
        record,
        describe: handleDescribe,
        unload,
        get teardown() {
            return teardown;
        },
    };
}
export function createPeer(bus, id, nonce) {
    const api = bus.register({ moduleId: id, instanceNonce: nonce !== null && nonce !== void 0 ? nonce : `${id}#${Date.now().toString(36)}`, trust: 'remote' });
    const offs = [];
    return {
        id,
        api,
        handle(op, fn) {
            const off = api.handle(op, fn);
            offs.push(off);
            return off;
        },
        subscribe(topic, fn) {
            const off = api.subscribe(topic, fn);
            offs.push(off);
            return off;
        },
        unregister() {
            for (const off of offs.splice(0)) {
                try {
                    off();
                }
                catch {
                    /* 端点已注销时 off 可能失效 */
                }
            }
            bus.unregister(id);
        },
    };
}
class SkipSignal extends Error {
    constructor(reason) {
        super(reason);
        this.reason = reason;
    }
}
class ContractPendingSignal extends Error {
    constructor(reason) {
        super(reason);
        this.reason = reason;
    }
}
function detectEngine(ua) {
    if (/firefox/i.test(ua))
        return 'firefox';
    if (/edg|chrome|chromium/i.test(ua))
        return 'chromium';
    if (/safari/i.test(ua))
        return 'webkit';
    return undefined;
}
export function realDriverEnvironment(busCommit, trust = 'remote') {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const g = globalThis;
    if ((_b = (_a = g.process) === null || _a === void 0 ? void 0 : _a.versions) === null || _b === void 0 ? void 0 : _b.node) {
        return {
            runtime: 'node',
            runtimeVersion: (_c = g.process.version) !== null && _c !== void 0 ? _c : 'unknown',
            platform: (_d = g.process.platform) !== null && _d !== void 0 ? _d : 'unknown',
            busCommit,
            busSource: 'real',
            sdkVersion: SDK_VERSION,
            trust,
        };
    }
    const ua = (_f = (_e = g.navigator) === null || _e === void 0 ? void 0 : _e.userAgent) !== null && _f !== void 0 ? _f : 'unknown';
    const engine = detectEngine(ua);
    return {
        runtime: 'browser',
        runtimeVersion: ua,
        platform: (_h = (_g = g.navigator) === null || _g === void 0 ? void 0 : _g.platform) !== null && _h !== void 0 ? _h : 'unknown',
        ...(engine ? { engine } : {}),
        userAgent: ua,
        busCommit,
        busSource: 'real',
        sdkVersion: SDK_VERSION,
        trust,
    };
}
/** 执行一组真实驱动场景。每个场景独立总线实例，互不污染。 */
export async function runRealDriverSuite(scenarios, options) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
    const results = [];
    const allTrace = [];
    let lastStats = { endpoints: 0, inflight: 0, queued: 0, pendingTimers: 0 };
    for (const scenario of scenarios) {
        const started = Date.now();
        const assertions = [];
        const notes = [];
        let loadRecord = null;
        let teardownRecord = null;
        /**
         * 场景内最后一次装载的句柄。场景结束时**强制卸载**——
         * 生产 loader 的 destroy() 一定会卸载；适配层若不卸载，驱动模块是单例，
         * 下一个场景的 mount 会被驱动自己判为"已装载"而 no-op，
         * 于是 describe()/busCalls 读到的是**上一个场景的实例**（证据污染）。
         * 这个坑在驱动 0 次调用总线的年代不会显形，接上业务路径后立刻暴露。
         */
        let lastHandle = null;
        let driverId = null;
        let driverVersion = null;
        if (scenario.skip !== undefined && scenario.skip !== false) {
            results.push({
                name: scenario.name,
                status: 'skip',
                constructed: Boolean(scenario.constructed),
                durationMs: 0,
                assertions: [],
                trace: [],
                notes: [],
                driver: { moduleId: null, version: null, entrySha256: null, load: null, teardown: null },
                reason: typeof scenario.skip === 'string' ? scenario.skip : 'skipped',
            });
            continue;
        }
        if (scenario.contractPending) {
            results.push({
                name: scenario.name,
                status: 'contract-pending',
                constructed: Boolean(scenario.constructed),
                durationMs: 0,
                assertions: [],
                trace: [],
                notes: [],
                driver: { moduleId: null, version: null, entrySha256: null, load: null, teardown: null },
                reason: scenario.contractPending,
            });
            continue;
        }
        const grants = scenario.constructed && !options.strict ? options.grants : undefined;
        const busOptions = {
            limits: { drainMs: 120, ...options.limits },
            ...(grants
                ? {
                    // 构造场景：用总线自己的公开测试钩子替换授权表。生产不该注入。
                    grantsFor: (subject) => grants.filter((g) => g.subject === subject.id),
                }
                : {}),
        };
        const bus = createBus(busOptions);
        const peers = [];
        let unverifiedReason = null;
        let status = 'pass';
        let failure;
        let reason;
        const ctx = {
            bus,
            pkg: options.pkg,
            async load(over = {}) {
                const handle = await loadRealDriver({
                    bus,
                    pkg: options.pkg,
                    importModule: options.importModule,
                    ...(options.host ? { host: options.host } : {}),
                    ...(options.trust ? { trust: options.trust } : {}),
                    ...over,
                });
                loadRecord = handle.record;
                lastHandle = handle;
                driverId = handle.moduleId;
                driverVersion = handle.version;
                // 捕获卸载结论：场景内调用 unload() 后，证据里要能看到排空/清理/残留
                return {
                    moduleId: handle.moduleId,
                    version: handle.version,
                    instanceNonce: handle.instanceNonce,
                    api: handle.api,
                    ctx: handle.ctx,
                    record: handle.record,
                    describe: () => handle.describe(),
                    async unload() {
                        const result = await handle.unload();
                        teardownRecord = result;
                        return result;
                    },
                    get teardown() {
                        return handle.teardown;
                    },
                };
            },
            peer(id, over = {}) {
                const p = createPeer(bus, id, over.nonce);
                peers.push(p);
                return p;
            },
            assert(label, ok, detail, expected, actual) {
                assertions.push({
                    kind: 'custom',
                    status: ok ? 'pass' : 'fail',
                    label,
                    ...(detail ? { detail } : {}),
                    ...(expected !== undefined ? { expected } : {}),
                    ...(actual !== undefined ? { actual } : {}),
                });
            },
            async expectCode(promise, code, label) {
                try {
                    const value = await promise;
                    assertions.push({
                        kind: 'result-error',
                        status: 'fail',
                        label,
                        expected: { error: code },
                        actual: value,
                        detail: '期望被拒绝，但调用成功返回',
                    });
                    return value;
                }
                catch (e) {
                    const actual = e && typeof e === 'object' ? e : { message: String(e) };
                    const ok = actual.code === code;
                    assertions.push({
                        kind: 'result-error',
                        status: ok ? 'pass' : 'fail',
                        label,
                        expected: { error: code },
                        actual,
                        ...(ok ? {} : { detail: '错误码与预期不符' }),
                    });
                    return undefined;
                }
            },
            sleep(ms) {
                return new Promise((r) => setTimeout(r, ms));
            },
            note(msg) {
                notes.push(msg);
            },
            trace(limit = 200) {
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
            },
            skip(r) {
                throw new SkipSignal(r);
            },
            contractPending(r) {
                throw new ContractPendingSignal(r);
            },
            unverified(r) {
                unverifiedReason = r;
            },
        };
        try {
            if (!scenario.fn)
                throw new ContractPendingSignal('场景未提供执行体');
            await scenario.fn(ctx);
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
                failure = {
                    message: errorText(e),
                    ...(e && typeof e === 'object' && 'code' in e ? { code: String(e.code) } : {}),
                };
            }
        }
        if (status === 'pass') {
            if (assertions.some((a) => a.status === 'fail'))
                status = 'fail';
            else if (assertions.some((a) => a.status === 'unverified'))
                status = 'unverified';
            else if (unverifiedReason)
                status = 'unverified';
            else if (assertions.length === 0) {
                status = 'unverified';
                reason = '场景未产生任何断言：执行了，但不足以证明结论';
            }
        }
        const trace = ctx.trace(500);
        allTrace.push(...trace);
        lastStats = {
            endpoints: bus.stats().endpoints,
            inflight: bus.stats().inflight,
            queued: bus.stats().queued,
            pendingTimers: bus.stats().pendingTimers,
        };
        // 场景收尾：按生产 destroy 的顺序先卸载驱动，再注销对端，最后关总线。
        // 卸载是幂等的（D2 已证），场景自己卸过也不会重复清理。
        if (lastHandle) {
            try {
                const r = await lastHandle.unload();
                if (!teardownRecord)
                    teardownRecord = r;
            }
            catch (e) {
                // 卸载失败要留痕，但不能覆盖场景本身的结论
                notes.push(`场景收尾卸载失败：${errorText(e)}`);
            }
        }
        for (const p of peers) {
            try {
                p.unregister();
            }
            catch {
                /* 清理不应阻断 */
            }
        }
        try {
            await bus.close();
        }
        catch {
            /* close 幂等 */
        }
        // 抓取场景内最后一次卸载记录（若有）
        results.push({
            name: scenario.name,
            status,
            constructed: Boolean(scenario.constructed),
            durationMs: Date.now() - started,
            assertions,
            trace,
            notes,
            driver: {
                moduleId: driverId,
                version: driverVersion,
                entrySha256: driverId ? options.pkg.entrySha256 : null,
                load: loadRecord,
                teardown: teardownRecord,
            },
            ...(failure ? { error: failure } : {}),
            ...(reason ? { reason } : {}),
        });
    }
    const count = (s) => results.filter((r) => r.status === s).length;
    const manifest = options.pkg.manifest;
    // 驱动侧调用累加：只来自驱动拿到的 ctx.bus 代理，测试侧走 handle.api 不计入
    const driverBusCalls = { command: 0, publish: 0, subscribe: 0, handle: 0, cancel: 0 };
    for (const r of results) {
        const calls = ((_b = (_a = r.driver.load) === null || _a === void 0 ? void 0 : _a.busCalls) !== null && _b !== void 0 ? _b : {});
        for (const [k, v] of Object.entries(calls))
            driverBusCalls[k] = ((_c = driverBusCalls[k]) !== null && _c !== void 0 ? _c : 0) + Number(v || 0);
    }
    return {
        schema: 'intent-bus-test-real-driver-evidence/v1',
        generatedAt: nowIso(),
        mode: (_d = options.mode) !== null && _d !== void 0 ? _d : 'automated',
        label: (_e = options.label) !== null && _e !== void 0 ? _e : 'real-driver',
        environment: realDriverEnvironment(options.busCommit, (_f = options.trust) !== null && _f !== void 0 ? _f : 'remote'),
        driver: {
            id: manifest.id,
            version: manifest.version,
            entryPath: options.pkg.entryPath,
            entrySha256: options.pkg.entrySha256,
            contentHash: (_g = options.pkg.contentHash) !== null && _g !== void 0 ? _g : null,
            bytes: (_h = options.pkg.bytes) !== null && _h !== void 0 ? _h : null,
            source: options.pkg.source,
            capabilities: (_j = manifest.capabilities) !== null && _j !== void 0 ? _j : [],
            deps: (_k = manifest.deps) !== null && _k !== void 0 ? _k : {},
            slots: (_l = manifest.slots) !== null && _l !== void 0 ? _l : [],
            minHost: (_m = manifest.min_host) !== null && _m !== void 0 ? _m : null,
            busDeclaration: (_o = manifest.bus) !== null && _o !== void 0 ? _o : null,
        },
        scenarios: results,
        summary: {
            total: results.length,
            pass: count('pass'),
            fail: count('fail'),
            skip: count('skip'),
            unverified: count('unverified'),
            contractPending: count('contract-pending'),
        },
        trace: allTrace,
        driverBusCalls,
        busStats: lastStats,
        faults: [],
    };
}
/** 供场景读取卸载结论：卸载后再次调用 `describe()` 必须为 null。 */
export function assertCleanTeardown(ctx, teardown, label = '卸载') {
    var _a;
    ctx.assert(`${label}：disposer 无异常`, teardown.disposerErrors.length === 0, teardown.disposerErrors.join('; '));
    ctx.assert(`${label}：unmount 无异常`, !teardown.unmountError, (_a = teardown.unmountError) !== null && _a !== void 0 ? _a : 'ok');
    ctx.assert(`${label}：端点已注销`, teardown.endpointsAfter < teardown.endpointsBefore, `before=${teardown.endpointsBefore} after=${teardown.endpointsAfter}`);
    ctx.assert(`${label}：无在飞命令`, teardown.inflightAfter === 0, `inflight=${teardown.inflightAfter}`);
    ctx.assert(`${label}：无待执行队列`, teardown.queuedAfter === 0, `queued=${teardown.queuedAfter}`);
    ctx.assert(`${label}：无残留定时器`, teardown.pendingTimersAfter === 0, `timers=${teardown.pendingTimersAfter}`);
    ctx.assert(`${label}：驱动自述已清空`, teardown.describeAfter === null, JSON.stringify(teardown.describeAfter));
}
