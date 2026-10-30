/**
 * IndexedDB 审计存储适配器 —— **总线侧的参考实现**（对应 `O-20`）。
 *
 * 位置说明：本文件属「存储适配层」，**不属于 IB-A 也不属于 IB-B**。
 * 它实现 `AuditStorePort`，因此天然带浏览器全局（`indexedDB`），
 * 不能进 `src/runtime.ts` 的纯度约束。`scripts/check-purity.mjs` 刻意不把它
 * 列入 IB-B 目标——列进去只会逼着作者把 `indexedDB` 藏进参数名里。
 *
 * 为什么由总线侧提供一份真实适配器（而不是只交契约）：
 *
 *   1. 契约没有真实实现验证过，就是纸面承诺。一致性套件在内存实现上全绿，
 *      证明不了"真的能落盘"——内存实现连事务都没有。
 *   2. 存储团队需要一个**可运行的对照片**：接口长什么样、失败怎么抛、
 *      去重键怎么落、事务边界在哪。文档描述不了这些，代码可以。
 *   3. 故障注入需要真实的事务中止语义。模拟出来的"失败"不覆盖
 *      `onabort` / `QuotaExceededError` / `blocked` 这些真实路径。
 *
 * **生产适配器仍应由存储侧实现**（`docs/STORAGE_CONTRACT.md` §3）。
 * 本实现是参照物与降级选项，不是"总线替存储做决定"。
 *
 * 设计要点（每条对应契约里的一条要求）：
 *
 *   - **复合主键 `[sessionId, seq]`**（S-4）：`put` 天然幂等，重放不产生重复。
 *     用自增主键 + 唯一索引也行，但那样"重复写入"会抛 `ConstraintError`，
 *     与 S-8（失败后仍可继续写）的语义纠缠不清。`put` 覆盖更干净。
 *   - **单事务整批提交**（S-1 / S-7）：`append` 一个事务写完整批；
 *     事务 `onabort` 即整批失败，不存在"写了一半"。
 *   - **失败即 reject**（S-7）：`tx.onerror` / `tx.onabort` 都 reject，
 *     且把 `tx.error` 原样带出——吞掉错误会让"落盘失败"看起来像"落盘成功"。
 *   - **不改入参**（S-6）：只读入参，写入前浅拷贝。
 *   - **不阻塞调用方**（B-2）：`append` 是异步的，总线不等它。
 */
const DEFAULTS = {
    dbName: 'quake-intent-bus-audit',
    storeName: 'records',
    version: 1,
    openTimeoutMs: 5000,
};
/**
 * 白名单式拷贝。
 *
 * 为什么不用 `{ ...e }`：`AuditRecord` 是结构类型，运行时可能被塞进额外字段
 * （比如上游把 payload 顺手挂上去）。用显式字段表写库，等于在持久化边界上
 * 再做一次"payload 不入库"的强制——`STORAGE_CONTRACT.md` §1.1 说 payload
 * 永不入库，这是契约，不是"当前实现恰好没写"。
 */
