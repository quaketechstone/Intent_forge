/**
 * 共享测试场景集（A 基础 / B 权限与生命周期 / C 故障与恢复）。
 *
 * 同一份场景被三处消费：
 *   - `tests/sdk.test.ts`（node:test，逐条报告）
 *   - `tests/run.mjs`（生成证据 JSON/Markdown）
 *   - `lab/lab.ts`（浏览器人机执行）
 *
 * 任何场景都只经公开 API 操作真实总线；不 mock 总线、不碰内部状态。
 */
import { defineScenario, FaultInjector } from '../src/index.js';
import { basicGrants, pubGrant, unauthorizedGrants } from './samples.js';
import { mockDriver, roomCreateHandler } from './mock-driver.js';
// ---------------------------------------------------------------------------
// A. 基础交互
// ---------------------------------------------------------------------------
const A1 = defineScenario('A1 注册 / 就绪 / 请求-响应 / 关闭', async (ctx) => {
    const a = ctx.harness.registerDriver(mockDriver('site.a'));
    ctx.harness.registerDriver(mockDriver('site.b', { handlers: { 'room.create': roomCreateHandler } }));
    await ctx.step('注册后总线 READY', () => {
        if (ctx.bus.state !== 'READY')
            throw new Error(`state=${ctx.bus.state}`);
    });
    await ctx.expectResult(a.api.command('site.b', 'room.create', { name: 'demo' }), { value: { id: 'room-1', echo: { name: 'demo' } } }, '请求-响应');
    await ctx.step('关闭后 CLOSED', async () => {
        await ctx.bus.close();
        if (ctx.bus.state !== 'CLOSED')
            throw new Error(`state=${ctx.bus.state}`);
    });
}, { tags: ['A', 'lifecycle'] });
const A2 = defineScenario('A2 消息格式 / 参数校验 / 错误返回', async (ctx) => {
    const a = ctx.harness.registerDriver(mockDriver('site.a'));
    ctx.harness.registerDriver(mockDriver('site.b', { handlers: { 'room.create': roomCreateHandler } }));
    await ctx.expectResult(a.api.command('site.b', ''), { error: 'BUS_MALFORMED' }, '空 op → BUS_MALFORMED');
    await ctx.expectResult(a.api.command('site.b', 'not an op'), { error: 'BUS_MALFORMED' }, '非法 op → BUS_MALFORMED');
    await ctx.expectResult(a.api.command('site.b', 'room.create', { big: 'x'.repeat(70 * 1024) }), { error: 'BUS_PAYLOAD_TOO_LARGE' }, '超大 payload → BUS_PAYLOAD_TOO_LARGE');
    await ctx.step('非法主题 publish 抛 BUS_MALFORMED', () => {
        try {
            a.api.publish('', 1);
            throw new Error('expected publish to throw');
        }
        catch (e) {
            const code = e.code;
            if (code !== 'BUS_MALFORMED')
                throw e;
        }
    });
}, { tags: ['A', 'validation'] });
const A3 = defineScenario('A3 多驱动并发交互与轨迹可追踪', async (ctx) => {
    const a = ctx.harness.registerDriver(mockDriver('site.a'));
    ctx.harness.registerDriver(mockDriver('site.b', { handlers: { 'room.create': roomCreateHandler } }));
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => a.api.command('site.b', 'room.create', { i })));
    await ctx.expectResult(Promise.resolve(results.length), { value: 5 }, '5 条并发全部解析');
    const oneToOne = results.every((r, i) => r.echo.i === i);
    await ctx.expectResult(Promise.resolve(oneToOne), { value: true }, '结果与请求一一对应');
    const trace = ctx.harness.trace(200);
    const commands = trace.filter((t) => t.kind === 'command' &&
        t.subject === 'site.a' &&
        t.target === 'site.b' &&
        t.op === 'room.create');
    await ctx.expectResult(Promise.resolve(commands.length), { value: 5 }, '轨迹记录 5 条 command');
    const corrs = new Set(commands.map((c) => c.corr));
    await ctx.expectResult(Promise.resolve(corrs.size), { value: 5 }, '每条命令有独立 corr');
}, { tags: ['A', 'trace'] });
const A4 = defineScenario('A4 事件发布与订阅（真实总线）', async (ctx) => {
    const a = ctx.harness.registerDriver(mockDriver('site.a'));
    ctx.harness.watch('room:created');
    // 先发起（同步完成订阅），再触发；随后 await 断言。
    const ev = ctx.expectEvent('room:created', { from: 'site.a', payload: (p) => (p === null || p === void 0 ? void 0 : p.n) === 7 }, '事件载荷');
    a.api.publish('room:created', { n: 7 });
    await ev;
}, { tags: ['A', 'event'] });
const A5 = defineScenario('A5 证据采集（环境 / 轨迹 / 汇总）', async (ctx) => {
    const a = ctx.harness.registerDriver(mockDriver('site.a'));
    ctx.harness.registerDriver(mockDriver('site.b', { handlers: { 'room.create': roomCreateHandler } }));
    await a.api.command('site.b', 'room.create', { n: 1 });
    const evidence = ctx.harness.captureEvidence();
    await ctx.expectResult(Promise.resolve(evidence.schema), { value: 'intent-bus-test-evidence/v1' }, '证据 schema');
    await ctx.expectResult(Promise.resolve(evidence.environment.busSource), { value: 'real' }, 'busSource=real');
    await ctx.expectResult(Promise.resolve(evidence.trace.some((t) => t.kind === 'command')), { value: true }, '证据含真实审计轨迹');
    await ctx.expectResult(Promise.resolve(evidence.busStats.state), { value: 'READY' }, '证据含总线状态');
}, { tags: ['A', 'evidence'] });
// ---------------------------------------------------------------------------
// B. 权限与生命周期
// ---------------------------------------------------------------------------
const B1 = defineScenario('B1 未授权请求被拒绝', async (ctx) => {
    const a = ctx.harness.registerDriver(mockDriver('site.a'));
    ctx.harness.registerDriver(mockDriver('site.b', { handlers: { 'room.create': roomCreateHandler } }));
    await ctx.expectResult(a.api.command('site.b', 'room.create'), { error: 'BUS_DENIED' }, '无授权 → BUS_DENIED');
}, { tags: ['B', 'authz'], options: { grants: unauthorizedGrants() } });
const B2 = defineScenario('B2 不可信驱动不能自报提权', async (ctx) => {
    const evil = ctx.harness.registerDriver(mockDriver('site.evil', {
        trust: 'remote',
        declared: { command: [{ target: 'site.b', ops: ['room.create'] }] },
    }));
    ctx.harness.registerDriver(mockDriver('site.b', { handlers: { 'room.create': roomCreateHandler } }));
    await ctx.expectResult(evil.api.command('site.b', 'room.create'), { error: 'BUS_DENIED' }, 'remote 声明不生效 → BUS_DENIED');
}, { tags: ['B', 'trust'], options: { useRealGrantRules: true } });
const B3 = defineScenario('B3 撤销后新请求按契约拒绝', async (ctx) => {
    const a = ctx.harness.registerDriver(mockDriver('site.a'));
    const c = ctx.harness.registerDriver(mockDriver('site.c'));
    ctx.harness.registerDriver(mockDriver('site.b', { handlers: { 'room.create': roomCreateHandler } }));
    ctx.bus.revoke('site.a');
    await ctx.expectResult(a.api.command('site.b', 'room.create'), { error: 'BUS_DENIED' }, '撤销发送方 → BUS_DENIED');
    ctx.bus.revoke('site.b');
    await ctx.expectResult(c.api.command('site.b', 'room.create'), { error: 'BUS_PEER_GONE' }, '撤销目标 → BUS_PEER_GONE');
}, { tags: ['B', 'revoke'] });
const B4 = defineScenario('B4 并发关闭不永久悬挂', async (ctx) => {
    ctx.harness.registerDriver(mockDriver('site.a'));
    await ctx.step('两个并发 close() 都在 1.5s 内完成', async () => {
        await Promise.race([
            Promise.all([ctx.bus.close(), ctx.bus.close()]),
            new Promise((_, reject) => {
                setTimeout(() => reject(new Error('close hung > 1500ms')), 1500);
            }),
        ]);
    });
    await ctx.expectResult(Promise.resolve(ctx.bus.state), { value: 'CLOSED' }, '状态 CLOSED');
}, { tags: ['B', 'close'] });
const B5 = defineScenario('B5 卸载后无残留订阅 / 未授权操作', async (ctx) => {
    const a = ctx.harness.registerDriver(mockDriver('site.a'));
    const b = ctx.harness.registerDriver(mockDriver('site.b'));
    let received = 0;
    b.subscribe('room:created', () => {
        received += 1;
    });
    ctx.bus.unregister('site.b');
    a.api.publish('room:created', { n: 1 });
    await ctx.expectResult(Promise.resolve(received), { value: 0 }, '卸载后不再投递');
    await ctx.expectResult(Promise.resolve(ctx.bus.stats().liveEndpoints), { value: 1 }, '仅 site.a 存活');
    // 旧句柄不得继续执行未授权操作：端点已 GONE，command 应 BUS_DENIED。
    await ctx.expectResult(b.api.command('site.a', 'room.ack'), { error: 'BUS_DENIED' }, '卸载后旧句柄不可再发');
}, { tags: ['B', 'unregister'] });
const B6 = defineScenario('B6 观察者无订阅授权时载荷不可观测（未验证）', async (ctx) => {
    const a = ctx.harness.registerDriver(mockDriver('site.a'));
    a.api.publish('room:created', { n: 1 });
    // 观察者没有 subscribe 授权：审计只有元数据，载荷谓词无法验证。
    await ctx.expectEvent('room:created', { payload: () => true }, '无订阅授权 → 载荷未验证');
}, { tags: ['B', 'unverified'], options: { grants: [pubGrant('site.a', 'room:')] } });
// ---------------------------------------------------------------------------
// C. 故障与恢复
// ---------------------------------------------------------------------------
const C1 = defineScenario('C1 超时', async (ctx) => {
    const a = ctx.harness.registerDriver(mockDriver('site.a'));
    ctx.harness.registerDriver(mockDriver('site.b', { handlers: { 'room.create': roomCreateHandler } }));
    const faults = new FaultInjector(ctx.harness);
    await faults.timeout('site.b', 'room.create');
    await ctx.expectResult(a.api.command('site.b', 'room.create', undefined, { deadlineMs: 120 }), { error: 'BUS_TIMEOUT' }, '挂起处理器 → BUS_TIMEOUT');
}, { tags: ['C', 'timeout'] });
const C2 = defineScenario('C2 异常响应', async (ctx) => {
    const a = ctx.harness.registerDriver(mockDriver('site.a'));
    ctx.harness.registerDriver(mockDriver('site.b', { handlers: { 'room.create': roomCreateHandler } }));
    const faults = new FaultInjector(ctx.harness);
    await faults.crash('site.b', 'room.create');
    await ctx.expectResult(a.api.command('site.b', 'room.create'), { error: 'BUS_HANDLER_ERROR' }, '处理器抛错 → BUS_HANDLER_ERROR');
}, { tags: ['C', 'handler-error'] });
const C3 = defineScenario('C3 接收方退出与重启', async (ctx) => {
    const a = ctx.harness.registerDriver(mockDriver('site.a'));
    let release = () => { };
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    ctx.harness.registerDriver(mockDriver('site.b', {
        handlers: {
            'room.create': async () => {
                await gate;
                return { id: 'room-1', echo: { name: 'late' } };
            },
        },
    }));
    const faults = new FaultInjector(ctx.harness);
    // 在飞命令：注销时按契约收 BUS_PEER_GONE。
    const inflight = a.api.command('site.b', 'room.create', undefined, {
        deadlineMs: 5000,
    });
    await ctx.step('让命令进入在飞', () => new Promise((r) => setTimeout(r, 20)));
    await faults.exit('site.b');
    await ctx.expectResult(inflight, { error: 'BUS_PEER_GONE' }, '在飞命令 → BUS_PEER_GONE');
    release();
    // 退出后的**新**命令没有路由：BUS_NO_ROUTE（与在飞的 PEER_GONE 区分）。
    await ctx.expectResult(a.api.command('site.b', 'room.create'), { error: 'BUS_NO_ROUTE' }, '退出后新命令 → BUS_NO_ROUTE');
    ctx.harness.registerDriver(mockDriver('site.b', { handlers: { 'room.create': roomCreateHandler } }));
    await ctx.expectResult(a.api.command('site.b', 'room.create', { name: 'again' }), { value: { id: 'room-1', echo: { name: 'again' } } }, '手动重启后恢复');
    await faults.restart('site.b');
    await ctx.expectResult(a.api.command('site.b', 'room.create', { name: 'third' }), { value: { id: 'room-1', echo: { name: 'third' } } }, 'FaultInjector.restart 后恢复');
}, { tags: ['C', 'restart'] });
const C4 = defineScenario('C4 清理失败与残留资源检测', async (ctx) => {
    const a = ctx.harness.registerDriver(mockDriver('site.a'));
    ctx.harness.registerDriver(mockDriver('site.b', {
        handlers: { 'room.create': () => new Promise(() => { }) },
    }));
    const pending = a.api.command('site.b', 'room.create', undefined, { deadlineMs: 5000 });
    pending.catch(() => {
        // 清理会以 BUS_PEER_GONE 收尾；这里先挂一个 handler 避免 unhandled rejection。
    });
    await ctx.harness.cleanup();
    await ctx.expectResult(Promise.resolve(ctx.bus.stats().endpoints), { value: 0 }, '端点全部移除');
    await ctx.expectResult(Promise.resolve(ctx.bus.stats().pendingTimers), { value: 0 }, '无残留定时器');
    await ctx.expectResult(Promise.resolve(ctx.bus.state), { value: 'CLOSED' }, '总线 CLOSED');
    await ctx.expectResult(pending, { error: 'BUS_PEER_GONE' }, '在飞命令被收尾');
}, { tags: ['C', 'cleanup'] });
const C5 = defineScenario('C5 重复消息 / 版本不匹配（契约待决）', () => {
    // 不会执行：contractPending 在 runSuite 中先行短路。
}, {
    tags: ['C', 'contract'],
    contractPending: '公开 API 不提供构造重复 reply 或错误版本信封的入口；总线内部处理，正式契约未定义可注入语义。',
});
// ---------------------------------------------------------------------------
// G. 外部依赖（如实标记）
// ---------------------------------------------------------------------------
const G1 = defineScenario('G1 manifest.bus 声明端到端（待 G-1 获批）', () => {
    // 不会执行：skip 在 runSuite 中先行短路。
}, {
    tags: ['G', 'external'],
    skip: 'G-1：manifest.bus 字段未获批，loader 尚未透传 declared；不得伪造通过。',
});
export const scenarios = [
    A1,
    A2,
    A3,
    A4,
    A5,
    B1,
    B2,
    B3,
    B4,
    B5,
    B6,
    C1,
    C2,
    C3,
    C4,
    C5,
    G1,
];
export { A1, A2, A3, A4, A5, B1, B2, B3, B4, B5, B6, C1, C2, C3, C4, C5, G1 };
/** 主场景集使用的授权表。 */
export const defaultOptions = { grants: basicGrants() };
