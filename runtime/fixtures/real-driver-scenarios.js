/**
 * 真实驱动端到端场景集。
 *
 * 判定口径（与任务书一致，五态分离）：
 *   pass             实际驱动 + 真实总线完成，断言成立
 *   fail             功能失败 / 权限被绕过 / 资源泄漏 / 断言不成立
 *   skip             测试条件不具备
 *   unverified       执行了，但证据不足以证明结论
 *   contract-pending 依赖尚未批准或尚未实现的契约
 *
 * 两类场景严格区分：
 *   - `constructed: false` → 走总线**真实授权规则**（生产语义）。
 *   - `constructed: true`  → 用总线公开测试钩子 `grantsFor` 注入授权表构造通路。
 *     它证明"通路本身可用"，**不证明**生产会放行；证据里一律带 `constructed` 标记。
 */
function grant(subject, kind, target, operations = []) {
    return { grantId: `g:t:${subject}:${kind}:${target}`, subject, kind, target, operations };
}
/** 驱动端点 → 对端 `svc.echo` 的命令授权（仅构造场景使用）。 */
function driverCommandGrants(driverId) {
    return [grant(driverId, 'command', 'svc.echo', ['echo.ping'])];
}
const DRIVER = 'org.quake.webrtc.im';
const PEER = 'svc.echo';
export const realDriverScenarios = [
    // -------------------------------------------------------------------------
    // A. 装载、注册、请求-响应、事件订阅
    // -------------------------------------------------------------------------
    {
        name: 'A1 装载：真实包经公开 API 注册端点并挂载',
        tags: ['load'],
        async fn(ctx) {
            const handle = await ctx.load();
            const rec = handle.record;
            ctx.assert('包身份取自清单（id/版本）', rec.moduleId === ctx.pkg.manifest.id && rec.version === ctx.pkg.manifest.version, `${rec.moduleId}@${rec.version}`);
            ctx.assert('入口哈希与取件记录一致', rec.entrySha256 === ctx.pkg.entrySha256, rec.entrySha256.slice(0, 16));
            ctx.assert('导出面含 mount/unmount/describe', ['mount', 'unmount', 'describe'].every((k) => rec.exports.includes(k)), rec.exports.join(','));
            ctx.assert('ctx 注入 bus', rec.ctxKeys.includes('bus'), rec.ctxKeys.join(','));
            ctx.assert('端点已登记', rec.registered && ctx.bus.stats().endpoints === 1, `endpoints=${ctx.bus.stats().endpoints}`);
            ctx.assert('mount 未抛错', rec.mountedAt !== null, `mountMs=${rec.mountMs}`);
            const described = rec.describe;
            ctx.assert('describe() 可读', described !== null && typeof described === 'object', JSON.stringify(described));
            ctx.assert('无槽位时降级 headless', (described === null || described === void 0 ? void 0 : described.headless) === true, `form=${String(described === null || described === void 0 ? void 0 : described.form)}`);
            ctx.assert('headless 不渲染 DOM', (described === null || described === void 0 ? void 0 : described.uiMounted) === false, `uiMounted=${String(described === null || described === void 0 ? void 0 : described.uiMounted)}`);
            // 归属判据：只数驱动拿到的那个 `ctx.bus` 代理。1.2.0 起驱动在装载期
            // **申请一次** `im:session` 订阅（业务路径），成不成由总线裁决。
            // 未获授权时必须是"申请 1 次、被拒、不发布"，而不是"悄悄什么都不做"。
            const calls = rec.busCalls;
            ctx.note(`驱动侧总线调用：command=${calls.command} publish=${calls.publish} subscribe=${calls.subscribe} handle=${calls.handle}`);
            ctx.assert('装载期恰好发起 1 次订阅申请（不重试）', calls.subscribe === 1, JSON.stringify(calls));
            ctx.assert('未获授权时一次都不发布', calls.publish === 0, JSON.stringify(calls));
            ctx.assert('装载期不发命令、不注册命令处理器', calls.command === 0 && calls.handle === 0, JSON.stringify(calls));
            ctx.assert('业务同步状态如实记为 denied', (described === null || described === void 0 ? void 0 : described.busSync) === 'denied', `busSync=${String(described === null || described === void 0 ? void 0 : described.busSync)}`);
        },
    },
    {
        name: 'A2 请求-响应：驱动端点发起命令并收到应答（构造授权）',
        tags: ['request-response', 'constructed'],
        constructed: true,
        async fn(ctx) {
            const handle = await ctx.load();
            const peer = ctx.peer(PEER);
            peer.handle('echo.ping', (payload) => ({ pong: true, echo: payload }));
            const res = (await handle.api.command(PEER, 'echo.ping', { n: 1 }));
            ctx.assert('命令返回对端应答', (res === null || res === void 0 ? void 0 : res.pong) === true, JSON.stringify(res));
            ctx.assert('payload 原样往返', JSON.stringify(res === null || res === void 0 ? void 0 : res.echo) === JSON.stringify({ n: 1 }), JSON.stringify(res === null || res === void 0 ? void 0 : res.echo));
            // 归属判据：本命令由测试侧经 `handle.api`（原始句柄）发出，**不得**计入驱动的
            // `ctx.bus` 计数代理。否则"驱动在经总线说话"这件事永远无法证伪——适配器代发
            // 与驱动自发在证据里长得一模一样。驱动自己的调用数见 A1 / F1。
            ctx.assert('命令不计入驱动侧计数（证明调用方是测试而非驱动）', handle.record.busCalls.command === 0, `command=${handle.record.busCalls.command}`);
        },
    },
    {
        name: 'A3 事件订阅：驱动端点订阅主题并收到对端发布（构造授权）',
        tags: ['event', 'constructed'],
        constructed: true,
        async fn(ctx) {
            const handle = await ctx.load();
            const peer = ctx.peer(PEER);
            const received = [];
            const off = handle.api.subscribe('room:members-changed', (ev) => {
                received.push(ev.payload);
            });
            peer.api.publish('room:members-changed', { members: ['a', 'b'] });
            await ctx.sleep(30);
            ctx.assert('订阅回调收到事件', received.length === 1, `received=${received.length}`);
            ctx.assert('事件 payload 完整', JSON.stringify(received[0]) === JSON.stringify({ members: ['a', 'b'] }), JSON.stringify(received[0]));
            off();
            peer.api.publish('room:members-changed', { members: [] });
            await ctx.sleep(20);
            ctx.assert('取消订阅后不再收到', received.length === 1, `received=${received.length}`);
            ctx.note('订阅由适配层以驱动端点身份安装：驱动产物内无订阅代码，故这是端点级证据而非业务级');
        },
    },
    // -------------------------------------------------------------------------
    // B. 权限：缺权限 / 越权 / 撤销
    // -------------------------------------------------------------------------
    {
        name: 'B1 缺权限：驱动端点无授权时命令被拒（真实规则）',
        tags: ['authz'],
        async fn(ctx) {
            const handle = await ctx.load();
            const peer = ctx.peer(PEER);
            let peerCalls = 0;
            peer.handle('echo.ping', () => {
                peerCalls += 1;
                return { pong: true };
            });
            await ctx.expectCode(handle.api.command(PEER, 'echo.ping', { n: 1 }), 'BUS_DENIED', '无授权命令 → BUS_DENIED');
            ctx.assert('被拒后对端 handler 未被调用', peerCalls === 0, `peerCalls=${peerCalls}`);
            const denied = ctx.trace(200).filter((t) => t.kind === 'denied' && t.result === 'denied');
            ctx.assert('审计留痕（denied/denied）', denied.length >= 1, `denied=${denied.length}`);
        },
    },
    {
        name: 'B2 越权：remote 驱动自报总线声明不生效（真实规则）',
        tags: ['authz', 'escalation'],
        async fn(ctx) {
            var _a, _b, _c;
            // 模拟"驱动在 manifest.bus 里自报可以给 svc.echo 发命令"
            const declared = { command: [{ target: PEER, ops: ['echo.ping'] }] };
            const handle = await ctx.load({ declared });
            const peer = ctx.peer(PEER);
            peer.handle('echo.ping', () => ({ pong: true }));
            await ctx.expectCode(handle.api.command(PEER, 'echo.ping', { n: 1 }), 'BUS_DENIED', '自报声明不产生授权 → BUS_DENIED');
            const reauth = ctx.trace(200).find((t) => t.kind === 'reauth' && t.result === 'denied');
            ctx.assert('审计记录声明被拒原因', Boolean(reauth), (_a = reauth === null || reauth === void 0 ? void 0 : reauth.detail) !== null && _a !== void 0 ? _a : '无 reauth 记录');
            ctx.assert('拒绝原因指向信任边界', /trust!=builtin/.test((_b = reauth === null || reauth === void 0 ? void 0 : reauth.detail) !== null && _b !== void 0 ? _b : ''), (_c = reauth === null || reauth === void 0 ? void 0 : reauth.detail) !== null && _c !== void 0 ? _c : '');
            ctx.note('信任边界：remote 的 declared 一律不生效（v1 无策略复核），需 O-17/CA-20261028-01-BUS 审批后才可能开放');
        },
    },
    {
        name: 'B3 权限撤销：授权可用 → revoke → 收发均拒',
        tags: ['authz', 'revoke', 'constructed'],
        constructed: true,
        async fn(ctx) {
            const handle = await ctx.load();
            const peer = ctx.peer(PEER);
            peer.handle('echo.ping', () => ({ pong: true }));
            const ok = (await handle.api.command(PEER, 'echo.ping', { n: 1 }));
            ctx.assert('撤销前可用', (ok === null || ok === void 0 ? void 0 : ok.pong) === true, JSON.stringify(ok));
            ctx.bus.revoke(handle.moduleId);
            await ctx.expectCode(handle.api.command(PEER, 'echo.ping', { n: 2 }), 'BUS_DENIED', '撤销后出站 → BUS_DENIED');
            ctx.assert('端点仍在册（撤销≠注销）', ctx.bus.stats().endpoints === 2, `endpoints=${ctx.bus.stats().endpoints}`);
        },
    },
    {
        name: 'B4 权限撤销：在飞命令被立即拒绝，不悬挂',
        tags: ['authz', 'revoke', 'constructed'],
        constructed: true,
        async fn(ctx) {
            const handle = await ctx.load();
            const peer = ctx.peer(PEER);
            peer.handle('echo.ping', () => new Promise(() => { }));
            const inflight = handle.api.command(PEER, 'echo.ping', { n: 1 }, { deadlineMs: 5000 });
            await ctx.sleep(20);
            ctx.bus.revoke(handle.moduleId);
            const started = Date.now();
            await ctx.expectCode(inflight, 'BUS_DENIED', '在飞命令撤销后 → BUS_DENIED');
            ctx.assert('撤销立即生效（<1s）', Date.now() - started < 1000, `${Date.now() - started}ms`);
        },
    },
    // -------------------------------------------------------------------------
    // C. 故障：超时 / 异常 / 接收方退出与恢复
    // -------------------------------------------------------------------------
    {
        name: 'C1 超时：对端不响应 → BUS_TIMEOUT 且带 corr',
        tags: ['fault', 'timeout', 'constructed'],
        constructed: true,
        async fn(ctx) {
            var _a, _b, _c;
            const handle = await ctx.load();
            const peer = ctx.peer(PEER);
            peer.handle('echo.ping', () => new Promise(() => { }));
            let caught = null;
            try {
                await handle.api.command(PEER, 'echo.ping', { n: 1 }, { deadlineMs: 120 });
            }
            catch (e) {
                caught = e;
            }
            ctx.assert('超时返回 BUS_TIMEOUT', (caught === null || caught === void 0 ? void 0 : caught.code) === 'BUS_TIMEOUT', String(caught === null || caught === void 0 ? void 0 : caught.code));
            ctx.assert('错误携带 corr（可追溯）', typeof ((_a = caught === null || caught === void 0 ? void 0 : caught.detail) === null || _a === void 0 ? void 0 : _a.corr) === 'string', JSON.stringify(caught === null || caught === void 0 ? void 0 : caught.detail));
            const corr = String((_c = (_b = caught === null || caught === void 0 ? void 0 : caught.detail) === null || _b === void 0 ? void 0 : _b.corr) !== null && _c !== void 0 ? _c : '');
            ctx.assert('审计可按 corr 检索到该次超时', ctx.trace(500).some((t) => t.corr === corr), `corr=${corr}`);
        },
    },
    {
        name: 'C2 异常：对端处理器抛错 → BUS_HANDLER_ERROR',
        tags: ['fault', 'handler-error', 'constructed'],
        constructed: true,
        async fn(ctx) {
            var _a;
            const handle = await ctx.load();
            const peer = ctx.peer(PEER);
            peer.handle('echo.ping', () => {
                throw new Error('boom from peer');
            });
            let caught = null;
            try {
                await handle.api.command(PEER, 'echo.ping', { n: 1 }, { deadlineMs: 500 });
            }
            catch (e) {
                caught = e;
            }
            ctx.assert('异常返回 BUS_HANDLER_ERROR', (caught === null || caught === void 0 ? void 0 : caught.code) === 'BUS_HANDLER_ERROR', String(caught === null || caught === void 0 ? void 0 : caught.code));
            ctx.assert('错误详情含构造函数名', ((_a = caught === null || caught === void 0 ? void 0 : caught.detail) === null || _a === void 0 ? void 0 : _a.error) === 'Error', JSON.stringify(caught === null || caught === void 0 ? void 0 : caught.detail));
            ctx.note('总线只透出错误构造函数名，不透出 message/stack（信息量受限，见归属清单）');
        },
    },
    {
        name: 'C3 接收方退出：对端注销 → BUS_NO_ROUTE',
        tags: ['fault', 'peer-gone', 'constructed'],
        constructed: true,
        async fn(ctx) {
            const handle = await ctx.load();
            const peer = ctx.peer(PEER);
            peer.handle('echo.ping', () => ({ pong: true }));
            const ok = (await handle.api.command(PEER, 'echo.ping', { n: 1 }));
            ctx.assert('退出前可用', (ok === null || ok === void 0 ? void 0 : ok.pong) === true, JSON.stringify(ok));
            peer.unregister();
            await ctx.expectCode(handle.api.command(PEER, 'echo.ping', { n: 2 }), 'BUS_NO_ROUTE', '对端退出 → BUS_NO_ROUTE');
        },
    },
    {
        name: 'C4 接收方恢复：重新登记后同一驱动可继续调用',
        tags: ['fault', 'recovery', 'constructed'],
        constructed: true,
        async fn(ctx) {
            const handle = await ctx.load();
            const first = ctx.peer(PEER, { nonce: 'svc.echo#1' });
            first.handle('echo.ping', () => ({ pong: 1 }));
            const r1 = (await handle.api.command(PEER, 'echo.ping', {}));
            ctx.assert('首次调用成功', (r1 === null || r1 === void 0 ? void 0 : r1.pong) === 1, JSON.stringify(r1));
            first.unregister();
            await ctx.expectCode(handle.api.command(PEER, 'echo.ping', {}), 'BUS_NO_ROUTE', '退出后 → BUS_NO_ROUTE');
            const second = ctx.peer(PEER, { nonce: 'svc.echo#2' });
            second.handle('echo.ping', () => ({ pong: 2 }));
            const r2 = (await handle.api.command(PEER, 'echo.ping', {}));
            ctx.assert('恢复后调用成功（新实例）', (r2 === null || r2 === void 0 ? void 0 : r2.pong) === 2, JSON.stringify(r2));
        },
    },
    {
        name: 'C5 驱动卸载后：对端调用驱动端点 → BUS_NO_ROUTE',
        tags: ['fault', 'peer-gone', 'unload', 'constructed'],
        constructed: true,
        async fn(ctx) {
            const handle = await ctx.load();
            // 以驱动端点身份装一个处理器，才能区分"端点没了"和"端点没这个 op"
            handle.api.handle('im.state', () => ({ phase: 'idle' }));
            const peer = ctx.peer(PEER);
            const before = (await peer.api.command(DRIVER, 'im.state', {}));
            ctx.assert('卸载前对端可调用驱动端点', (before === null || before === void 0 ? void 0 : before.phase) === 'idle', JSON.stringify(before));
            await handle.unload();
            await ctx.expectCode(peer.api.command(DRIVER, 'im.state', {}), 'BUS_NO_ROUTE', '驱动卸载后 → BUS_NO_ROUTE');
            ctx.note('该处理器由适配层以驱动端点身份安装，用于验证路由；驱动自身无 handler');
        },
    },
    // -------------------------------------------------------------------------
    // D. 卸载、重复装载、资源清理与残留
    // -------------------------------------------------------------------------
    {
        name: 'D1 卸载：排空、清理、残留与旧句柄失效',
        tags: ['unload', 'cleanup'],
        async fn(ctx) {
            var _a;
            const handle = await ctx.load();
            const teardown = await handle.unload();
            ctx.assert('卸载记录已生成', Boolean(teardown), 'teardown');
            ctx.assert('端点数量回落', teardown.endpointsAfter < teardown.endpointsBefore, `before=${teardown.endpointsBefore} after=${teardown.endpointsAfter}`);
            ctx.assert('无在飞命令', teardown.inflightAfter === 0, `inflight=${teardown.inflightAfter}`);
            ctx.assert('无待执行队列', teardown.queuedAfter === 0, `queued=${teardown.queuedAfter}`);
            ctx.assert('无残留定时器', teardown.pendingTimersAfter === 0, `timers=${teardown.pendingTimersAfter}`);
            ctx.assert('disposer 全部正常', teardown.disposerErrors.length === 0, teardown.disposerErrors.join('; ') || 'none');
            ctx.assert('unmount 未抛错', !teardown.unmountError, (_a = teardown.unmountError) !== null && _a !== void 0 ? _a : 'ok');
            ctx.assert('驱动自述已清空（describe→null）', teardown.describeAfter === null, JSON.stringify(teardown.describeAfter));
            await ctx.expectCode(handle.api.command(PEER, 'echo.ping', {}), 'BUS_DENIED', '卸载后旧句柄出站 → BUS_DENIED');
            ctx.assert('排空耗时已量化', typeof teardown.drainedMs === 'number', `${teardown.drainedMs}ms`);
        },
    },
    {
        name: 'D2 重复卸载：幂等，不抛错、不重复清理',
        tags: ['unload', 'idempotent'],
        async fn(ctx) {
            const handle = await ctx.load();
            const first = await handle.unload();
            const second = await handle.unload();
            ctx.assert('第二次卸载不抛错', true, 'returned');
            ctx.assert('两次结论一致（同一份记录）', first.unregisteredAt === second.unregisteredAt, `${first.unregisteredAt} vs ${second.unregisteredAt}`);
            ctx.assert('端点仍为 0', ctx.bus.stats().endpoints === 0, `endpoints=${ctx.bus.stats().endpoints}`);
        },
    },
    {
        name: 'D3 重复装载：同 id 重装替换旧实例，旧句柄失效',
        tags: ['reload'],
        async fn(ctx) {
            const first = await ctx.load({ instanceNonce: `${DRIVER}#1` });
            const second = await ctx.load({ instanceNonce: `${DRIVER}#2` });
            ctx.assert('同 id 只保留一个端点', ctx.bus.stats().endpoints === 1, `endpoints=${ctx.bus.stats().endpoints}`);
            ctx.assert('新实例 nonce 不同', first.instanceNonce !== second.instanceNonce, `${first.instanceNonce} / ${second.instanceNonce}`);
            ctx.assert('新实例可用', second.describe() !== null, JSON.stringify(second.describe()));
            await ctx.expectCode(first.api.command(PEER, 'echo.ping', {}), 'BUS_DENIED', '旧实例句柄出站 → BUS_DENIED');
        },
    },
    {
        name: 'D4 卸载后重装：可再次装载且自述正常',
        tags: ['reload', 'unload'],
        async fn(ctx) {
            const first = await ctx.load();
            await first.unload();
            ctx.assert('卸载后端点清零', ctx.bus.stats().endpoints === 0, `endpoints=${ctx.bus.stats().endpoints}`);
            const second = await ctx.load({ instanceNonce: `${DRIVER}#again` });
            const described = second.describe();
            ctx.assert('重装成功', described !== null, JSON.stringify(described));
            ctx.assert('重装后仍为 headless', (described === null || described === void 0 ? void 0 : described.headless) === true, `headless=${String(described === null || described === void 0 ? void 0 : described.headless)}`);
            ctx.assert('端点回到 1', ctx.bus.stats().endpoints === 1, `endpoints=${ctx.bus.stats().endpoints}`);
        },
    },
    {
        name: 'D5 卸载：在飞命令随撤权立即收尾，不悬挂',
        tags: ['unload', 'inflight', 'constructed'],
        constructed: true,
        async fn(ctx) {
            const handle = await ctx.load();
            const peer = ctx.peer(PEER);
            peer.handle('echo.ping', () => new Promise(() => { }));
            const inflight = handle.api.command(PEER, 'echo.ping', {}, { deadlineMs: 10000 });
            await ctx.sleep(20);
            const unloading = handle.unload();
            await ctx.expectCode(inflight, 'BUS_DENIED', '卸载时在飞命令 → BUS_DENIED（不等 10s 超时）');
            const teardown = await unloading;
            ctx.assert('撤权前确有在飞命令', teardown.inflightBeforeRevoke >= 1, `inflight=${teardown.inflightBeforeRevoke}`);
            ctx.assert('排空未退化成长等待', teardown.drainedMs < 200, `${teardown.drainedMs}ms`);
            ctx.assert('卸载后无在飞/无定时器', teardown.inflightAfter === 0 && teardown.pendingTimersAfter === 0, `inflight=${teardown.inflightAfter} timers=${teardown.pendingTimersAfter}`);
            ctx.note('撤权先于排空：在飞命令按 BUS_DENIED 收尾，排空自然为 0（与 loader destroy 同序）');
        },
    },
    // -------------------------------------------------------------------------
    // E. 参数错误 / 契约版本 / 重复消息
    // -------------------------------------------------------------------------
    {
        name: 'E1 参数错误：非法 op 与非法 target 被契约层拒绝',
        tags: ['contract', 'constructed'],
        constructed: true,
        async fn(ctx) {
            const handle = await ctx.load();
            const peer = ctx.peer(PEER);
            peer.handle('echo.ping', () => ({ pong: true }));
            await ctx.expectCode(handle.api.command(PEER, 'notanop', {}), 'BUS_MALFORMED', 'op 不符合 <a>.<b> → BUS_MALFORMED');
            await ctx.expectCode(handle.api.command('bad target', 'echo.ping', {}), 'BUS_MALFORMED', 'target 非法 → BUS_MALFORMED');
        },
    },
    {
        name: 'E2 契约版本不匹配：公开 API 无法构造异构信封',
        tags: ['contract'],
        contractPending: '信封版本 `v` 由运行时内部构造（validateEnvelope 才有 BUS_VERSION_UNSUPPORTED），公开 API 不暴露注入点；' +
            '通过私有路径构造会绕过真实入口，属伪证。待协议层提供版本协商契约后再测。',
    },
    {
        name: 'E3 重复消息：总线无幂等键契约',
        tags: ['contract'],
        contractPending: 'v1 协议无消息幂等键/去重窗口定义，重复投递属未定义行为；需要协议层先给出语义，测试不能自造判据。',
    },
    {
        name: 'F2 驱动自身申请订阅：未授权即被拒，且不重试不发布（真实规则）',
        tags: ['authz', 'driver-boundary'],
        async fn(ctx) {
            const handle = await ctx.load();
            const rec = handle.record;
            // 注意：`record.describe` 是**装载时的快照**，要看"现在"必须调 live 的 describe()
            const d = handle.describe();
            ctx.assert('订阅申请由驱动自身发起（计数来自 ctx.bus 代理）', rec.busCalls.subscribe === 1, JSON.stringify(rec.busCalls));
            ctx.assert('被拒后不发布任何消息', rec.busCalls.publish === 0, JSON.stringify(rec.busCalls));
            ctx.assert('busSync=denied（与 unavailable 分开记）', (d === null || d === void 0 ? void 0 : d.busSync) === 'denied', String(d === null || d === void 0 ? void 0 : d.busSync));
            ctx.assert('端口状态同为 denied', (d === null || d === void 0 ? void 0 : d.busState) === 'denied', String(d === null || d === void 0 ? void 0 : d.busState));
            ctx.note('这是"驱动申请、总线裁决"的正常拒绝路径：驱动没有绕过授权，也没有把异常甩给 UI');
            await handle.unload();
        },
    },
    {
        name: 'F3 业务通路（构造授权）：驱动发 im:state 被对端收到、对端发 im:session 被驱动收下',
        tags: ['event', 'constructed', 'driver-boundary'],
        constructed: true,
        async fn(ctx) {
            // 先建对端订阅，再装驱动：驱动的首次快照发布发生在 mount 内，晚订阅会漏掉
            const peer = ctx.peer(PEER);
            const got = [];
            const off = peer.api.subscribe('im:state', (ev) => { got.push(ev.payload); });
            const handle = await ctx.load();
            await ctx.sleep(20);
            ctx.assert('驱动自身发布过 im:state', handle.record.busCalls.publish >= 1, JSON.stringify(handle.record.busCalls));
            ctx.assert('对端收到驱动发布的状态快照', got.length >= 1, `got=${got.length}`);
            const p = got[0];
            ctx.assert('快照形状为 im/state@0', (p === null || p === void 0 ? void 0 : p.schema) === 'im/state@0', JSON.stringify(p));
            ctx.assert('快照不含消息正文/媒体对象', p !== undefined && !('messages' in p) && !('media' in p), JSON.stringify(p));
            // 反向：对端发 im:session，驱动装载时已订阅，应记录到会话表
            peer.api.publish('im:session', { action: 'announce', peerId: 'peer-1', name: '乙', room: 'r-1' });
            await ctx.sleep(50);
            const d = handle.describe();
            ctx.assert('驱动收下 im:session（会话表 +1）', (d === null || d === void 0 ? void 0 : d.busSessions) === 1, `busSessions=${String(d === null || d === void 0 ? void 0 : d.busSessions)}`);
            ctx.assert('busSync=active', (d === null || d === void 0 ? void 0 : d.busSync) === 'active', String(d === null || d === void 0 ? void 0 : d.busSync));
            ctx.note('构造授权只证明"通路可用"，不证明生产会放行（生产放行取决于 manifest.bus + builtin 装载）');
            off();
        },
    },
    {
        name: 'F1 生产语义下的业务互通（需 manifest.bus 生效）',
        tags: ['contract', 'driver-boundary'],
        contractPending: '驱动 1.2.0 已在业务路径上真正订阅 im:session / 发布 im:state（见 F2/F3），但生产放行仍缺两件：' +
            '① manifest.bus 字段未落地（BUS-1.1/1.2/1.3 未批），驱动无法声明；② 驱动未部署为内置（DEP-1），' +
            'remote 信任边界下自报声明一律不生效（TRUST-1）。两件同时到位后，本场景应转为非构造的真实 PASS。',
    },
];
/** 构造场景所需的授权表（按驱动 id 生成）。 */
export function grantsForRealDriverScenarios(driverId = DRIVER) {
    return [
        ...driverCommandGrants(driverId),
        grant(driverId, 'subscribe', 'room:members-changed'),
        grant(PEER, 'publish', 'room:members-changed'),
        // IM 业务通路的四个授权（仅构造场景注入；生产由 manifest.bus 决定）
        grant(driverId, 'subscribe', 'im:session'),
        grant(driverId, 'publish', 'im:state'),
        grant(PEER, 'subscribe', 'im:state'),
        grant(PEER, 'publish', 'im:session'),
        grant(PEER, 'command', driverId, ['im.state']),
    ];
}
