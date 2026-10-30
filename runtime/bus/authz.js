/**
 * IB-A：授权判定（纯函数层）。
 *
 * 与 `contract.ts` 的分工：那边管"信封长得对不对"，这边管"这个人能不能做这件事"。
 * 本文件同样**不得**出现任何副作用；时间由调用方传入。
 *
 * 契约来源：
 *   docs/ARCHITECTURE.md §4.2（Grant 结构）、§4.3（三层判定，v1 启用前两层）
 *   docs/SECURITY_MODEL.md §4.1（三类授权分离）、§4.2（command 表为空）、
 *                          §4.3（门可订阅 bus:）、§4.4（sensitive 不启用）
 *   docs/PROTOCOL.md §4（BUS_DENIED / BUS_UNAVAILABLE / BUS_OP_UNAVAILABLE）
 *
 * 三条设计约束：
 *
 * 1. **默认拒绝**。空表拒绝一切。没有任何"表为空则放行"的兜底分支——
 *    那是这类系统最经典的越权口子。
 *
 * 2. **三类授权不合并**。`command` / `subscribe` / `sensitive` 各自独立匹配，
 *    不存在 `bus:*` 这种一把梭的权限。能订阅"房间列表变了"不等于能命令"建房间"。
 *
 * 3. **sensitive 在 v1 恒不可用**，即使调用方手工塞进一条 sensitive grant。
 *    这不是"允许但不检查"，是显式拒绝（SECURITY_MODEL.md §4.4）。
 */
import { busError, validateEndpointId, validateOperation, validateTopic } from './contract.js';
/**
 * 声明规模上限。
 *
 * 为什么要有：声明来自 manifest，而 manifest 是驱动提供的文件。没有上限的话，
 * 一个 10MB 的 manifest 可以塞进十万条 grant，把授权匹配变成 O(n) 的 DoS 面。
 * 上限取小值——真实驱动的授权需求是几条到十几条，不是几百条。
 */
export const DECLARATION_LIMITS = {
    maxCommandEntries: 16,
    maxOpsPerEntry: 16,
    maxTopicPrefixes: 16,
};
/**
 * 把声明转成 grant。
 *
 * **整条声明全对才生效，任何一项非法则整条作废**。不做部分生效——
 * "我声明了 5 条、实际生效 3 条"这种静默部分成功，排查起来比全失败难十倍。
 *
 * @param subject 被授予方（`trust` 必须是 loader 判定的结果，不可自报）
 * @param declared 清单声明。`undefined` = 未声明 = 无授权
 */
export function grantsFromDeclaration(subject, declared) {
    if (!declared)
        return { ok: true, grants: [] };
    const grants = [];
    const push = (kind, target, operations) => {
        grants.push({
            grantId: `g:decl:${subject.id}:${kind}:${target}`,
            subject: subject.id,
            kind,
            target,
            operations,
        });
    };
    // ---- command ----
    if (declared.command !== undefined) {
        if (!Array.isArray(declared.command))
            return { ok: false, reason: 'bus.command must be an array' };
        if (declared.command.length > DECLARATION_LIMITS.maxCommandEntries) {
            return { ok: false, reason: `bus.command exceeds ${DECLARATION_LIMITS.maxCommandEntries} entries` };
        }
        for (const entry of declared.command) {
            if (!entry || typeof entry !== 'object')
                return { ok: false, reason: 'bus.command entry must be an object' };
            if (!validateEndpointId(entry.target)) {
                return { ok: false, reason: `bus.command target is not a valid endpoint id: ${String(entry.target)}` };
            }
            // 声明来自外部文件，运行时形状不可信：先按 unknown 收窄再逐项验
            const rawOps = entry.ops;
            if (!Array.isArray(rawOps) || rawOps.length === 0) {
                return { ok: false, reason: 'bus.command ops must be a non-empty array' };
            }
            if (rawOps.length > DECLARATION_LIMITS.maxOpsPerEntry) {
                return { ok: false, reason: `bus.command ops exceeds ${DECLARATION_LIMITS.maxOpsPerEntry}` };
            }
            const ops = [];
            for (const op of rawOps) {
                if (typeof op !== 'string' || !validateOperation(op)) {
                    return { ok: false, reason: `bus.command op is not valid: ${String(op)}` };
                }
                // 去重但不排序：保持声明顺序，便于对照 manifest 原文排障
                if (!ops.includes(op))
                    ops.push(op);
            }
            push('command', entry.target, ops);
        }
    }
    // ---- subscribe / publish ----
    for (const kind of ['subscribe', 'publish']) {
        const list = declared[kind];
        if (list === undefined)
            continue;
        if (!Array.isArray(list))
            return { ok: false, reason: `bus.${kind} must be an array` };
        if (list.length > DECLARATION_LIMITS.maxTopicPrefixes) {
            return { ok: false, reason: `bus.${kind} exceeds ${DECLARATION_LIMITS.maxTopicPrefixes} prefixes` };
        }
        for (const prefix of list) {
            if (!validTopicPrefix(prefix)) {
                return { ok: false, reason: `bus.${kind} prefix is not valid: ${String(prefix)}` };
            }
            // `bus:` 是总线的治理命名空间。允许驱动声明它 = 允许伪造治理事件
            // （发布侧）或偷看全局拒绝记录（订阅侧），两条都不能开
            if (prefix === 'bus:' || prefix.startsWith('bus:')) {
                return { ok: false, reason: `bus.${kind} must not target the reserved prefix bus:` };
            }
            push(kind, prefix, []);
        }
    }
    return { ok: true, grants };
}
/**
 * 主题前缀合法性。
 *
 * 两种形态都接受：`room:`（纯前缀，覆盖其下全部）与 `room:members-changed`
 * （精确主题）。不接受 `room`（无冒号）——那会让 `roomService:x` 被误匹配。
 */
