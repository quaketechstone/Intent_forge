/**
 * Intent Bus 类型定义（IB-A / IB-B 共用）。
 *
 * 本文件只有类型与常量，无任何运行时副作用。
 * 契约来源：docs/PROTOCOL.md §2（信封）、§4（错误模型）。
 *
 * 修改本文件视为契约变更，须走 docs/CONSTITUTION.md 第 24 条。
 */
/**
 * 17 个错误码的**单一来源**。
 *
 * 顺序与 PROTOCOL.md §4 的错误码表一致；新增码必须同时更新协议文档，
 * 否则 `contract.test.ts` 的码表断言会失败。
 */
export const BUS_ERROR_CODES = [
    'BUS_MALFORMED',
    'BUS_VERSION_UNSUPPORTED',
    'BUS_IDENTITY_SPOOF',
    'BUS_DENIED',
    'BUS_UNAVAILABLE',
    'BUS_NO_ROUTE',
    'BUS_PEER_GONE',
    'BUS_TIMEOUT',
    'BUS_CANCELLED',
    'BUS_BACKPRESSURE',
    'BUS_PAYLOAD_TOO_LARGE',
    'BUS_HANDLER_ERROR',
    'BUS_SUBSCRIBER_ERROR',
    'BUS_DUPLICATE_REPLY',
    'BUS_NOT_READY',
    'BUS_CLOSED',
    'BUS_OP_UNAVAILABLE',
];
