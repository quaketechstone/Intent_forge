/**
 * 故障注入器。
 *
 * 所有故障都通过公开 API 施加（`handle` / `unregister` / `revoke` / `register`），
 * 不修改总线、不伪造身份。注入后必须**可观测**——场景要断言到对应错误码，
 * 否则该故障记录只是噪声（见 docs/TROUBLESHOOTING.md）。
 */
export class FaultInjector {
    constructor(harness) {
        this.harness = harness;
    }
    /** 处理器挂起：配合短 `deadlineMs` 观测 BUS_TIMEOUT。 */
    timeout(driver, op) {
        return this.harness.injectFault({ type: 'timeout', driver, op });
    }
    /** 撤销端点：新收发一律 BUS_DENIED。 */
    deny(driver) {
        return this.harness.injectFault({ type: 'revoke', driver });
    }
    /** 处理器抛错：观测 BUS_HANDLER_ERROR。 */
    crash(driver, op) {
        return this.harness.injectFault({ type: 'handler-error', driver, op });
    }
    /** 接收方退出：在飞与后续命令观测 BUS_PEER_GONE。 */
    exit(driver) {
        return this.harness.injectFault({ type: 'peer-gone', driver });
    }
    /** 退出后以新 nonce 重启：旧在飞 PEER_GONE，新请求恢复。 */
    restart(driver) {
        return this.harness.injectFault({ type: 'exit-restart', driver });
    }
}
