// v1.0.29 security review: links, navigation, sandbox, content policy and
// the requests the page may make of the app.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { seededDb } from './helpers';
import {
  cardCreate, cardUpdate, cardGetById, programCreate, programUpdate, programGetById,
  benefitCreate, benefitUpdate, benefitGetById, pointsCurrencyCreate, pointsCurrencyUpdate,
  buildFilePayload, importFilePayload, cardsGetAll, programsGetAll, benefitsGetAll, pointsCurrenciesGetAll,
} from '../electron/database';
import { isSafeWebLink, safeWebLinkOrNull, requireWebLinkOrBlank, isAppPageUrl, MAX_LINK_LENGTH } from '../electron/linkPolicy';
import { SEED_CARDS, SEED_PROGRAMS, SEED_BENEFITS, SEED_POINTS_CURRENCIES } from '../electron/benefitsSeed';
import { BUNDLED_REFRESH_PROPOSALS } from '../electron/refreshProposalData';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');

const UNSAFE = [
  'file:///C:/Windows/System32/calc.exe',
  'FILE://server/share/run.exe',
  'javascript:alert(1)',
  ' javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'ms-msdt:/id PCWDiagnostic',
  'search-ms:query=x',
  'vbscript:msgbox(1)',
  'chrome://settings',
  'C:\\Windows\\notepad.exe',
  '\\\\server\\share\\x.exe',
  '//example.com/page',
  'https://user:pass@example.com/',
  'https://exa mple.com/',
  'https://example.com/\u0000.exe',
  'https://' + 'a'.repeat(MAX_LINK_LENGTH) + '.com',
  '',
];

describe('link rule', () => {
  it('accepts ordinary web links', () => {
    for (const u of ['https://www.hyatt.com/help', 'http://example.com/a?b=c#d', 'HTTPS://Example.com/']) expect(isSafeWebLink(u)).toBe(true);
  });
  it('rejects every other kind of address', () => {
    for (const u of UNSAFE) expect(isSafeWebLink(u), u).toBe(false);
    for (const v of [null, undefined, 42, {}, ['https://x.com']]) expect(isSafeWebLink(v)).toBe(false);
  });
  it('typed links: blank clears, unsafe is refused with a message', () => {
    expect(requireWebLinkOrBlank('Link', '  ')).toBeNull();
    expect(requireWebLinkOrBlank('Link', ' https://x.com/ ')).toBe('https://x.com/');
    expect(() => requireWebLinkOrBlank('Link', 'file:///C:/x.exe')).toThrow(/https:\/\/ or http:\/\//);
  });
  it('every link bundled with the app passes', () => {
    const urls: string[] = [];
    for (const x of [...SEED_CARDS, ...SEED_PROGRAMS, ...SEED_BENEFITS, ...SEED_POINTS_CURRENCIES] as Array<{ source_url?: string | null }>) if (x.source_url) urls.push(x.source_url);
    const walk = (o: unknown) => {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) { if ((k === 'source_url' || k === 'url') && typeof v === 'string') urls.push(v); else walk(v); }
    };
    walk(BUNDLED_REFRESH_PROPOSALS);
    expect(urls.length).toBeGreaterThan(1000);
    expect(urls.filter(u => !isSafeWebLink(u))).toEqual([]);
  });
});

describe('the window stays on the app page', () => {
  const app = 'file:///C:/Program%20Files/Credit%20Card%20Benefit%20Tracker/resources/app.asar/dist/index.html';
  it('allows the app page and its in-app routes', () => {
    expect(isAppPageUrl(app, app, null)).toBe(true);
    expect(isAppPageUrl(app + '#/refresh', app, null)).toBe(true);
    expect(isAppPageUrl(app.replace('Program%20Files', 'program%20files') + '#/', app, null)).toBe(true);
  });
  it('refuses other local files, query strings, web pages and the dev server outside development', () => {
    expect(isAppPageUrl('file:///C:/Users/ann/Downloads/evil.html', app, null)).toBe(false);
    expect(isAppPageUrl(app.replace('index.html', 'other.html'), app, null)).toBe(false);
    expect(isAppPageUrl(app + '?x=1', app, null)).toBe(false);
    expect(isAppPageUrl('file://attacker/share/index.html', app, null)).toBe(false);
    expect(isAppPageUrl('https://example.com/', app, null)).toBe(false);
    expect(isAppPageUrl('http://localhost:5173/', app, null)).toBe(false);
    expect(isAppPageUrl('http://localhost:5173/#/x', app, 'http://localhost:5173')).toBe(true);
    expect(isAppPageUrl('not a url', app, null)).toBe(false);
  });
});

