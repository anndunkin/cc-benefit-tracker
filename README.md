# Credit Card Benefit Tracker

Windows desktop application that tracks the credit card and airline/hotel status benefits you have available and how many of them you've used. Built with Electron + React + TypeScript + SQLite. All data stays on your machine — no cloud, no accounts, no telemetry.

## Highlights

- **Yearly usage tracking** for benefits that reset (annual, semiannual, quarterly, monthly credits and choice benefits).
- **Separate "Programs" section** for status-driven benefits (Delta Medallion, Marriott Bonvoy, AAdvantage, IHG Ambassador) so complimentary upgrades and elite bonuses don't clutter the card list.
- **Unlimited benefits** (award-flight discounts, priority boarding, free bags, etc.) are tracked separately from consumable credits.
- **Diff & review quarterly refresh workflow** — the app proposes a change set; you approve or reject each row before it touches your saved benefits. Any benefit you have edited by hand is never overwritten by a refresh.
- **Full file management** — save your database anywhere, load it back, export a portable JSON payload.
- **Self-signed Windows installer** so the executable identifies itself as coming from Dunkin Global Advisors.
- **13 seeded cards, 4 seeded loyalty programs, 176 seeded benefits** — every value is linked to its published source page for quick verification.

## Seeded cards (v1.0.0)

Hilton Aspire · IHG One Rewards Premier · Amex Platinum · Delta SkyMiles Reserve · Citi AAdvantage Executive · Marriott Bonvoy Brilliant · Marriott Bonvoy Boundless · Marriott Bonvoy Bevy · Marriott Bonvoy Business · World of Hyatt · British Airways Visa · Virgin Atlantic World Elite (with a note that BofA discontinued issuance in October 2024) · Citi Prestige (closed to new applicants).

## Seeded programs

Delta SkyMiles Medallion · American AAdvantage · IHG One Rewards Ambassador · Marriott Bonvoy Elite.

## Quick start

```bash
npm install
npm run dev          # Vite + Electron in dev mode
npm run test         # 46 vitest tests across security / validation / boundary / functionality
npm run electron:build  # Build the Windows installer into dist-installer/
bash build/sign.sh   # Sign the installer with build/signing.crt (Windows only, requires osslsigncode)
```

## Data model

- **Cards** — issuer, network, annual fee, notes, color, source URL. Yours to add and delete.
- **Programs** — separate table for status/loyalty programs. Same fields.
- **Benefits** — belong to exactly one card OR one program. Each has a title, category, reset cadence, uses per period, dollar value, optional spend threshold, expiration note, and a source URL back to the official page.
- **Usages** — a row per redemption: benefit, date, dollar amount, optional note. The app tags each row with the correct period key at insert time so "used this quarter" queries never do calendar math on the fly.
- **Refresh runs** — a diff between the current database and the newly proposed benefit list. Each pending change is `pending`, then `approved` or `rejected`. Applying a run skips any benefit whose `is_user_modified` flag is set.

## File format

The app can save and load a JSON file describing your entire benefit ledger. The file version is checked on import; older files migrate forward automatically.

## Windows installer

The signing certificate is a fresh self-signed key generated specifically for this application (`CN=Ann Dunkin, O=Dunkin Global Advisors, OU=Software, C=US`). Windows will still show a SmartScreen warning on first install — that's expected for any self-signed executable.

## Tests

```
tests/security.test.ts      · SQL injection, secret scanning, electron security posture, icon path guard
tests/validation.test.ts    · Required fields, CHECK constraints, cadence validation
tests/boundary.test.ts      · Period math, unicode, extreme values, 100+ benefits
tests/functionality.test.ts · CRUD, seed idempotence, refresh workflow, export/import round-trip
```

Run `npm run test` to see the full suite. All 46 tests pass on a clean checkout.

## License

Private — for personal use by the copyright holder.

## Security note: pinned dependencies

`keyv` and `cacheable-request` are pinned to `4.5.4` and `7.0.4` respectively via
the `overrides` field in `package.json`. This is a deliberate protection against
the August 2026 Keyv/Cacheable npm supply chain attack, which compromised
`keyv@6.0.0`, `cacheable-request@13.0.20`, and 400+ other packages
(see the [Wiz writeup](https://www.wiz.io/blog/keyv-and-cacheable-npm-supply-chain-attack)).

These are transitive dependencies pulled in via `got` → `@electron/get` → `electron`.
**Before removing or updating these overrides**, verify that newer versions of
`keyv`/`cacheable-request` are confirmed clean against current npm security advisories.

