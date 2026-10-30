/**
 * 审计存储适配层（与 Storage Infrastructure 的接口侧）。
 *
 * 依赖方向：**总线不 import 存储，存储也不 import 总线。**
 * 存储侧只需实现 `AuditStorePort`（`ports.ts`）这个两方法的接口，
 * 由装配层把实例交给 `createBus({ auditStore })`。
 *
 * 本文件提供两样东西：
 *   1. `createMemoryAuditStore` —— 参考实现 + 测试替身（也用于没有存储的部署）；
 *   2. `runAuditStoreConformance` —— **一致性测试套件**，任何候选适配器
 *      （IndexedDB / SQLite / 远端日志）跑一遍就知道是否满足总线契约。
 *
 * 为什么要有套件而不是只写文档：契约写在文档里靠自觉，写在测试里才有牙。
 * 套件里包含一条"反例验证"——故意写一个不满足契约的适配器，套件必须判它失败，
 * 否则套件本身就是摆设（见 audit-store.test.ts）。
 *
 * 完整契约与差异清单见 docs/STORAGE_CONTRACT.md。
 */
/**
 * 内存参考实现。
 *
 * 三个行为刻意对齐契约：
 *   - **按 `sessionId + seq` 去重**：重放/重试不会产生重复记录；
 *   - **不修改入参**：只读入参、拷贝入库；
 *   - **失败即抛**：不吞错（吞错会让"落盘失败"看起来像"落盘成功"）。
 *
 * 它不是持久化方案：进程结束即丢失。用它验证适配器该长什么样，
 * 也用于"存储未就绪"的降级部署。
 */
export function createMemoryAuditStore(options = {}) {
    var _a;
    const rows = [];
    const seen = new Set();
    let failNext = options.failNext === true;
    const latency = (_a = options.latencyMs) !== null && _a !== void 0 ? _a : 0;
    return {
        port: {
            kind: 'memory',
            async append(entries) {
                if (latency > 0)
                    await new Promise((r) => setTimeout(r, latency));
                if (failNext) {
                    failNext = false;
                    throw new Error('memory store: injected failure');
                }
                // 先整体校验，再整体提交：不做部分成功
                const batch = [];
                for (const e of entries) {
                    const key = `${e.sessionId}:${e.seq}`;
                    if (seen.has(key))
                        continue;
                    batch.push({ ...e });
                }
                for (const e of batch) {
                    seen.add(`${e.sessionId}:${e.seq}`);
                    rows.push(e);
                }
                // 读取顺序必须与 (sessionId, seq) 一致。
                //
                // 只 push 是不够的：并发 append 时后发的批次可能先到，push 会把
                // 到达顺序当成时间顺序，读出来就是 3,1,2。审计的全部价值建立在
                // "能按时间重放"上，顺序错了对账就无从谈起。
                //
                // 参考实现用全量排序换简单（O(n log n)/批）；生产适配器应利用索引
                // （IDB 的复合主键 [sessionId, seq] 天然有序，不需要这一步）。
                rows.sort((a, b) => a.sessionId === b.sessionId ? a.seq - b.seq : a.sessionId < b.sessionId ? -1 : 1);
            },
        },
        async dump() {
            return rows.map((r) => ({ ...r }));
        },
        failNext() {
            failNext = true;
        },
    };
}
function rec(sessionId, seq, extra = {}) {
    return { kind: 'command', result: 'ok', at: 1700000000000 + seq, sessionId, seq, ...extra };
}
/**
 * 跑一遍契约检查。
 *
 * 每个检查都用**新的**存储实例（`create()` 每次调用返回全新实例），
 * 避免前一项的残留污染后一项。
 *
 * 返回 `checks`，不抛错——调用方（测试或存储团队的自检脚本）自己决定
 * 怎么处置失败项。抛错会让"哪一项失败"这个信息丢失。
 */
export async function runAuditStoreConformance(create) {
    const checks = [];
    const add = (id, title, ok, detail) => {
        checks.push({ id, title, ok, detail });
    };
    // S1 基本追加
    {
        const h = await create();
        await h.port.append([rec('s1', 1), rec('s1', 2)]);
        const rows = await h.dump();
        add('S1', 'append 一批后记录条数一致', rows.length === 2, `got ${rows.length}, want 2`);
    }
    // S2 空批次
    {
        const h = await create();
        let threw = false;
        try {
            await h.port.append([]);
        }
        catch {
            threw = true;
        }
        add('S2', '空批次不抛错', !threw);
    }
    // S3 顺序：**乱序传入**也要按 seq 读出来
    //
    // 用有序输入测这条等于没测：push 实现天然"保持传入顺序"，主键实现天然
    // "按主键排序"，两者在有序输入下表现完全一致。只有乱序输入才能暴露分歧——
    // 而乱序是会发生的：并发 append 时后发的批次可能先到（S5 只测了"不丢"，
    // 没测"顺序"）。审计的价值在于能按时间重放，读出来是乱的就没法对账。
    {
        const h = await create();
        await h.port.append([rec('s3', 3), rec('s3', 1), rec('s3', 2)]);
        const rows = (await h.dump()).filter((r) => r.sessionId === 's3');
        add('S3', '乱序传入后按 seq 有序读出', rows.map((r) => r.seq).join(',') === '1,2,3', rows.map((r) => r.seq).join(','));
    }
    // S4 重复写入幂等（去重键 sessionId+seq）
    {
        const h = await create();
        const batch = [rec('s4', 1), rec('s4', 2)];
        await h.port.append(batch);
        await h.port.append(batch);
        const rows = (await h.dump()).filter((r) => r.sessionId === 's4');
        add('S4', '重复批次按 sessionId+seq 去重', rows.length === 2, `got ${rows.length}, want 2`);
    }
    // S5 并发追加不丢
    {
        const h = await create();
        await Promise.all([
            h.port.append([rec('s5', 1)]),
            h.port.append([rec('s5', 2)]),
            h.port.append([rec('s5', 3)]),
        ]);
        const rows = (await h.dump()).filter((r) => r.sessionId === 's5');
        add('S5', '并发 append 不丢记录', rows.length === 3, `got ${rows.length}, want 3`);
    }
    // S6 不修改入参
    {
        const h = await create();
        const input = [rec('s6', 1, { subject: 'site.a', op: 'x' })];
        const before = JSON.stringify(input);
        await h.port.append(input);
        add('S6', '不修改传入的记录对象', JSON.stringify(input) === before);
    }
    // S7 失败必须显式（不能静默吞）
    {
        const h = await create();
        h.failNext();
        let threw = false;
        try {
            await h.port.append([rec('s7', 1)]);
        }
        catch {
            threw = true;
        }
        add('S7', '写入失败时抛错而非静默丢弃', threw);
    }
    // S8 失败后仍可继续写（不做永久熔断）
    {
        const h = await create();
        h.failNext();
        try {
            await h.port.append([rec('s8', 1)]);
        }
        catch {
            /* 预期失败 */
        }
        await h.port.append([rec('s8', 2)]);
        const rows = (await h.dump()).filter((r) => r.sessionId === 's8');
        add('S8', '失败一次后仍能继续写入', rows.length === 1, `got ${rows.length}, want 1`);
    }
    // S9 kind 标识存在（便于诊断与契约对照）
    {
        const h = await create();
        add('S9', 'port.kind 非空（便于诊断）', typeof h.port.kind === 'string' && h.port.kind.length > 0);
    }
    return checks;
}
