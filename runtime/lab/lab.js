/**
 * Test Lab —— 浏览器人机测试界面。
 *
 * 与 SDK 的分工：SDK 提供 API / 断言 / 证据；Lab 只做「人怎么用」——
 * 按钮、结果表、真实审计轨迹、故障注入、证据导出。Lab 不实现任何测试语义。
 *
 * 自动化入口：`window.__lab.runAll()` / `injectDemoFault()` / `getState()`，
 * 供 scripts/e2e-lab.py 在三引擎里调用。
 */
import { createTestHarness, FaultInjector, runSuite } from '../src/index.js';
import { defaultOptions, mockDriver, roomCreateHandler, scenarios, } from '../fixtures/index.js';
import { mountRealDriverPanel, realDriverPanel } from './real-driver-panel.js';
const state = {
    ready: false,
    report: null,
    evidence: null,
    lastFault: null,
};
// 延迟到 wire() 内创建：模块顶层执行重量级初始化，在旧版 JSC（iOS Safari）
// 上是最容易失败的位置；且原写法在 setupLive() 里还会再建一次，属重复初始化。
let live;
function reportFatal(where, err) {
    var _a;
    const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const status = document.getElementById('status');
    if (status) {
        status.textContent = `FAILED (${where}): ${text}`;
        status.classList.add('fatal');
    }
    const panel = document.getElementById('fatal-panel');
    const box = document.getElementById('fatal');
    if (panel)
        panel.hidden = false;
    if (box) {
        box.textContent += `[${where}] ${text}\n${err instanceof Error ? ((_a = err.stack) !== null && _a !== void 0 ? _a : '') : ''}\n`;
    }
}
function el(id) {
    const node = document.getElementById(id);
    if (!node)
        throw new Error(`missing #${id}`);
    return node;
}
function escapeHtml(value) {
    return String(value !== null && value !== void 0 ? value : '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
function setupLive() {
    live = createTestHarness(defaultOptions);
    live.registerDriver(mockDriver('site.a', { label: 'requester' }));
    live.registerDriver(mockDriver('site.b', {
        label: 'responder',
        handlers: { 'room.create': roomCreateHandler },
    }));
    renderTrace();
}
function renderSummary(report) {
    const s = report.summary;
    const cards = [
        ['total', s.total, ''],
        ['pass', s.pass, 'pass'],
        ['fail', s.fail, 'fail'],
        ['skip', s.skip, 'skip'],
        ['unverified', s.unverified, 'unverified'],
        ['contract-pending', s.contractPending, 'contract'],
    ];
    el('summary').innerHTML = cards
        .map(([label, value, cls]) => `<div class="card ${cls}"><span class="n">${value}</span><span class="l">${label}</span></div>`)
        .join('');
}
function renderReport(report) {
    renderSummary(report);
    const rows = report.scenarios
        .map((r) => {
        var _a, _b, _c;
        const note = (_c = (_b = (_a = r.error) === null || _a === void 0 ? void 0 : _a.message) !== null && _b !== void 0 ? _b : r.reason) !== null && _c !== void 0 ? _c : '';
        return `<tr class="${r.status}">
        <td>${escapeHtml(r.name)}</td>
        <td><span class="badge ${r.status}">${r.status}</span></td>
        <td>${r.durationMs}</td>
        <td>${r.assertions.length}</td>
        <td class="note">${escapeHtml(note)}</td>
      </tr>`;
    })
        .join('');
    el('results').innerHTML = `<table>
    <thead><tr><th>场景</th><th>状态</th><th>ms</th><th>断言</th><th>说明</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}
function renderTrace() {
    const trace = live.trace(50);
    const rows = trace
        .map((t) => {
        var _a;
        return `<tr>
        <td>${t.seq}</td>
        <td>${escapeHtml(t.kind)}</td>
        <td>${escapeHtml(t.result)}</td>
        <td>${escapeHtml(t.subject)}</td>
        <td>${escapeHtml((_a = t.target) !== null && _a !== void 0 ? _a : t.topic)}</td>
        <td>${escapeHtml(t.op)}</td>
        <td>${escapeHtml(t.corr)}</td>
      </tr>`;
    })
        .join('');
    el('trace').innerHTML = `<table>
    <thead><tr><th>seq</th><th>kind</th><th>result</th><th>from</th><th>to/topic</th><th>op</th><th>corr</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7" class="empty">（暂无轨迹）</td></tr>'}</tbody>
  </table>`;
}
async function runAll() {
    const report = await runSuite(scenarios, defaultOptions);
    state.report = report;
    state.evidence = live.captureEvidence(report);
    renderReport(report);
    el('status').textContent = `ran ${report.summary.total} scenarios`;
    return report;
}
async function runOne(name) {
    const scenario = scenarios.find((s) => s.name === name);
    if (!scenario)
        throw new Error(`unknown scenario: ${name}`);
    const report = await runSuite([scenario], defaultOptions);
    state.report = report;
    state.evidence = live.captureEvidence(report);
    renderReport(report);
    return report.scenarios[0];
}
async function injectDemoFault() {
    const faults = new FaultInjector(live);
    // 保留注入记录：证据里必须能看出「注入了什么、是否真正生效」，
    // 只留 ok+code 无法核验故障链路（见 docs/ACCEPTANCE_CHECKLIST.md）。
    const record = await faults.timeout('site.b', 'room.create');
    let outcome;
    try {
        await live.driver('site.a').api.command('site.b', 'room.create', undefined, {
            deadlineMs: 120,
        });
        outcome = { ok: false, record };
    }
    catch (e) {
        const code = e.code;
        outcome = { ok: code === 'BUS_TIMEOUT', code, record };
    }
    state.lastFault = outcome;
    renderTrace();
    state.evidence = live.captureEvidence(state.report);
    el('fault-result').textContent = JSON.stringify(outcome);
    return outcome;
}
function exportReport() {
    var _a;
    const evidence = (_a = state.evidence) !== null && _a !== void 0 ? _a : live.captureEvidence(state.report);
    const json = JSON.stringify(evidence, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `intent-bus-test-evidence-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    return json;
}
function getState() {
    return state;
}
function wire() {
    setupLive();
    el('run-all').addEventListener('click', () => {
        void runAll();
    });
    el('run-one').addEventListener('click', () => {
        void runOne(el('scenario').value);
    });
    el('inject-fault').addEventListener('click', () => {
        void injectDemoFault();
    });
    el('export').addEventListener('click', () => {
        exportReport();
    });
    const select = el('scenario');
    select.innerHTML = scenarios
        .map((s) => `<option>${escapeHtml(s.name)}</option>`)
        .join('');
    state.ready = true;
    el('status').textContent = 'ready';
}
// 先暴露自动化入口：即使 wire() 失败，e2e 与真机仍能读到状态与错误
;
globalThis.__lab = {
    runAll,
    runOne,
    injectDemoFault,
    exportReport,
    getState,
    scenarios: scenarios.map((s) => s.name),
    // 真实驱动（锻造器交付）自动化入口：与模拟驱动场景分开，证据也分开
    rd: realDriverPanel,
};
try {
    wire();
}
catch (e) {
    // 不再让页面静默停在 "loading…"：把失败原因写进 DOM 与状态
    reportFatal('wire', e);
}
// 真实驱动面板独立初始化：它失败不应连累模拟驱动场景集（反之亦然）
try {
    mountRealDriverPanel();
}
catch (e) {
    reportFatal('real-driver-panel', e);
}
