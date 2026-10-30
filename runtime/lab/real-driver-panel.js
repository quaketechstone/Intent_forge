/**
 * Lab 的「真实驱动」面板。
 *
 * 与 `lab.ts` 的分工相同：这里只做「人怎么用」——选驱动、配参数、装载/卸载、
 * 逐条跑场景、看请求响应与审计轨迹、导出证据包。测试语义全部在
 * `src/real-driver.ts` 与 `fixtures/real-driver-scenarios.ts`，本文件不另立判据。
 *
 * 自动化入口：`window.__lab.rd.*`，供 `scripts/e2e-real-driver.py` 在三引擎里调用。
 */
var _a;
import { createBus } from '../src/bus.js';
import { loadRealDriver, runRealDriverSuite } from '../src/real-driver.js';
import { grantsForRealDriverScenarios, realDriverScenarios } from '../fixtures/real-driver-scenarios.js';
/** 证据来源：人手点出来的是 human，脚本调出来的是 automated。两者不得混记。 */
let evidenceMode = 'human';
const state = {
    ready: false,
    error: null,
    pkg: null,
    intake: null,
    evidence: null,
    session: null,
    lastProbe: null,
    stepIndex: 0,
};
/** 取件时记录的总线提交；优先用 INTAKE.json 里的值，保证证据能对上是哪一版总线。 */
let busCommit = (_a = globalThis.__LAB_BUS_COMMIT__) !== null && _a !== void 0 ? _a : 'unknown';
function esc(v) {
    return String(v !== null && v !== void 0 ? v : '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
function setStatus(text, cls = '') {
    const node = document.getElementById('rd-status');
    if (!node)
        return;
    node.textContent = text;
    node.className = cls;
}
async function sha256Hex(data) {
    const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/**
 * 取件：从 Lab 运行目录读包内清单与入口，**按 INTAKE.json 的内容指纹逐字节校验**。
 * 校验不过就不装载——否则测的可能是另一份字节。
 */
async function init() {
    var _a;
    try {
        const base = new URL('../real-driver/', import.meta.url);
        const intakeRes = await fetch(new URL('INTAKE.json', base), { cache: 'no-store' });
        if (!intakeRes.ok)
            throw new Error(`INTAKE.json ${intakeRes.status}：未取件或未构建`);
        const intake = (await intakeRes.json());
        if ((_a = intake.baseline) === null || _a === void 0 ? void 0 : _a.busCommit)
            busCommit = intake.baseline.busCommit;
        const manifestRes = await fetch(new URL('pkg/manifest.json', base), { cache: 'no-store' });
        if (!manifestRes.ok)
            throw new Error(`manifest.json ${manifestRes.status}`);
        const manifest = await manifestRes.json();
        const entryUrl = new URL(`pkg/${intake.package.entryPath}`, base);
        const entryRes = await fetch(entryUrl, { cache: 'no-store' });
        if (!entryRes.ok)
            throw new Error(`入口 ${entryRes.status}`);
        const bytes = new Uint8Array(await entryRes.arrayBuffer());
        const sha = await sha256Hex(bytes);
        if (sha !== intake.package.entrySha256) {
            throw new Error(`入口哈希不符：now=${sha.slice(0, 16)} intake=${intake.package.entrySha256.slice(0, 16)}`);
        }
        state.pkg = {
            manifest,
            entryPath: intake.package.entryPath,
            entrySha256: intake.package.entrySha256,
            contentHash: intake.package.contentHash,
            bytes: intake.package.entryBytes,
            source: entryUrl.href,
        };
        state.intake = intake;
        state.ready = true;
        state.error = null;
        setStatus(`已取件 ${intake.package.id}@${intake.package.version}`, 'ok');
        renderMeta();
        renderScenarioList();
        return state;
    }
    catch (e) {
        state.ready = false;
        state.error = e instanceof Error ? e.message : String(e);
        setStatus(`取件失败：${state.error}`, 'fail');
        renderMeta();
        return state;
    }
}
/** 与生产同形的装载：把入口源码包成 blob URL 再 `import()`（母体 loader 同款）。 */
async function importFromBlob(input) {
    const href = String(input.href);
    const res = await fetch(href, { cache: 'no-store' });
    if (!res.ok)
        throw new Error(`入口不可读：${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const sha = await sha256Hex(bytes);
    if (state.pkg && sha !== state.pkg.entrySha256)
        throw new Error('装载前哈希复核失败');
    const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
    try {
        return (await import(/* @vite-ignore */ url));
    }
    finally {
        // 产物自包含（无子模块 import），装载后即可释放 blob URL
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }
}
function grantsMode() {
    const sel = document.getElementById('rd-grants');
    return (sel === null || sel === void 0 ? void 0 : sel.value) === 'strict' ? 'strict' : 'default';
}
function deadlineMs() {
    var _a;
    const input = document.getElementById('rd-deadline');
    const n = Number((_a = input === null || input === void 0 ? void 0 : input.value) !== null && _a !== void 0 ? _a : 500);
    return Number.isFinite(n) && n >= 100 ? n : 500;
}
/** 手工会话：装载 → 观察 → 探针 → 卸载。给人一步步看的状态。 */
async function loadSession() {
    if (!state.ready || !state.pkg)
        throw new Error('未取件');
    if (state.session)
        throw new Error('已有会话，请先卸载');
    // 授权模式与场景集保持一致：默认注入构造授权（探针能看到成功响应），
    // 严格模式走真实规则（探针会被 BUS_DENIED 拒掉）——两种都如实展示。
    const strict = grantsMode() === 'strict';
    const table = grantsForRealDriverScenarios(state.pkg.manifest.id);
    const bus = createBus({
        limits: { drainMs: 120 },
        ...(strict ? {} : { grantsFor: (subject) => table.filter((g) => g.subject === subject.id) }),
    });
    const handle = await loadRealDriver({
        bus,
        pkg: state.pkg,
        importModule: importFromBlob,
        log: (line) => {
            const box = document.getElementById('rd-log');
            if (box)
                box.textContent += `${line}\n`;
        },
    });
    const peer = bus.register({ moduleId: 'svc.echo', instanceNonce: `svc.echo#${Date.now().toString(36)}`, trust: 'remote' });
    peer.handle('echo.ping', (payload) => ({ pong: true, echo: payload }));
    state.session = { bus, handle, peer };
    renderMeta();
    renderTrace();
    return { describe: handle.describe(), record: handle.record };
}
async function unloadSession() {
    if (!state.session)
        return null;
    const { bus, handle } = state.session;
    const teardown = await handle.unload();
    // 对端是会话的一部分：会话结束时一并注销，残留检查才有意义
    bus.unregister('svc.echo');
    const afterSession = bus.stats();
    await bus.close();
    state.session = null;
    renderMeta();
    renderTrace();
    return {
        ...teardown,
        sessionEndpointsAfter: afterSession.endpoints,
        sessionPendingTimers: afterSession.pendingTimers,
    };
}
/** 探针：以驱动端点身份发一条命令，把请求/响应/错误原样摊开给人看。 */
async function probe() {
    if (!state.session)
        throw new Error('请先装载');
    const { handle } = state.session;
    const payload = { at: Date.now(), note: 'lab probe' };
    const request = { target: 'svc.echo', op: 'echo.ping', payload, deadlineMs: deadlineMs() };
    let response;
    try {
        response = { ok: true, value: await handle.ctx.bus.command('svc.echo', 'echo.ping', payload, { deadlineMs: deadlineMs() }) };
    }
    catch (e) {
        const err = e;
        response = { ok: false, code: err.code, message: err.message, detail: err.detail };
    }
    state.lastProbe = { request, response };
    renderMeta();
    renderTrace();
    return state.lastProbe;
}
function renderMeta() {
    var _a, _b, _c, _d;
    const box = document.getElementById('rd-meta');
    if (!box)
        return;
    if (!state.pkg) {
        box.innerHTML = `<p class="empty">${esc((_a = state.error) !== null && _a !== void 0 ? _a : '未取件：先执行 node scripts/intake-driver.mjs 再构建 Lab')}</p>`;
        return;
    }
    const m = state.pkg.manifest;
    const s = state.session;
    const describe = s ? s.handle.describe() : null;
    const stats = s ? s.bus.stats() : null;
    box.innerHTML = `
    <table>
      <tbody>
        <tr><th>驱动</th><td>${esc(m.id)}@${esc(m.version)} · ${esc((_b = m.name) !== null && _b !== void 0 ? _b : '')}</td></tr>
        <tr><th>入口</th><td>${esc(state.pkg.entryPath)} · ${esc(state.pkg.bytes)} B · sha256 <code>${esc(state.pkg.entrySha256.slice(0, 16))}…</code></td></tr>
        <tr><th>内容指纹</th><td><code>${esc(((_c = state.pkg.contentHash) !== null && _c !== void 0 ? _c : '').slice(0, 16))}…</code></td></tr>
        <tr><th>能力声明</th><td>${esc(((_d = m.capabilities) !== null && _d !== void 0 ? _d : []).join(', '))}</td></tr>
        <tr><th>总线声明</th><td>${m.bus ? esc(JSON.stringify(m.bus)) : '<span class="warn">无（manifest.bus 缺失）</span>'}</td></tr>
        <tr><th>会话</th><td>${s ? `已装载 · 端点 ${esc(stats === null || stats === void 0 ? void 0 : stats.endpoints)} · 在飞 ${esc(stats === null || stats === void 0 ? void 0 : stats.inflight)}` : '未装载'}</td></tr>
        <tr><th>驱动自述</th><td><code>${esc(describe ? JSON.stringify(describe) : 'null')}</code></td></tr>
      </tbody>
    </table>`;
}
function renderScenarioList() {
    const box = document.getElementById('rd-scenarios');
    if (!box)
        return;
    const sel = document.getElementById('rd-scenario');
    if (sel) {
        sel.innerHTML = realDriverScenarios
            .map((s) => `<option value="${esc(s.name)}">${esc(s.name)}${s.constructed ? ' [构造]' : ''}</option>`)
            .join('');
    }
    box.innerHTML = `<p class="hint">共 ${realDriverScenarios.length} 条场景：${realDriverScenarios.filter((s) => s.constructed).length} 条为构造授权（非生产语义），其余走真实授权规则。</p>`;
}
function renderEvidence(evidence) {
    const box = document.getElementById('rd-results');
    if (!box)
        return;
    const s = evidence.summary;
    const rows = evidence.scenarios
        .map((r) => {
        var _a, _b, _c;
        const pass = r.assertions.filter((a) => a.status === 'pass').length;
        const note = (_c = (_a = r.reason) !== null && _a !== void 0 ? _a : (_b = r.error) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : '';
        return `<tr class="${r.status}">
        <td>${esc(r.name)}${r.constructed ? ' <span class="tag">构造</span>' : ''}</td>
        <td><span class="badge ${r.status}">${r.status}</span></td>
        <td>${r.durationMs}</td>
        <td>${pass}/${r.assertions.length}</td>
        <td class="note">${esc(note)}</td>
      </tr>`;
    })
        .join('');
    box.innerHTML = `<div class="summary">
      ${['total', 'pass', 'fail', 'skip', 'unverified', 'contract-pending']
        .map((k) => `<div class="card ${k}"><span class="n">${s[k === 'contract-pending' ? 'contractPending' : k]}</span><span class="l">${k}</span></div>`)
        .join('')}
    </div>
    <table>
      <thead><tr><th>场景</th><th>状态</th><th>ms</th><th>断言</th><th>说明</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}
function renderDetail(name) {
    var _a;
    const box = document.getElementById('rd-detail');
    if (!box)
        return;
    const ev = state.evidence;
    const hit = ev === null || ev === void 0 ? void 0 : ev.scenarios.find((r) => r.name === name);
    if (!hit) {
        box.innerHTML = '<p class="empty">选中场景后点「执行选中场景」查看断言明细</p>';
        return;
    }
    const rows = hit.assertions
        .map((a) => {
        var _a;
        return `<tr class="${a.status}">
        <td>${esc(a.label)}</td>
        <td><span class="badge ${a.status}">${a.status}</span></td>
        <td class="note">${esc((_a = a.detail) !== null && _a !== void 0 ? _a : '')}</td>
        <td class="note">${esc(a.expected === undefined ? '' : JSON.stringify(a.expected))}</td>
        <td class="note">${esc(a.actual === undefined ? '' : JSON.stringify(a.actual))}</td>
      </tr>`;
    })
        .join('');
    const t = hit.driver.teardown;
    const load = hit.driver.load;
    box.innerHTML = `
    <h3>${esc(hit.name)} <span class="badge ${hit.status}">${hit.status}</span></h3>
    ${hit.reason ? `<p class="hint">${esc(hit.reason)}</p>` : ''}
    ${hit.error ? `<p class="fail">${esc((_a = hit.error.code) !== null && _a !== void 0 ? _a : '')} ${esc(hit.error.message)}</p>` : ''}
    <table>
      <thead><tr><th>断言</th><th>结果</th><th>细节</th><th>期望</th><th>实际</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="empty">无断言</td></tr>'}</tbody>
    </table>
    ${load ? `<h4>装载记录</h4><pre>${esc(JSON.stringify(load, null, 2))}</pre>` : ''}
    ${t ? `<h4>卸载记录</h4><pre>${esc(JSON.stringify(t, null, 2))}</pre>` : ''}
    ${hit.notes.length ? `<h4>备注</h4><ul>${hit.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`;
}
function renderTrace() {
    const box = document.getElementById('rd-trace');
    if (!box)
        return;
    const trace = state.session ? state.session.bus.auditSnapshot(60) : [];
    const rows = trace
        .map((r) => {
        var _a, _b, _c, _d, _e;
        return `<tr>
        <td>${r.seq}</td><td>${esc(r.kind)}</td><td>${esc(r.result)}</td>
        <td>${esc(r.subject)}</td><td>${esc((_b = (_a = r.target) !== null && _a !== void 0 ? _a : r.topic) !== null && _b !== void 0 ? _b : '')}</td>
        <td>${esc((_c = r.op) !== null && _c !== void 0 ? _c : '')}</td><td>${esc((_d = r.corr) !== null && _d !== void 0 ? _d : '')}</td><td class="note">${esc((_e = r.detail) !== null && _e !== void 0 ? _e : '')}</td>
      </tr>`;
    })
        .join('');
    box.innerHTML = `<table>
    <thead><tr><th>seq</th><th>kind</th><th>result</th><th>from</th><th>to/topic</th><th>op</th><th>corr</th><th>detail</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="8" class="empty">（无会话或暂无轨迹）</td></tr>'}</tbody>
  </table>`;
}
async function runAll() {
    if (!state.pkg)
        throw new Error('未取件');
    setStatus('执行全部场景…');
    const evidence = await runRealDriverSuite(realDriverScenarios, {
        pkg: state.pkg,
        importModule: importFromBlob,
        grants: grantsForRealDriverScenarios(state.pkg.manifest.id),
        strict: grantsMode() === 'strict',
        busCommit,
        label: 'real-driver/lab',
        mode: evidenceMode,
    });
    state.evidence = evidence;
    renderEvidence(evidence);
    setStatus(`完成：pass=${evidence.summary.pass} fail=${evidence.summary.fail} contract-pending=${evidence.summary.contractPending}`);
    return evidence;
}
async function runOne(name) {
    var _a, _b, _c, _d;
    if (!state.pkg)
        throw new Error('未取件');
    const sel = (_a = document.getElementById('rd-scenario')) === null || _a === void 0 ? void 0 : _a.value;
    const target = (_b = name !== null && name !== void 0 ? name : sel) !== null && _b !== void 0 ? _b : (_c = realDriverScenarios[0]) === null || _c === void 0 ? void 0 : _c.name;
    const scenario = realDriverScenarios.find((s) => s.name === target);
    if (!scenario)
        throw new Error(`未知场景：${target}`);
    const evidence = await runRealDriverSuite([scenario], {
        pkg: state.pkg,
        importModule: importFromBlob,
        grants: grantsForRealDriverScenarios(state.pkg.manifest.id),
        strict: grantsMode() === 'strict',
        busCommit,
        label: `real-driver/lab#${target}`,
        mode: evidenceMode,
    });
    state.evidence = evidence;
    renderEvidence(evidence);
    renderDetail(target);
    setStatus(`已执行：${target} → ${(_d = evidence.scenarios[0]) === null || _d === void 0 ? void 0 : _d.status}`);
    return evidence;
}
/** 逐步执行：按顺序跑下一条，索引留在 state 里。 */
async function step() {
    const idx = state.stepIndex % realDriverScenarios.length;
    const scenario = realDriverScenarios[idx];
    state.stepIndex = idx + 1;
    setStatus(`逐步执行 ${idx + 1}/${realDriverScenarios.length}`);
    return runOne(scenario.name);
}
function exportEvidence() {
    if (!state.evidence)
        throw new Error('尚无证据可导出');
    const payload = {
        ...state.evidence,
        exportedAt: new Date().toISOString(),
        intake: state.intake,
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `real-driver-evidence-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    return json;
}
function setMode(mode) {
    evidenceMode = mode;
}
function setGrantsMode(mode) {
    const sel = document.getElementById('rd-grants');
    if (sel)
        sel.value = mode;
}
function getState() {
    return state;
}
function wire() {
    const on = (id, fn) => {
        const node = document.getElementById(id);
        if (node)
            node.addEventListener('click', fn);
    };
    on('rd-init', () => void init());
    on('rd-load', () => void loadSession().then(() => setStatus('已装载', 'ok')).catch((e) => setStatus(String(e), 'fail')));
    on('rd-unload', () => void unloadSession().then((t) => setStatus(t ? '已卸载' : '无会话')).catch((e) => setStatus(String(e), 'fail')));
    on('rd-probe', () => void probe().then((p) => {
        const box = document.getElementById('rd-probe-out');
        if (box)
            box.textContent = JSON.stringify(p, null, 2);
    }).catch((e) => setStatus(String(e), 'fail')));
    on('rd-run-one', () => void runOne().catch((e) => setStatus(String(e), 'fail')));
    on('rd-step', () => void step().catch((e) => setStatus(String(e), 'fail')));
    on('rd-run-all', () => void runAll().catch((e) => setStatus(String(e), 'fail')));
    on('rd-export', () => {
        try {
            exportEvidence();
        }
        catch (e) {
            setStatus(String(e), 'fail');
        }
    });
    renderScenarioList();
    renderMeta();
    // 打开页面即取件：状态栏能立刻反映"这一页测的是哪份字节"
    void init();
}
export const realDriverPanel = {
    init,
    runAll,
    runOne,
    step,
    loadSession,
    unloadSession,
    probe,
    exportEvidence,
    setGrantsMode,
    setMode,
    getState,
    scenarios: realDriverScenarios.map((s) => ({ name: s.name, constructed: Boolean(s.constructed) })),
};
export function mountRealDriverPanel() {
    try {
        wire();
    }
    catch (e) {
        setStatus(`面板初始化失败：${e instanceof Error ? e.message : String(e)}`, 'fail');
    }
}
