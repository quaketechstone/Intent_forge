/**
 * IB-A：Intent Bus 最小安全原语（纯函数层）。
 *
 * 本文件**不得**出现任何副作用：无 fetch / setTimeout / indexedDB / Date.now，
 * 不 import 任何含副作用的模块。时间由调用方传入，便于测试。
 * 自我约束照抄 web/src/loader/contract.ts:1-6。
 *
 * 契约来源：docs/PROTOCOL.md §2（信封字段规则）、§4（错误模型）、
 *           docs/ARCHITECTURE.md §8（限额常量）。
 *
 * 本文件负责：BUS_LIMITS / busError / isBusError / validateTopic /
 * validateOperation / validateEnvelope——即"信封长得对不对"。
 *
 * 授权判定（"这个人能不能做这件事"）在 `authz.ts`，那边 import 本文件的
 * `busError`，本文件不反向 import，依赖图无环。
 */
import { BUS_ERROR_CODES } from './types.js';
/**
 * 限额常量（单一来源）。
 *
 * 数值为工程判断而非实测结论；首次施工后须用真实场景校准，
 * 校准结果写入 docs/IMPLEMENTATION_PLAN.md 的阶段报告。
 */
export const BUS_LIMITS = {
    /** 信封序列化后上限；超过即 BUS_PAYLOAD_TOO_LARGE */
    envelopeMaxBytes: 64 * 1024,
    /** 每端点 FIFO 上限，满则拒（不丢） */
    queueMax: 64,
    /** 命令默认超时 */
    defaultDeadlineMs: 5000,
    /** 命令超时上限：总线不该承载长任务 */
    maxDeadlineMs: 30000,
    /** 主题标识符长度上限 */
    topicMaxLen: 64,
    /** 每端点订阅数上限 */
    subscriptionsPerEndpoint: 32,
    /** 每端点每分钟命令数上限 */
    commandsPerMinute: 120,
};
/* ------------------------------------------------------------------ *
 * 形态正则
 * ------------------------------------------------------------------ */
/** 与 web/src/loader/contract.ts:34 的 ID_RE 保持一致（反向域名，至少两段） */
const ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
/**
 * 端点 id 正则的源码形式，供测试与母体 `ID_RE` 做**防漂移断言**。
 *
 * 两处正则必须逐字相同：总线用自己的一份是为了不把 loader 的模块依赖
 * 拖进 IB-A，但两份分裂会让"总线认的 id"与"loader 认的 id"不一致，
 * 出现能装载却无法投递的端点。`contract.test.ts` B9 会读母体源码比对。
 */
export const ENDPOINT_ID_PATTERN = ID_RE.source;
/** uuid v4：版本位 4，变体位 8/9/a/b */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** 主题：`ns:name` 两段式，小写 */
const TOPIC_RE = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;
/** 操作名：`capability.action` 两段式，小写 */
const OP_RE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
const KINDS = ['command', 'reply', 'event', 'cancel'];
/* ------------------------------------------------------------------ *
 * 错误构造
 * ------------------------------------------------------------------ */
/**
 * 构造总线错误。
 *
 * `message` 必须是固定文案，**不得**拼接 payload 内容——否则业务数据会随错误
 * 流向审计日志与调用方。
 */
export function busError(code, message, detail, corr) {
    const err = { code, message };
    if (detail !== undefined)
        err.detail = detail;
    if (corr !== undefined)
        err.corr = corr;
    return err;
}
/**
 * 类型守卫：区分 `Envelope | BusError` 联合。
 *
 * 判别依据是 `code` 是否为已知错误码——不用 `kind` 的存在性，
 * 因为畸形输入可能两者都没有，那样守卫会静默返回 false。
 */
export function isBusError(value) {
    const code = value.code;
    return typeof code === 'string' && BUS_ERROR_CODES.includes(code);
}
/** 判定某个值是否为合法错误码 */
export function isBusErrorCode(value) {
    return typeof value === 'string' && BUS_ERROR_CODES.includes(value);
}
/* ------------------------------------------------------------------ *
 * 单项校验（导出以便单独测试与复用）
 * ------------------------------------------------------------------ */
/** 主题合法性：`ns:name`，两段小写，总长 ≤ topicMaxLen */
export function validateTopic(topic) {
    return (typeof topic === 'string' &&
        topic.length <= BUS_LIMITS.topicMaxLen &&
        TOPIC_RE.test(topic));
}
/** 操作名合法性：`capability.action` */
export function validateOperation(op) {
    return typeof op === 'string' && OP_RE.test(op);
}
/** 端点 id 合法性：反向域名，至少两段（与 manifest.id 同规则） */
export function validateEndpointId(id) {
    return typeof id === 'string' && ID_RE.test(id);
}
/* ------------------------------------------------------------------ *
 * 序列化体检
 * ------------------------------------------------------------------ */
