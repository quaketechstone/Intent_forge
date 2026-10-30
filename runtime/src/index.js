/**
 * Intent Bus Test SDK —— 公开入口。
 *
 * 版本策略：SDK 独立语义化版本（`SDK_VERSION`），与总线版本解耦。
 * 1.0 之前 minor 变更可能含破坏性调整；证据 schema 单独用
 * `EVIDENCE_SCHEMA` 标识，形状变更时递增。
 */
export { createTestHarness, runSuite, grantsFor } from './harness.js';
export { defineScenario } from './scenario.js';
export { expectResult, expectEvent } from './assertions.js';
export { FaultInjector } from './fault.js';
export { SDK_VERSION, EVIDENCE_SCHEMA, SDK_BUS_BASELINE } from './types.js';
