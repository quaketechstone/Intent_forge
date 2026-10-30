/**
 * Intent Bus 对外入口。
 *
 * 只导出 `createBus` 与类型。**不导出** `decide` / `buildGrantTable` /
 * `validateEnvelope` 等内部函数——它们属 IB-A，驱动不该直接调。
 * 一旦导出，有人会绕过 `ctx.bus` 直接用，绕过即意味着绕过审计与状态机。
 *
 * 装配方式见 docs/ARCHITECTURE.md §10、DECISIONS.md D-03。
 */
export { createBus, DEFAULT_LIMITS } from './runtime.js';
export { createAuditSink, AUDIT_DEFAULTS } from './audit.js';
export { createMemoryAuditStore, runAuditStoreConformance } from './audit-store.js';
/**
 * 治理事件（`bus:` 命名空间，O-18）。
 *
 * `BUS_SELF_ID` 与 `GOVERNANCE_TOPICS` 必须导出：门需要知道订阅哪些主题、
 * 以及"总线说的"这个 `from` 值长什么样。其余（限流器、投递队列）不导出——
 * 它们是总线内部实现，导出去只会诱使别人自己造一条旁路。
 */
export { BUS_SELF_ID, GOVERNANCE_TOPICS } from './governance.js';
export { BUS_ERROR_CODES } from './types.js';