/**
 * 递归检查值是否可无损 JSON 序列化，返回首个违规路径；合法返回 null。
 *
 * 为什么不能只靠 `JSON.stringify` 的 try/catch：
 * `{ a: undefined }`、`[undefined]`、`{ a: NaN }` 都不会抛错，而是被**静默改写**
 * （丢弃键 / 转 null）。对总线来说静默改写比报错危险——发送方以为发出去了 A，
 * 接收方收到的是 B。因此这些情况一律判 MALFORMED。
 *
 * `Date` / `Map` / `Set` 按 PROTOCOL.md §2.2 明确禁止：它们会被序列化成
 * 字符串或空对象，语义丢失。
 */
/**
 * payload 结构深度上限。
 *
 * `findUnserializable` 是递归实现，`JSON.stringify` 也是。深度不设上限时，
 * 一个 5000 层的 `{a:{a:{...}}}` 就能让两者一起栈溢出（实测 `RangeError:
 * Maximum call stack size exceeded`，见 BUS-NEST-1）。这不是"输入太大"，
 * 是"输入形状能让校验器自己崩"——校验器崩了就等于没有校验。
 *
 * 128 的依据：真实驱动 payload 的结构深度极少超过 20（IM 消息最深的
 * `{room,msg:{meta:{...}}}` 约 5 层），128 给足余量，同时远低于栈溢出阈值。
 * 超限不静默截断、不静默丢弃，直接判 MALFORMED——发送方必须知道自己的载荷
 * 被拒了，而不是收到一个"看起来成功"的结果。
 */
export const PAYLOAD_MAX_DEPTH = 128;
function findUnserializable(value, seen, path, depth = 0) {
    // 深度超限：返回路径而非抛错。抛错会让"校验"本身变成攻击面
    if (depth > PAYLOAD_MAX_DEPTH)
        return path;
    if (value === null)
        return null;
    const t = typeof value;
    if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint')
        return path;
    if (t === 'number')
        return Number.isFinite(value) ? null : path;
    if (t !== 'object')
        return null;
    const obj = value;
    const tag = Object.prototype.toString.call(obj);
    if (tag === '[object Date]' || tag === '[object Map]' || tag === '[object Set]')
        return path;
    // 循环引用：JSON.stringify 会抛错，这里提前拦下并给出路径
    if (seen.has(obj))
        return path;
    seen.add(obj);
    if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i += 1) {
            const bad = findUnserializable(obj[i], seen, `${path}[${i}]`, depth + 1);
            if (bad !== null)
                return bad;
        }
        return null;
    }
    for (const key of Object.keys(obj)) {
        const bad = findUnserializable(obj[key], seen, `${path}.${key}`, depth + 1);
        if (bad !== null)
            return bad;
    }
    return null;
}
/**
 * UTF-8 字节数（信封限额按字节而非字符计）。
 *
 * 不用 `TextEncoder`：那是环境 API（DOM / Node / Worker 各自提供），
 * 会让 IB-A 多一条对宿主环境的隐式依赖。这里只做纯计算。
 *
 * 输入必须是**已序列化**的 JSON 文本——此时孤立代理项已被 `JSON.stringify`
 * 转义成 `\udXXX` 六个 ASCII 字符，按码元逐个累加即得真实字节数。
 */
function utf8Bytes(text) {
    let bytes = 0;
    for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (code < 0x80) {
            bytes += 1;
        }
        else if (code < 0x800) {
            bytes += 2;
        }
        else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
            // 高位代理：与随后的低位代理组成一个 4 字节字符
            const next = text.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                bytes += 4;
                i += 1;
            }
            else {
                bytes += 3;
            }
        }
        else {
            bytes += 3;
        }
    }
    return bytes;
}
/** 错误对象形状校验：reply.error 必须是合法 BusError */
function isBusErrorShape(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const v = value;
    if (!isBusErrorCode(v.code))
        return false;
    if (typeof v.message !== 'string' || v.message.length === 0)
        return false;
    if (v.detail !== undefined && (typeof v.detail !== 'object' || v.detail === null))
        return false;
    if (v.corr !== undefined && typeof v.corr !== 'string')
        return false;
    return true;
}
/* ------------------------------------------------------------------ *
 * 载荷校验（两条投递路径共用）
 * ------------------------------------------------------------------ */
