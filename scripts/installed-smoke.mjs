// Runs against the installed application on a disposable Windows runner.
// Uses Chromium's loopback-only DevTools port, never enabled by the installer.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const legacy = process.argv.includes('--legacy');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let target;
for (let i = 0; i < 120; i++) {
  try {
    const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
    target = targets.find(t => t.type === 'page' && t.url.startsWith('file:'));
    if (target) break;
  } catch {}
  await delay(500);
}
assert(target, 'Installed renderer failed to start');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map();
ws.onmessage = e => {
  const message = JSON.parse(e.data);
  const p = pending.get(message.id);
  if (p) {
    pending.delete(message.id);
    if (message.error) p.reject(new Error(JSON.stringify(message.error)));
    else p.resolve(message.result);
  }
};
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
try {
  for (let i = 0; i < 60; i++) {
    if (await evaluate("!!window.api && document.body.innerText.includes('Credits')")) break;
    await delay(500);
  }
  assert.equal(await evaluate('typeof window.require'), 'undefined', 'Node must not be exposed to the renderer');
  const version = await evaluate('window.api.app.getVersion()');
  assert.equal(version, legacy ? '1.0.19' : '1.0.20');
  const result = await evaluate(`(async () => {
    const all = await window.api.benefits.getAll();
    const nights = all.find(b => b.card_id === 'marriott_premier' && b.title.startsWith('1 Elite Night Credit per'));
    const hyatt = all.find(b => b.card_id === 'hyatt_visa' && b.title.startsWith('Annual'));
    const history = await window.api.usages.getForBenefit(nights.id);
    if (${legacy}) {
      if (!history.some(u => u.notes === 'upgrade-preservation-sentinel')) {
        await window.api.usages.create({benefit_id:nights.id, used_on:'2026-08-15', notes:'upgrade-preservation-sentinel'});
      }
      await window.api.benefits.update(hyatt.id, {expiration_date:'2027-08-15'});
    } else {
      if (!history.some(u => u.notes === 'upgrade-preservation-sentinel')) throw Error('Upgrade lost previous usage');
      if (hyatt.expiration_date !== '2027-08-15') throw Error('Upgrade lost certificate date');
      if (!history.some(u => u.notes === 'quantity-sentinel')) {
        await window.api.usages.create({benefit_id:nights.id, used_on:'2026-09-15', quantity:7, notes:'quantity-sentinel'});
      }
      await window.api.benefits.update(nights.id, {is_hidden:1});
      if ((await window.api.benefits.getById(nights.id)).is_hidden !== 1) throw Error('Hide failed');
      await window.api.benefits.update(nights.id, {is_hidden:0});
      const projections = await window.api.projection.all(2026);
      if (projections.find(p => p.benefit.id === nights.id).uses_count !== 8) throw Error('Night quantity did not persist');
      const lyft = projections.find(p => p.benefit.card_id === 'aa_executive' && p.benefit.title.includes('Lyft'));
      if (lyft.annual_value_usd !== 140) throw Error('Wrong effective-date Lyft annual amount');
      if (projections.some(p => p.benefit.title === 'Medallion Tier MQD Requirements')) throw Error('MQD reference still visible');
      const diamond = all.find(b => b.program_id === 'delta_medallion' && b.title.startsWith('Diamond Medallion Choice Benefits'));
      const earned = await window.api.usages.getForBenefit(diamond.id);
      if (!earned.some(u => u.used_on.startsWith('2026'))) await window.api.usages.create({benefit_id:diamond.id, used_on:'2026-09-15'});
      const ids = all.filter(b => b.prerequisite_benefit_id === diamond.id && !b.title.includes('Membership')).slice(0,3).map(b=>b.id);
      await window.api.benefits.setChoices(diamond.id, 2026, ids);
      if ((await window.api.benefits.getChoices(diamond.id,2026)).length !== 3) throw Error('Choice persistence failed');
    }
    return {version:await window.api.app.getVersion(), dbPath:await window.api.file.currentPath(), notes:'installed native SQLite + preload IPC checks passed'};
  })()`);
  fs.mkdirSync('release-evidence', { recursive: true });
  fs.writeFileSync('release-evidence/runtime.json', JSON.stringify(result, null, 2));
  if (!legacy) {
    await command('Emulation.setDeviceMetricsOverride', { width: 1000, height: 640, deviceScaleFactor: 1, mobile: false });
    await command('Page.reload');
    await delay(1500);
    assert(await evaluate("document.body.innerText.includes('Mark achieved') || document.body.innerText.includes('Achieved (click to undo)')"));
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Log nights earned')?.click()");
    await delay(500);
    assert(await evaluate("!!document.querySelector('#earned-nights')"), 'Earned nights modal unavailable');
    const screenshot = await command('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('release-evidence/earned-nights-1000x640.png', Buffer.from(screenshot.data, 'base64'));
  }
  console.log(JSON.stringify(result));
} finally { ws.close(); }