function validTopicPrefix(prefix) {
    if (typeof prefix !== 'string' || prefix.length === 0)
        return false;
    if (prefix.endsWith(':'))
        return /^[a-z][a-z0-9-]*:$/.test(prefix);
    return validateTopic(prefix);
}
/** 安全驱动 moduleId。它有一条出厂订阅授权（SECURITY_MODEL.md §4.3） */
export const GATE_MODULE_ID = 'intent.sec.kernel';
/**
 * 由清单推导授权表。
 *
 * v1 只有一条出厂授权：安全门可订阅 `bus:` 前缀——门需要知道"谁在什么时候被拒"，
 * 否则治理无法闭环。但它**只能订阅、不能命令**，且必须是 builtin 信任级。
 *
 * **没有 `publish` 授权**（O-17 / DECISIONS.md D-06）：v1 没有合法的事件发布者，
 * 出厂表也就没有一条 publish grant。`publish` 在无授权时**同步抛 BUS_DENIED**，
 * 不静默丢弃——静默丢弃会让"事件没送到"和"根本没发出去"永远分不清。
 * 未来开放事件时，授权必须随 manifest 声明下发，而不是在这里硬编码业务主题。
 *
 * 为什么其余为空：真实授权应由 manifest 声明产生，而母体 manifest 当前**没有**
 * 总线授权字段（`web/src/loader/types.ts` 的 `Manifest` 只有 `capabilities`，
 * 那是 log/kv/http 能力，与总线授权是两回事）。补字段属母体契约变更
 * （INTEGRATION_CONTRACT.md A-1）。在字段落地前，这里不硬编码任何业务授权——
 * 硬编码业务授权等于把策略写死在基础设施里，正是 D-01 要避免的双策略源。
 *
 * @param subject 被授予方。`trust` 必须是 loader 判定的结果，不可由驱动自报
 */
export function buildGrantTable(subject, declared) {
    return resolveGrants(subject, declared).grants;
}
/**
 * 带诊断的授权表推导。运行时用这个，因为"声明被拒"必须留痕。
 *
 * 与 `buildGrantTable` 的关系：后者是它的薄包装（只取 `grants`）。
 * 分成两个函数而不是让返回值变复杂，是因为 `grantsFor` 注入点的类型
 * （`(subject) => readonly Grant[]`）已经被测试与装配层使用，不该为了
 * 一个诊断字段改签名。
 */
export function resolveGrants(subject, declared) {
    const grants = [];
    // ---- 出厂规则：门可订阅 `bus:` 治理命名空间 ----
    if (subject.id === GATE_MODULE_ID && subject.trust === 'builtin') {
        grants.push({
            grantId: 'g:sec.observe-bus',
            subject: subject.id,
            kind: 'subscribe',
            target: 'bus:',
            operations: [],
        });
    }
    if (declared === undefined)
        return { grants };
    // ---- 信任边界：remote 的声明一律不生效 ----
    //
    // 这是本提案最关键的一条。`declared` 来自驱动自己写的 manifest，
    // 把它当授权就是 O-17 的翻版——驱动自报"我可以给 room.service 发消息"，
    // 然后真的可以了。要开放 remote，必须先有策略复核（母体白名单或门判定），
    // 那不在 v1 范围（MANIFEST_BUS_GRANT_PROPOSAL.md §4）。
    //
    // 为什么不是"降级生效"或"部分生效"：任何形式的自报生效都需要一条
    // "什么算可信自报"的判据，而 v1 没有这条判据。没有判据时唯一安全的选择
    // 是不生效——并明确告诉调用方为什么不生效（`rejected`），而不是静默。
    if (subject.trust !== 'builtin') {
        return {
            grants,
            rejected: 'declaration ignored: trust!=builtin requires policy review (not in v1)',
        };
    }
    const result = grantsFromDeclaration(subject, declared);
    if (!result.ok) {
        return { grants, rejected: result.reason };
    }
    return { grants: [...grants, ...result.grants] };
}
/**
 * 授权判定。
 *
 * 顺序有讲究：
 *   1. sensitive 先短路 → UNAVAILABLE。即使表里被塞进 sensitive grant 也不放行。
 *   2. 逐条匹配关系（subject / kind / target / operation / 过期）。
 *   3. 命中后检查该 grant 的 payloadMax（单次属性，不累计）。
 *   4. 全不命中 → DENY。
 *
 * 速率配额不在这里算——它依赖调用历史，属于 IB-B 的有状态部分，
 * 由 `remainingQuota` 提供纯算术内核。
 *
 * @param grants 该 subject 的授权表，通常来自 `buildGrantTable`
 * @param req 判定请求
 * @param now epoch ms，由调用方传入以保持纯函数
 */