describe('links are checked when saved', () => {
  it('cards, programs, benefits and points values refuse unsafe links and keep safe ones', () => {
    const db = seededDb();
    expect(() => cardCreate(db, { name: 'X', issuer: 'Y', network: 'Visa', source_url: 'file:///C:/x.exe' } as never)).toThrow(/web link/);
    expect(() => programCreate(db, { name: 'P', program_type: 'airline', source_url: 'javascript:alert(1)' } as never)).toThrow(/web link/);
    const card = cardCreate(db, { name: 'Safe', issuer: 'Y', network: 'Visa', source_url: 'https://example.com/card' } as never);
    expect(card.source_url).toBe('https://example.com/card');
    expect(() => cardUpdate(db, card.id, { source_url: 'ms-msdt:/id x' })).toThrow(/web link/);
    expect(cardGetById(db, card.id)!.source_url).toBe('https://example.com/card');
    expect(cardUpdate(db, card.id, { notes: 'n' })!.source_url).toBe('https://example.com/card');
    expect(cardUpdate(db, card.id, { source_url: '' })!.source_url).toBeNull();
    const prog = programCreate(db, { name: 'Safe P', program_type: 'airline' } as never);
    expect(() => programUpdate(db, prog.id, { source_url: 'data:text/html,x' })).toThrow(/web link/);
    expect(programGetById(db, prog.id)!.source_url).toBeNull();
    expect(() => benefitCreate(db, { card_id: card.id, title: 'B', category: 'other', reset_cadence: 'annual', source_url: '\\\\server\\x.exe' } as never)).toThrow(/web link/);
    const b = benefitCreate(db, { card_id: card.id, title: 'B', category: 'other', reset_cadence: 'annual' } as never);
    expect(() => benefitUpdate(db, b.id, { source_url: 'file:///C:/x.exe' })).toThrow(/web link/);
    expect(benefitGetById(db, b.id)!.source_url).toBeNull();
    expect(() => pointsCurrencyCreate(db, { name: 'Pts', currency_type: 'bank', value_cents_per_point: 1, source_url: 'vbscript:x' } as never)).toThrow(/web link/);
    const pc = pointsCurrenciesGetAll(db)[0];
    expect(() => pointsCurrencyUpdate(db, pc.id, { source_url: 'file:///x' })).toThrow(/web link/);
  });
});

describe('links are cleaned when a data file is imported', () => {
  it('drops unsafe links from every table and from a half-reviewed refresh, keeping everything else', () => {
    const db = seededDb();
    const payload = buildFilePayload(db);
    payload.cards[0].source_url = 'file:///C:/Windows/System32/calc.exe';
    payload.programs[0].source_url = 'javascript:alert(1)';
    payload.benefits[0].source_url = 'ms-msdt:/id PCWDiagnostic';
    payload.benefits[1].source_url = 'https://ok.example.com/';
    payload.points_currencies![0].source_url = 'data:text/html,x';
    payload.refresh_runs.push({ id: 900, started_at: '2026-11-23', completed_at: null, source_notes: 'x', status: 'draft' } as never);
    payload.refresh_changes.push({
      id: 9001, refresh_run_id: 900, change_type: 'modified', card_id: payload.cards[0].id, program_id: null,
      benefit_id: payload.benefits[0].id, points_currency_id: null, before_json: null,
      after_json: JSON.stringify({ title: 'T', source_url: 'file:///C:/x.exe', _meta: { sources: [{ label: 'bad', url: 'file:///x' }, { label: 'good', url: 'https://good.example.com/' }] } }),
      review_status: 'pending', review_notes: null, created_at: '2026-11-23', overwrite_user_edit: 0,
    } as never);
    const other = seededDb();
    importFilePayload(other, payload);
    expect(cardsGetAll(other).find(c => c.id === payload.cards[0].id)!.source_url).toBeNull();
    expect(programsGetAll(other).find(p => p.id === payload.programs[0].id)!.source_url).toBeNull();
    const bens = benefitsGetAll(other);
    expect(bens.find(b => b.id === payload.benefits[0].id)!.source_url).toBeNull();
    expect(bens.find(b => b.id === payload.benefits[1].id)!.source_url).toBe('https://ok.example.com/');
    expect(pointsCurrenciesGetAll(other).find(p => p.id === payload.points_currencies![0].id)!.source_url).toBeNull();
    const row = other.prepare('SELECT after_json FROM refresh_changes WHERE id = 9001').get() as { after_json: string };
    const after = JSON.parse(row.after_json);
    expect(after.title).toBe('T');
    expect(after.source_url).toBeNull();
    expect(after._meta.sources).toEqual([{ label: 'good', url: 'https://good.example.com/' }]);
    // Everything else came across.
    expect(cardsGetAll(other).length).toBe(payload.cards.length);
    expect(benefitsGetAll(other).length).toBe(payload.benefits.length);
  });
});

