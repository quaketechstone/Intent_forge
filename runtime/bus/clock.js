/**
 * 可注入时钟（IB-A / IB-B 共用）。
 *
 * 单独成文件是为了打断 `runtime.ts ⇄ audit.ts` 的循环：两者都需要时钟，
 * 若时钟定义在 runtime 里，audit 就得反向 import runtime，形成环。
 * 依赖方向保持：`clock ← ports ← audit ← runtime`。
 */
export const systemClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
};
