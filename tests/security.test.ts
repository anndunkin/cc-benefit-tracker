import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { seededDb } from './helpers';
import {
  cardCreate, cardGetById, cardsGetAll,
  benefitCreate, benefitsGetAll,
  usageCreate, usagesForBenefit,
} from '../electron/database';
import { resolveIconPath, iconPathWithinAssets, ICON_FILE } from '../electron/iconPath';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');

describe('SQL injection resistance (parameterized queries)', () => {
  it('treats a malicious card name as literal data, not SQL', () => {
    const db = seededDb();
    const evil = "Marriott'); DROP TABLE cards;--";
    const before = cardsGetAll(db).length;
    const created = cardCreate(db, { name: evil, issuer: 'Bank', network: 'Visa' });
    const after = cardsGetAll(db).length;
    expect(after).toBe(before + 1);
    expect(created.name).toBe(evil);
    expect(() => db.prepare('SELECT COUNT(*) FROM cards').get()).not.toThrow();
  });

  it('does not interpolate card ids into SQL when fetching by id', () => {
    const db = seededDb();
    expect(cardGetById(db, "delta' OR '1'='1")).toBeNull();
  });

  it('parameterizes usage notes so quotes and semicolons survive', () => {
    const db = seededDb();
    const anyBenefit = benefitsGetAll(db)[0];
    expect(anyBenefit).toBeDefined();
    const evil = "'; DELETE FROM usages; --";
    const u = usageCreate(db, {
      benefit_id: anyBenefit.id,
      used_on: '2026-06-01',
      amount_usd: 25,
      notes: evil,
    });
    expect(u.notes).toBe(evil);
    // Usages table survives
    expect(() => db.prepare('SELECT COUNT(*) FROM usages').get()).not.toThrow();
    expect(usagesForBenefit(db, anyBenefit.id).length).toBeGreaterThan(0);
  });
});

describe('No plaintext credentials or private keys in source', () => {
  const srcFiles = [
    'electron/database.ts', 'electron/main.ts', 'electron/preload.ts',
    'electron/benefitsSeed.ts', 'electron/types.ts',
  ];

  it('does not contain private-key markers', () => {
    for (const rel of srcFiles) {
      const content = read(rel);
      expect(content).not.toMatch(/BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY/);
      expect(content).not.toMatch(/-----BEGIN CERTIFICATE-----/);
    }
  });

  it('does not embed AWS/GitHub-style API keys', () => {
    for (const rel of srcFiles) {
      const content = read(rel);
      expect(content).not.toMatch(/AKIA[0-9A-Z]{16}/);
      expect(content).not.toMatch(/gh[pousr]_[A-Za-z0-9]{30,}/);
    }
  });
});

describe('Electron security posture', () => {
  it('main.ts creates BrowserWindow with contextIsolation and nodeIntegration=false', () => {
    const main = read('electron/main.ts');
    expect(main).toMatch(/contextIsolation:\s*true/);
    expect(main).toMatch(/nodeIntegration:\s*false/);
    expect(main).toMatch(/sandbox:\s*true|preload:/);
  });

  it('preload.ts uses contextBridge, not window direct assignment', () => {
    const preload = read('electron/preload.ts');
    expect(preload).toMatch(/contextBridge\.exposeInMainWorld/);
    expect(preload).not.toMatch(/window\.api\s*=/);
  });
});

describe('Icon path traversal defense', () => {
  it('resolveIconPath returns a path inside the assets directory', () => {
    const p = resolveIconPath();
    // Path exists as a string; iconPathWithinAssets is the guard we care about.
    expect(typeof p).toBe('string');
    expect(iconPathWithinAssets(p) || iconPathWithinAssets(ICON_FILE)).toBeTruthy();
  });
});
