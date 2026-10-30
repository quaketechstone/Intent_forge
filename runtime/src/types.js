/**
 * Intent Bus Test SDK —— 公开类型定义。
 *
 * 设计原则：
 *   - 所有类型都从总线的**公开类型**派生或结构化对齐，不 import 内部模块。
 *   - 报告状态五态分离：pass / fail / skip / unverified / contract-pending。
 *     「未验证」与「契约待决」不得被折叠成 pass。
 *   - 证据带 schema 版本，形状变更必须升版，避免下游静默误读。
 */
/** SDK 语义化版本（与总线版本独立演进）。 */
export const SDK_VERSION = '0.4.0';
/** 证据 JSON 的 schema 标识；破坏性变更时递增。 */
export const EVIDENCE_SCHEMA = 'intent-bus-test-evidence/v1';
/** SDK 针对的总线交付基线（仅为证据默认值，运行时可覆盖）。 */
export const SDK_BUS_BASELINE = '357ce1c';
