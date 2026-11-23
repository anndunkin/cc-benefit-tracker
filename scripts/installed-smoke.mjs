// Runs against the installed application on a disposable Windows runner.
// Uses Chromium's loopback-only DevTools port, never enabled by the installer.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const legacy = process.argv.includes('--legacy');
// v1.0.25: `--expect-db <path>` asserts which data file the installed app opened at launch.
const expectDbAt = process.argv.indexOf('--expect-db');
const expectDb = expectDbAt >= 0 ? process.argv[expectDbAt + 1] : null;
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
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      ready = await evaluate("!!window.api && !!document.body && document.body.innerText.includes('Credits')");
      if (ready) break;
    } catch { /* navigation may replace the initial execution context */ }
    await delay(500);
  }
  assert(ready, 'Installed renderer did not finish loading its application UI');
  assert.equal(await evaluate('typeof window.require'), 'undefined', 'Node must not be exposed to the renderer');
  const version = await evaluate('window.api.app.getVersion()');
  assert.equal(version, legacy ? '1.0.19' : JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  const result = await evaluate(`(async () => {
    const all = await window.api.benefits.getAll();
    const nights = all.find(b => b.card_id === 'marriott_premier' && b.title.startsWith('1 Elite Night Credit per'));
    const hyatt = all.find(b => b.card_id === 'hyatt_visa' && b.title.startsWith('Annual'));
    const history = await window.api.usages.getForBenefit(nights.id);
    let refreshEvidence = null;
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
      // v1.0.24: an upgraded database must be offered the bundled benefit refresh as a
      // draft for review, with every change matched and nothing applied without approval.
      const refresh = await window.api.refresh.getStatus();
      if (!refresh.pending_run_id) throw Error('Upgrade did not offer the bundled benefit refresh for review');
      const proposed = await window.api.refresh.getPendingChanges(refresh.pending_run_id);
      if (proposed.length < 20) throw Error('Bundled refresh offered only ' + proposed.length + ' changes');
      if (proposed.some(c => c.review_status !== 'pending')) throw Error('Refresh changes were decided without the user');
      if (refresh.unmatched.length) throw Error('Bundled refresh could not match: ' + refresh.unmatched.map(u => u.identifier ?? u.title ?? JSON.stringify(u)).join('; '));
      const exec = (await window.api.cards.getAll()).find(c => c.id === 'aa_executive');
      if (exec.annual_fee_usd !== 595) throw Error('A refresh change was applied without approval');
      // v1.0.27: a program proposed by a refresh is never added before it is approved.
      if ((await window.api.programs.getAll()).some(p => p.id === 'hyatt_status')) throw Error('The World of Hyatt program was added without approval');
      refreshEvidence = {run_id: refresh.pending_run_id, proposed: proposed.length, unmatched: 0};
    }
    return {version:await window.api.app.getVersion(), dbPath:await window.api.file.currentPath(), refresh:refreshEvidence, notes:'installed native SQLite + preload IPC checks passed'};
  })()`);
  fs.mkdirSync('release-evidence', { recursive: true });
  if (expectDb) {
    assert.equal(result.dbPath.toLowerCase(), expectDb.toLowerCase(), 'The app did not open the expected data file at launch');
  }
  if (!legacy) {
    // v1.0.25 file management: Save must leave one complete .db file on disk.
    assert.equal(await evaluate('typeof window.api.file.onChanged'), 'function', 'File change notifications are not exposed');
    const saved = await evaluate('window.api.file.save()');
    assert.equal(saved.success, true, 'Save failed: ' + saved.error);
    assert.equal(saved.filePath, result.dbPath);
    assert.equal(saved.message, 'Saved to ' + result.dbPath);
    const wal = result.dbPath + '-wal';
    assert(!fs.existsSync(wal) || fs.statSync(wal).size === 0, 'Save left changes outside the .db file');
    result.file = { saved: saved.message, opened: result.dbPath, expected: expectDb };
  }
  // Each run keeps its own evidence; runtime.json is always the latest default-file run.
  fs.writeFileSync(expectDb ? 'release-evidence/runtime-file-check.json' : 'release-evidence/runtime.json', JSON.stringify(result, null, 2));
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
    // The review screen must show its actions at a small window size.
    await evaluate("location.hash = '#/refresh'");
    await delay(1500);
    assert(await evaluate("document.body.innerText.includes('Apply approved') && document.body.innerText.includes('Approve all undecided')"), 'Refresh review actions unavailable');
    assert(await evaluate("(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent === 'Apply approved'); const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth; })()"), 'Apply approved is not visible at 1000x640');
    const review = await command('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('release-evidence/refresh-review-1000x640.png', Buffer.from(review.data, 'base64'));
    // v1.0.25: every file command must be reachable on the Settings page at a small window size.
    await evaluate("location.hash = '#/settings'");
    await delay(1500);
    const fileButtons = ['New File…', 'Open File…', 'Save', 'Save As…', 'Save a Backup Copy…', 'Show File in Folder', 'Export to JSON…', 'Import from JSON…'];
    const unreachable = await evaluate(`(() => {
      const wanted = ${JSON.stringify(fileButtons)};
      const missing = [];
      for (const label of wanted) {
        const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === label);
        if (!b) { missing.push(label + ' (missing)'); continue; }
        b.scrollIntoView({ block: 'center' });
        const r = b.getBoundingClientRect();
        if (b.disabled || r.width === 0 || r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth) missing.push(label + ' (not reachable)');
      }
      return missing;
    })()`);
    assert.deepEqual(unreachable, [], 'File commands unavailable on Settings at 1000x640');
    assert(await evaluate(`document.body.innerText.includes(${JSON.stringify(result.dbPath)})`), 'Settings does not show the open file');
    const settingsShot = await command('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('release-evidence/settings-file-1000x640.png', Buffer.from(settingsShot.data, 'base64'));
    // v1.0.26: Print Expiring Credits. The screen must be usable at a small window size,
    // list what the app itself reports as expiring, and print as black on white with none
    // of the app's own controls. The system print dialog is never opened here.
    await evaluate("localStorage.removeItem('cct.printExpiring.v1'); location.hash = '#/print-expiring'");
    await delay(1500);
    assert.equal(await evaluate("typeof window.api.app.print + ' ' + typeof window.api.app.onNavigate + ' ' + typeof window.api.expiring.list"), 'function function function', 'Print commands are not exposed');
    const expiring = await evaluate(`(async () => {
      const r = await window.api.expiring.list();
      const n = new Date();
      const local = n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
      return { today: r.today, local, month_end: r.month_end, year_end: r.year_end, next_year_end: r.next_year_end, items: r.items.length,
        thisYear: r.items.filter(i => i.expires_on <= r.year_end).length,
        partly: r.items.filter(i => i.partially_used).length,
        undatedCertificates: r.items.filter(i => i.date_not_recorded).length };
    })()`);
    assert.equal(expiring.today, expiring.local, 'The expiring list is not built for the local date');
    assert(await evaluate("document.body.innerText.includes('Print Expiring Credits') && !!document.querySelector('section.print-sheet')"), 'Print Expiring Credits screen unavailable');
    const printButton = "[...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Print…')";
    assert(await evaluate(`(() => { const r = ${printButton}.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth; })()`), 'Print… is not visible at 1000x640');
    await evaluate("[...document.querySelectorAll('input[type=radio]')].find(x => x.closest('label').innerText.startsWith('This year')).click()");
    await delay(500);
    const listedRows = await evaluate("document.querySelectorAll('section.print-sheet tr[data-benefit-id]').length");
    assert.equal(listedRows, expiring.thisYear, 'The sheet does not list what is expiring this year');
    const printShot = await command('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('release-evidence/print-expiring-1000x640.png', Buffer.from(printShot.data, 'base64'));
    await command('Emulation.setEmulatedMedia', { media: 'print' });
    await delay(300);
    const paper = await evaluate(`(() => {
      const shown = el => !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
      const sheet = document.querySelector('section.print-sheet');
      const main = document.querySelector('main');
      return {
        appHeader: shown(document.querySelector('#root header')),
        printButton: shown(${printButton}),
        tickBoxes: [...sheet.querySelectorAll('input[type=checkbox]')].filter(shown).length,
        sheet: shown(sheet),
        color: getComputedStyle(sheet).color,
        background: getComputedStyle(document.body).backgroundColor,
        mainOverflow: getComputedStyle(main).overflowY,
        rows: [...sheet.querySelectorAll('tr[data-benefit-id]')].filter(shown).length,
      };
    })()`);
    await command('Emulation.setEmulatedMedia', { media: '' });
    assert.deepEqual({ ...paper, rows: undefined }, { appHeader: false, printButton: false, tickBoxes: 0, sheet: true, color: 'rgb(0, 0, 0)', background: 'rgb(255, 255, 255)', mainOverflow: 'visible', rows: undefined }, 'The printed page is not a clean black-on-white sheet');
    assert.equal(paper.rows, expiring.thisYear, 'Rows are missing from the printed page');
    result.print = { ...expiring, listedRows, paper };
    fs.writeFileSync(expectDb ? 'release-evidence/runtime-file-check.json' : 'release-evidence/runtime.json', JSON.stringify(result, null, 2));
    await evaluate("localStorage.removeItem('cct.printExpiring.v1'); location.hash = '#/'");
  }
  console.log(JSON.stringify(result));
} finally { ws.close(); }
