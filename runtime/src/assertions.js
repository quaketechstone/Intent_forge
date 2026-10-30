/**
 * 断言函数式入口。
 *
 * 与 `harness.expectResult` / `harness.expectEvent` 完全等价，只是把
 * harness 作为第一个参数，方便在纯函数式场景或自定义 DSL 中调用。
 */
export function expectResult(harness, promise, expected, label) {
    return harness.expectResult(promise, expected, label);
}
export function expectEvent(harness, topic, opts, label) {
    return harness.expectEvent(topic, opts, label);
}