function toRow(e) {
    const row = {
        kind: e.kind,
        result: e.result,
        at: e.at,
        seq: e.seq,
        sessionId: e.sessionId,
    };
    // 可选字段只在存在时写入：IDB 会把 undefined 存成"有键无值"，
    // 读回时 `'subject' in row === true`，容易误导排障
    return {
        ...row,
        ...(e.subject !== undefined ? { subject: e.subject } : {}),
        ...(e.target !== undefined ? { target: e.target } : {}),
        ...(e.op !== undefined ? { op: e.op } : {}),
        ...(e.topic !== undefined ? { topic: e.topic } : {}),
        ...(e.corr !== undefined ? { corr: e.corr } : {}),
        ...(e.detail !== undefined ? { detail: e.detail } : {}),
    };
}
export function createIndexedDbAuditStore(options = {}) {
    var _a, _b, _c, _d, _e;
    const dbName = (_a = options.dbName) !== null && _a !== void 0 ? _a : DEFAULTS.dbName;
    const storeName = (_b = options.storeName) !== null && _b !== void 0 ? _b : DEFAULTS.storeName;
    const version = (_c = options.version) !== null && _c !== void 0 ? _c : DEFAULTS.version;
    const openTimeoutMs = (_d = options.openTimeoutMs) !== null && _d !== void 0 ? _d : DEFAULTS.openTimeoutMs;
    const factory = (_e = options.factory) !== null && _e !== void 0 ? _e : globalThis.indexedDB;
    let dbPromise = null;
    function open() {
        if (dbPromise)
            return dbPromise;
        if (!factory) {
            // 环境没有 IDB：**必须显式失败**，不能静默当内存实现。
            // 静默降级会让"审计已落盘"变成谎话，而这正是本适配器要防的事
            return Promise.reject(new Error('idb: indexedDB is not available in this environment'));
        }
        dbPromise = new Promise((resolve, reject) => {
            let settled = false;
            const done = (fn) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                fn();
            };
            const timer = setTimeout(() => {
                // `onblocked` 会一直挂着（另一个标签页持有旧版本连接）。
                // 无限等待会让调用方以为"存储很慢"，实际是永远不来——必须超时
                done(() => reject(new Error('idb: open timed out (blocked by another connection?)')));
            }, openTimeoutMs);
            let req;
            try {
                req = factory.open(dbName, version);
            }
            catch (err) {
                done(() => reject(err));
                return;
            }
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(storeName)) {
                    // 复合主键：`put` 幂等，重放不产生重复（S-4）
                    db.createObjectStore(storeName, { keyPath: ['sessionId', 'seq'] });
                }
            };
            req.onsuccess = () => done(() => resolve(req.result));
            req.onerror = () => done(() => { var _a; return reject((_a = req.error) !== null && _a !== void 0 ? _a : new Error('idb: open failed')); });
            req.onblocked = () => {
                // 不立刻 reject：另一个连接可能马上关。交给超时兜底，
                // 但保留一个明确的错误来源，避免排障时只看到"超时"
                done(() => reject(new Error('idb: open blocked by another connection')));
            };
        });
        // 打开失败后不要把失败的 Promise 永久缓存：下一次调用应能重试
        dbPromise.catch(() => {
            dbPromise = null;
        });
        return dbPromise;
    }
    return {
        kind: 'idb-v1',
        async append(entries) {
            // S-2：空批次不报错，也不开事务（开事务本身有成本）
            if (entries.length === 0)
                return;
            const db = await open();
            await new Promise((resolve, reject) => {
                let tx;
                try {
                    tx = db.transaction(storeName, 'readwrite');
                }
                catch (err) {
                    // 连接已被 close / 数据库被删除时会走到这里
                    reject(err);
                    return;
                }
                // 整批原子：`oncomplete` 才算成功。`onerror` 与 `onabort` 都会 reject，
                // Promise 只取第一次，所以不需要额外去重
                tx.oncomplete = () => resolve();
                tx.onerror = () => { var _a; return reject((_a = tx.error) !== null && _a !== void 0 ? _a : new Error('idb: transaction error')); };
                tx.onabort = () => { var _a; return reject((_a = tx.error) !== null && _a !== void 0 ? _a : new Error('idb: transaction aborted')); };
                try {
                    const os = tx.objectStore(storeName);
                    for (const e of entries)
                        os.put(toRow(e));
                }
                catch (err) {
                    // 单条 put 同步抛错（如 keyPath 不匹配）时事务仍在跑，
                    // 必须主动 abort，否则会"部分成功"——违反 S-1 的整批语义
                    try {
                        tx.abort();
                    }
                    catch {
                        /* 已经 abort 或已完成 */
                    }
                    reject(err);
                }
            });
        },
        async dump() {
            const db = await open();
            return await new Promise((resolve, reject) => {
                let tx;
                try {
                    tx = db.transaction(storeName, 'readonly');
                }
                catch (err) {
                    reject(err);
                    return;
                }
                const os = tx.objectStore(storeName);
                const req = os.getAll();
                req.onsuccess = () => {
                    const rows = req.result.slice();
                    // getAll 的顺序是主键序（sessionId 字典序 → seq 数值序）。
                    // 跨 session 的字典序不是"发生顺序"，所以只保证组内有序
                    rows.sort((a, b) => (a.sessionId === b.sessionId ? a.seq - b.seq : a.sessionId < b.sessionId ? -1 : 1));
                    resolve(rows);
                };
                req.onerror = () => { var _a; return reject((_a = req.error) !== null && _a !== void 0 ? _a : new Error('idb: getAll failed')); };
            });
        },
        async prune(options) {
            const before = options.before;
            const maxPerSession = options.maxPerSession;
            // 两个条件都没给 → 什么都不做。**不能**默认"清空"：
            // 保留策略写错时，默认值决定是"多留"还是"全删"，必须偏向多留
            if (before === undefined && maxPerSession === undefined)
                return { scanned: 0, deleted: 0 };
            const db = await open();
            return await new Promise((resolve, reject) => {
                let tx;
                try {
                    tx = db.transaction(storeName, 'readwrite');
                }
                catch (err) {
                    reject(err);
                    return;
                }
                let scanned = 0;
                let deleted = 0;
                // 单事务：要么整轮删对，要么一条不删。清理做到一半会留下
                // "有些旧记录被删、有些没删"的中间态，运维无法解释
                tx.oncomplete = () => resolve({ scanned, deleted });
                tx.onerror = () => { var _a; return reject((_a = tx.error) !== null && _a !== void 0 ? _a : new Error('idb: prune transaction error')); };
                tx.onabort = () => { var _a; return reject((_a = tx.error) !== null && _a !== void 0 ? _a : new Error('idb: prune transaction aborted')); };
                try {
                    const os = tx.objectStore(storeName);
                    const req = os.getAll();
                    req.onerror = () => { var _a; return reject((_a = req.error) !== null && _a !== void 0 ? _a : new Error('idb: prune getAll failed')); };
                    req.onsuccess = () => {
                        const rows = req.result.slice();
                        scanned = rows.length;
                        const bySession = new Map();
                        for (const r of rows) {
                            const list = bySession.get(r.sessionId);
                            if (list)
                                list.push(r);
                            else
                                bySession.set(r.sessionId, [r]);
                        }
                        try {
                            for (const list of bySession.values()) {
                                // 显式排序，不依赖 getAll 的主键序实现细节
                                list.sort((a, b) => a.seq - b.seq);
                                const keep = maxPerSession === undefined ? list.length : Math.max(0, Math.floor(maxPerSession));
                                const keepFrom = Math.max(0, list.length - keep);
                                for (let i = 0; i < list.length; i += 1) {
                                    const r = list[i];
                                    const tooOld = before !== undefined && r.at < before;
                                    const overCap = i < keepFrom;
                                    if (!tooOld && !overCap)
                                        continue;
                                    os.delete([r.sessionId, r.seq]);
                                    deleted += 1;
                                }
                            }
                        }
                        catch (err) {
                            // 单条 delete 同步抛错：主动 abort，避免"删了一半"
                            try {
                                tx.abort();
                            }
                            catch {
                                /* 已 abort 或已完成 */
                            }
                            reject(err);
                        }
                    };
                }
                catch (err) {
                    try {
                        tx.abort();
                    }
                    catch {
                        /* 已 abort 或已完成 */
                    }
                    reject(err);
                }
            });
        },
        async close() {
            const p = dbPromise;
            dbPromise = null;
            if (!p)
                return;
            try {
                const db = await p;
                db.close();
            }
            catch {
                // 打开本来就失败了，没有连接可关
            }
        },
    };
}