export function decide(grants, req, now) {
    var _a, _b;
    if (req.kind === 'sensitive') {
        return {
            status: 'UNAVAILABLE',
            error: busError('BUS_OP_UNAVAILABLE', 'sensitive access is not enabled in v1', {
                namespace: req.namespace,
            }),
        };
    }
    for (const grant of grants) {
        if (!matches(grant, req, now))
            continue;
        if (req.kind === 'command' && ((_a = grant.limits) === null || _a === void 0 ? void 0 : _a.payloadMax) !== undefined) {
            const bytes = (_b = req.payloadBytes) !== null && _b !== void 0 ? _b : 0;
            if (bytes > grant.limits.payloadMax) {
                return {
                    status: 'DENY',
                    error: busError('BUS_PAYLOAD_TOO_LARGE', 'payload exceeds grant limit', {
                        limit: grant.limits.payloadMax,
                        actual: bytes,
                    }),
                };
            }
        }
        return { status: 'ALLOW', grantId: grant.grantId };
    }
    return {
        status: 'DENY',
        error: busError('BUS_DENIED', 'no grant matches this request', { kind: req.kind }),
    };
}
/**
 * 主题前缀匹配。
 *
 * 必须防 `bus` 误匹配 `busy:x` —— 裸 `startsWith` 会放过它，
 * 而 `busy:` 完全可能是另一个合法前缀。规则：前缀不以 `:` 结尾时，
 * 要求主题在切分处恰好是 `:`。
 */
function matchTopicPrefix(topic, prefix) {
    if (topic === prefix)
        return true;
    if (!topic.startsWith(prefix))
        return false;
    if (prefix.endsWith(':'))
        return true;
    return topic.charAt(prefix.length) === ':';
}
function matches(grant, req, now) {
    if (grant.subject !== req.subject)
        return false;
    if (grant.kind !== req.kind)
        return false;
    if (grant.expiresAt !== undefined && now >= grant.expiresAt)
        return false;
    if (req.kind === 'command') {
        if (grant.target !== req.target)
            return false;
        return grant.operations.includes(req.operation);
    }
    if (req.kind === 'subscribe' || req.kind === 'publish') {
        return matchTopicPrefix(req.topic, grant.target);
    }
    // sensitive 在 decide 开头已短路，走到这里说明被新 kind 绕过，一律拒绝
    return false;
}
/**
 * 速率配额（纯算术）。
 *
 * fail-closed 的两个点：
 *   - 配置非法（负数 / NaN / Infinity）→ 当作 0，即禁用
 *   - 用量非法（负数 / NaN）→ 当作已耗尽
 * 这两种都是配置或统计出错，宁可拒绝也不放行。
 *
 * `perMinute: 0` 是合法配置，语义为"禁用"——与"未配置"（不限）必须区分开。
 */
export function remainingQuota(usage, limits) {
    const limit = normalizeLimit(limits === null || limits === void 0 ? void 0 : limits.perMinute);
    if (limit === null) {
        return { allowed: true, limit: null, remaining: null };
    }
    const used = normalizeUsage(usage.perMinute);
    if (used >= limit) {
        return { allowed: false, limit, remaining: 0, reason: 'rate' };
    }
    return { allowed: true, limit, remaining: limit - used };
}
function normalizeLimit(value) {
    if (value === undefined)
        return null;
    if (!Number.isFinite(value) || value < 0)
        return 0;
    return Math.floor(value);
}
function normalizeUsage(value) {
    if (!Number.isFinite(value) || value < 0)
        return Number.POSITIVE_INFINITY;
    return Math.floor(value);
}
