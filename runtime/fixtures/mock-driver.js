/**
 * 模拟驱动（fixture）。
 *
 * 「模拟」指**被测驱动的替身**，不是模拟总线——总线始终是真实 `createBus`。
 * 替身只负责提供可控的处理器行为（回显、慢响应、抛错），便于验证总线契约。
 */
export function mockDriver(id, opts = {}) {
    var _a;
    return {
        moduleId: id,
        trust: (_a = opts.trust) !== null && _a !== void 0 ? _a : 'remote',
        ...(opts.declared ? { declared: opts.declared } : {}),
        ...(opts.handlers ? { handlers: opts.handlers } : {}),
        ...(opts.label ? { label: opts.label } : {}),
    };
}
/** 标准 `room.create` 处理器：回显请求并返回固定 id。 */
export const roomCreateHandler = (payload) => ({
    id: 'room-1',
    echo: payload,
});
/** 一组按 capability 命名的常用处理器：echo / slow / fail。 */
export function echoHandlers(capability = 'room') {
    return {
        [`${capability}.echo`]: (payload) => ({ echo: payload }),
        [`${capability}.slow`]: () => new Promise((resolve) => {
            setTimeout(() => resolve({ slow: true }), 50);
        }),
        [`${capability}.fail`]: () => {
            throw new Error('mock driver failure');
        },
    };
}
