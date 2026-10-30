/**
 * 场景定义。刻意做成纯数据 + 纯函数，便于 Node 与浏览器共用同一份场景集。
 */
export function defineScenario(name, fn, meta = {}) {
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
}