/**
 * payload 载荷校验：可序列化性 + UTF-8 字节上限。
 *
 * 抽成独立导出，是因为**两条投递路径必须共用同一实现**：
 *   - `command()` 走 `validateEnvelope()`，第 9 步调用本函数
 *   - `publish()` 手工构造 `BusEvent`，不经过信封校验，必须显式调用本函数
 *
 * 曾经 `publish()` 漏调，64 KiB 上限只对 `command()` 生效（BUS-LIMIT-1，
 * 见 Driver-forge/docs/ca/CA-BUS-LIMIT-1.md）。抽到这里之后，"新增一条
 * 投递路径"不可能再忘——因为不存在第二份实现可忘。
 *
 * 判定口径（与 `contract.ts` 的 `envelopeMaxBytes` 注释一致）：
 * **按 `JSON.stringify` 后的 UTF-8 字节数**，不是字符数。中文一个字 3 字节，
 * 孤立代理项被转义成 `\udXXX` 六个 ASCII 字符——都按真实字节计。
 *
 * @returns 违规时返回 `BusError`；通过时返回 `null`
 */
export function checkPayload(payload, stage = 'payload') {
    var _a;
    // undefined 视为未提供（与信封其他可选字段一致），不当作违规
    if (payload === undefined)
        return null;
    const bad = findUnserializable(payload, new WeakSet(), stage);
    if (bad !== null) {
        return busError('BUS_MALFORMED', 'payload is not losslessly JSON-serializable', {
            stage,
            path: bad,
        });
    }
    let serialized;
    try {
        serialized = (_a = JSON.stringify(payload)) !== null && _a !== void 0 ? _a : '';
    }
    catch {
        // 理论上已被 findUnserializable 拦住，兜底防回归
        return busError('BUS_MALFORMED', 'payload is not serializable', { stage });
    }
    const bytes = utf8Bytes(serialized);
    if (bytes > BUS_LIMITS.envelopeMaxBytes) {
        return busError('BUS_PAYLOAD_TOO_LARGE', 'payload exceeds envelopeMaxBytes', {
            stage,
            limit: BUS_LIMITS.envelopeMaxBytes,
            received: bytes,
        });
    }
    return null;
}
/* ------------------------------------------------------------------ *
 * 信封校验
 * ------------------------------------------------------------------ */
/**
 * 校验并规范化信封。
 *
 * 三条不可动摇的设计决定：
 *
 * 1. **`from` 恒取自 `boundFrom`。** 输入里的 `from` 只用于检测伪造，永不采纳。
 *    `boundFrom` 必须来自调用方闭包绑定的身份，**不得**来自可被驱动改写的
 *    `ctx.id`（见 DECISIONS.md D-03 ②）。
 *
 * 2. **只输出白名单字段。** 输入里的未知字段一律丢弃，不透传给下游。
 *    否则调用方可以夹带字段影响路由或审计。
 *
 * 3. **校验顺序固定**：对象形态 → 版本 → 基础字段 → 身份 → kind 专属字段 → payload。
 *    版本先于字段，是因为不同版本字段集可能不同，先报 VERSION_UNSUPPORTED
 *    比报一堆 MALFORMED 更有诊断价值。
 *
 * @param input     待校验的原始值（驱动传入，完全不可信）
 * @param boundFrom 该端点绑定的模块 id，来自闭包
 */