describe('window settings (v1.0.29)', () => {
  const main = read('electron/main.ts');
  it('runs the page in the sandbox with no Node access and no webviews', () => {
    expect(main).toMatch(/sandbox:\s*true/);
    expect(main).not.toMatch(/sandbox:\s*false/);
    expect(main).toMatch(/nodeIntegration:\s*false/);
    expect(main).toMatch(/contextIsolation:\s*true/);
    expect(main).toMatch(/webviewTag:\s*false/);
    expect(main).toMatch(/will-attach-webview/);
  });
  it('the preload script needs nothing the sandbox does not provide', () => {
    const preload = read('electron/preload.ts');
    const imports = [...preload.matchAll(/^import\s+(?!type\b).*from\s+'([^']+)'/gm)].map(m => m[1]);
    expect(imports).toEqual(['electron']);
    expect(preload).not.toMatch(/require\(/);
  });
  it('only opens web links, and only through the checked helper', () => {
    const calls = [...main.matchAll(/shell\.openExternal\(([^)]*)\)/g)].map(m => m[1]);
    for (const arg of calls) expect(arg === 'url' || /^'https:\/\//.test(arg), arg).toBe(true);
    const helper = main.slice(main.indexOf('function openExternalLink'), main.indexOf('function createWindow'));
    expect(helper).toMatch(/if \(!isSafeWebLink\(url\)\)/);
    expect(main).toMatch(/will-navigate[\s\S]*isAppPageUrl[\s\S]*openExternalLink\(url\)/);
    expect(main).toMatch(/setWindowOpenHandler\(\(\{ url \}\) => \{\s*openExternalLink\(url\);\s*return \{ action: 'deny' \}/);
  });
  it('checks who is asking on every request to the app', () => {
    const raw = [...main.matchAll(/ipcMain\.handle\(/g)].length;
    expect(raw).toBe(1); // only inside handleIpc
    expect([...main.matchAll(/handleIpc\('/g)].length).toBeGreaterThan(40);
    expect(main).toMatch(/frame === event\.sender\.mainFrame/);
  });
  it('installed app: no inline scripts, plug-ins, frames, forms or base changes; no device permissions', () => {
    expect(main).toMatch(/const scriptSrc = isDev \? "script-src 'self' 'unsafe-inline' file:; " : "script-src 'self' file:; "/);
    for (const d of ["object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'"]) expect(main).toContain(d);
    expect(main).toMatch(/setPermissionRequestHandler\(\(_wc, _permission, callback\) => callback\(false\)\)/);
    // The built page has no inline script that the stricter policy would block.
    const html = read('index.html');
    expect(html.match(/<script(?![^>]*\bsrc=)[^>]*>/g) ?? []).toEqual([]);
  });
});

describe('requests the page can make (v1.0.29)', () => {
  it('cannot submit its own refresh changes; refreshes come only from checked files', () => {
    expect(read('electron/preload.ts')).not.toMatch(/refresh:startRun/);
    expect(read('electron/main.ts')).not.toMatch(/handleIpc\('refresh:startRun'/);
  });
});
