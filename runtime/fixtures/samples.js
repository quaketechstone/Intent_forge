/**
 * 可复用的授权构造器。
 *
 * 这些授权经公开 `CreateBusOptions.grantsFor` 注入，**不是**绕过：
 * `grantsFor` 是总线为测试显式留的钩子（见 runtime.ts 的 CreateBusOptions
 * 注释）。信任边界测试必须改用 `useRealGrantRules: true`，走真实规则。
 */
/** command 授权：subject 可向 target 发指定 op。 */
export function cmdGrant(subject, target, ops) {
    return {
        grantId: `g:${subject}>${target}`,
        subject,
        kind: 'command',
        target,
        operations: [...ops],
    };
}
/** subscribe 授权：subject 可订阅以 prefix 开头的主题。 */
export function subGrant(subject, prefix) {
    return {
        grantId: `g:${subject}?${prefix}`,
        subject,
        kind: 'subscribe',
        target: prefix,
        operations: [],
    };
}
/** publish 授权：subject 可向以 prefix 开头的主题发布。 */
export function pubGrant(subject, prefix) {
    return {
        grantId: `g:${subject}!${prefix}`,
        subject,
        kind: 'publish',
        target: prefix,
        operations: [],
    };
}
/** 主场景集：两驱动互发、观察者订阅、发布授权齐备。 */
export function basicGrants() {
    return [
        cmdGrant('site.a', 'site.b', ['room.create']),
        cmdGrant('site.c', 'site.b', ['room.create']),
        subGrant('site.b', 'room:'),
        subGrant('test.observer', 'room:'),
        pubGrant('site.a', 'room:'),
        pubGrant('site.b', 'room:'),
    ];
}
/** 未授权场景：只有观察者的订阅授权，任何发送都应被拒。 */
export function unauthorizedGrants() {
    return [subGrant('test.observer', 'room:')];
}