export function validateEnvelope(input, boundFrom) {
    // 0. 绑定身份本身必须合法：闭包给错值时，后续一切判断都无意义
    if (!validateEndpointId(boundFrom)) {
        return busError('BUS_MALFORMED', 'bound identity is not a valid module id', {
            stage: 'bound_from',
        });
    }
    // 1. 必须是普通对象（数组、null、原始值一律拒绝）
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return busError('BUS_MALFORMED', 'envelope must be a plain object', {
            stage: 'shape',
            received: input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input,
        });
    }
    const raw = input;
    // 2. 版本：缺失算结构不完整，存在但不等于 1 才算版本不支持
    if (raw.v === undefined) {
        return busError('BUS_MALFORMED', 'envelope.v is required', { stage: 'version' });
    }
    if (raw.v !== 1) {
        return busError('BUS_VERSION_UNSUPPORTED', 'unsupported envelope version', {
            stage: 'version',
            expected: 1,
            received: raw.v,
        });
    }
    // 3. id：uuid v4
    if (typeof raw.id !== 'string' || !UUID_V4_RE.test(raw.id)) {
        return busError('BUS_MALFORMED', 'envelope.id must be a uuid v4', { stage: 'id' });
    }
    // 4. ts：有限正数。只校验形态——IB-A 不读时钟，无法判断"是否未来时间"
    if (typeof raw.ts !== 'number' || !Number.isFinite(raw.ts) || raw.ts <= 0) {
        return busError('BUS_MALFORMED', 'envelope.ts must be a positive finite number', {
            stage: 'ts',
        });
    }
    // 5. kind：四值之一
    if (typeof raw.kind !== 'string' || !KINDS.includes(raw.kind)) {
        return busError('BUS_MALFORMED', 'envelope.kind must be one of command|reply|event|cancel', {
            stage: 'kind',
        });
    }
    const kind = raw.kind;
    // 6. from：伪造检测。空值视为未提供（由总线填充），非空必须等于绑定身份
    if (raw.from !== undefined && raw.from !== null && raw.from !== '') {
        if (typeof raw.from !== 'string') {
            return busError('BUS_MALFORMED', 'envelope.from must be a string when provided', {
                stage: 'from',
            });
        }
        if (raw.from !== boundFrom) {
            // 这是攻击信号，不是普通错误：调用方试图冒充其他端点
            return busError('BUS_IDENTITY_SPOOF', 'envelope.from does not match bound identity', {
                stage: 'from',
                claimed: raw.from,
                bound: boundFrom,
            });
        }
    }
    // 7. kind 专属字段
    const out = { v: 1, id: raw.id, ts: raw.ts, kind, from: boundFrom };
    switch (kind) {
        case 'command': {
            if (!validateEndpointId(raw.to)) {
                return busError('BUS_MALFORMED', 'command.to must be a valid endpoint id', {
                    stage: 'to',
                });
            }
            if (!validateOperation(raw.op)) {
                return busError('BUS_MALFORMED', 'command.op must match capability.action', {
                    stage: 'op',
                });
            }
            out.to = raw.to;
            out.op = raw.op;
            // command 不应携带 corr：corr 指向 command id，命令不能是某个命令的应答
            if (raw.corr !== undefined) {
                return busError('BUS_MALFORMED', 'command must not carry corr', { stage: 'corr' });
            }
            if (raw.deadline_ms !== undefined) {
                const d = raw.deadline_ms;
                if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0) {
                    return busError('BUS_MALFORMED', 'deadline_ms must be a positive finite number', {
                        stage: 'deadline_ms',
                    });
                }
                // 超过上限显式拒绝，不静默截断：静默改写会让调用方误判超时语义
                if (d > BUS_LIMITS.maxDeadlineMs) {
                    return busError('BUS_MALFORMED', 'deadline_ms exceeds maxDeadlineMs', {
                        stage: 'deadline_ms',
                        max: BUS_LIMITS.maxDeadlineMs,
                        received: d,
                    });
                }
                out.deadline_ms = d;
            }
            break;
        }
        case 'reply': {
            if (typeof raw.corr !== 'string' || !UUID_V4_RE.test(raw.corr)) {
                return busError('BUS_MALFORMED', 'reply.corr must be a uuid v4', { stage: 'corr' });
            }
            out.corr = raw.corr;
            // reply.to 由 IB-B 从在飞表回填；此处若提供则只校验形态
            if (raw.to !== undefined) {
                if (!validateEndpointId(raw.to)) {
                    return busError('BUS_MALFORMED', 'reply.to must be a valid endpoint id', {
                        stage: 'to',
                    });
                }
                out.to = raw.to;
            }
            if (raw.error !== undefined) {
                if (!isBusErrorShape(raw.error)) {
                    return busError('BUS_MALFORMED', 'reply.error is not a valid BusError', {
                        stage: 'error',
                    });
                }
                out.error = raw.error;
            }
            break;
        }
        case 'event': {
            if (!validateTopic(raw.topic)) {
                return busError('BUS_MALFORMED', 'event.topic must match ns:name and be <= 64 chars', {
                    stage: 'topic',
                });
            }
            out.topic = raw.topic;
            // 事件按主题投递，带 to 等于点对点，会绕过订阅授权
            if (raw.to !== undefined) {
                return busError('BUS_MALFORMED', 'event must not carry to', { stage: 'to' });
            }
            break;
        }
        case 'cancel': {
            if (typeof raw.corr !== 'string' || !UUID_V4_RE.test(raw.corr)) {
                return busError('BUS_MALFORMED', 'cancel.corr must be a uuid v4', { stage: 'corr' });
            }
            if (!validateEndpointId(raw.to)) {
                return busError('BUS_MALFORMED', 'cancel.to must be a valid endpoint id', { stage: 'to' });
            }
            out.corr = raw.corr;
            out.to = raw.to;
            break;
        }
    }
    // 8. error 只允许出现在 reply 上
    if (kind !== 'reply' && raw.error !== undefined) {
        return busError('BUS_MALFORMED', 'error is only allowed on reply', { stage: 'error' });
    }
    // 9. payload：可序列化性 + 字节上限（实现见 checkPayload，与 publish 共用）
    if (raw.payload !== undefined) {
        const payloadError = checkPayload(raw.payload);
        if (payloadError !== null)
            return payloadError;
        out.payload = raw.payload;
    }
    return out;
}
