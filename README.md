# Credit Card Benefit Tracker

Windows desktop application that tracks the credit card and airline/hotel status benefits you have available and how many of them you've used. Built with Electron + React + TypeScript + SQLite. All data stays on your machine — no cloud, no accounts, no telemetry.

## Highlights

- **Yearly usage tracking** for benefits that reset (annual, semiannual, quarterly, monthly credits and choice benefits).
- **Separate "Programs" section** for status-driven benefits (Delta Medallion, Marriott Bonvoy, AAdvantage, IHG Ambassador, World of Hyatt) so complimentary upgrades and elite bonuses don't clutter the card list.
- **Unlimited benefits** (award-flight discounts, priority boarding, free bags, etc.) are tracked separately from consumable credits.
- **Diff & review quarterly refresh workflow** — each release carries a researched list of published benefit changes; the app compares it with your data and proposes a change set with sources and effective dates. You approve or reject each row before it touches your saved benefits. Any benefit you have edited by hand is never overwritten by a refresh unless you choose "Approve and replace my edit" for that row.
- **Full file management** — save your database anywhere, load it back, export a portable JSON payload. The File menu has New File, Open File, Save, Save As, Save a Backup Copy, Export to JSON, Import from JSON and Show File in Folder (the same commands are on the Settings page), and the app reopens the file you used last.
- **Print expiring credits** — File > Print Expiring Credits… (Ctrl+P) prints a list of credits and certificates expiring this month or this year, optionally travel only and optionally with certificates expiring through the end of next year. Each row can be left off, and a partly used credit shows the amount remaining.
- **Self-signed Windows installer** so the executable identifies itself as coming from Dunkin Global Advisors.
- **13 seeded cards, 4 seeded loyalty programs, 176 seeded benefits** — every value is linked to its published source page for quick verification.

## Seeded cards (v1.0.0)

Hilton Aspire · IHG One Rewards Premier · Amex Platinum · Delta SkyMiles Reserve · Citi AAdvantage Executive · Marriott Bonvoy Brilliant · Marriott Bonvoy Boundless · Marriott Bonvoy Bevy · Marriott Bonvoy Business · World of Hyatt · British Airways Visa · Virgin Atlantic World Elite (with a note that BofA discontinued issuance in October 2024) · Citi Prestige (closed to new applicants).

## Seeded programs

Delta SkyMiles Medallion · American AAdvantage · IHG One Rewards Ambassador · Marriott Bonvoy Elite.

The World of Hyatt program (elite tiers and Milestone Rewards) is not in the seed list. It is added by the refresh bundled with v1.0.27: an existing file is asked to approve it on the Quarterly Refresh screen, and a new file starts with it.

## Quick start

```bash
npm install
npm run dev          # Vite + Electron in dev mode
npm run test         # 139 Vitest tests across security / validation / boundary / functionality
npm run electron:build  # Build the Windows installer into dist-installer/
bash build/sign.sh   # Sign the installer with build/signing.crt (Windows only, requires osslsigncode)
```

## Platform modernization (v1.0.15)

The application now runs on **Electron 43**, React 19, React Router 7, Vite 8,
Vitest 4, Tailwind CSS 4, and TypeScript 7. The Tailwind integration now uses
the first-party Vite plugin and CSS-first theme configuration. `better-sqlite3`
is updated to the latest stable 12.x release; it intentionally does not use
13.x because that release line crashes in the supported Node 20 build sandbox.

## Data model

- **Cards** — issuer, network, annual fee, notes, color, source URL. Yours to add and delete.
- **Programs** — separate table for status/loyalty programs. Same fields.
- **Benefits** — belong to exactly one card OR one program. Each has a title, category, reset cadence, uses per period, dollar value, optional spend threshold, expiration note, and a source URL back to the official page.
- **Usages** — a row per redemption: benefit, date, dollar amount, optional note. The app tags each row with the correct period key at insert time so "used this quarter" queries never do calendar math on the fly.
- **Refresh runs** — a diff between the current database and the newly proposed benefit list. Each pending change is `pending`, then `approved` or `rejected`. Applying a run skips any benefit whose `is_user_modified` flag is set. The exception is a row you explicitly approved with "Approve and replace my edit".
- **Refresh proposals** — the prepared change lists behind a refresh run, kept as JSON in `refresh-proposals/` and compiled into the app by `scripts/build-refresh-proposals.mjs`. A proposal can carry a `not_before` date so that changes are offered on the day they take effect. The same JSON can be loaded by hand with **Load refresh file...** on the Quarterly Refresh screen. Since v1.0.27 a proposal can also add a whole loyalty program (`scope: "program"`, `change_type: "added"`) together with its benefits; the benefits are created only if the program row is approved. A `modified` benefit change can also name the row it now follows (`prerequisite_benefit_title`), which is how a new first milestone level is put in front of an existing one.

## File format

The app can save and load a JSON file describing your entire benefit ledger. The file version is checked on import; older files migrate forward automatically.

Your data itself lives in a single SQLite file (`cc-benefit-tracker.db`, by default in `%APPDATA%\cc-benefit-tracker`). Entries are written to it as you save them in the app. **File > Save** makes sure that one file is complete on disk; **Save As** moves your work to a new location, which the app records in `cc-benefit-tracker-settings.json` in the same default folder and reopens next time; **Save a Backup Copy** writes a copy without switching to it. Importing a JSON file replaces the open file's contents and asks for confirmation first.

## Windows installer

The signing certificate is a fresh self-signed key generated specifically for this application (`CN=Ann Dunkin, O=Dunkin Global Advisors, OU=Software, C=US`). Windows will still show a SmartScreen warning on first install — that's expected for any self-signed executable.

## Tests

```
tests/security.test.ts      · SQL injection, secret scanning, electron security posture, icon path guard
tests/validation.test.ts    · Required fields, CHECK constraints, cadence validation
tests/boundary.test.ts      · Period math, unicode, extreme values, 100+ benefits
tests/functionality.test.ts · CRUD, seed idempotence, refresh workflow, export/import round-trip
tests/refreshProposal.test.ts · Refresh proposals: validation of untrusted files, diffing, hand-edit protection, bundled refresh data
tests/refresh-ui.test.tsx   · Quarterly Refresh screen: review, approve, replace-my-edit consent, discard confirmation
tests/fileStore.test.ts     · Data files: identifying a tracker file, safe copy and replace, remembered location
tests/fileOps.test.ts       · File commands: New, Open, Save, Save As, backup copy, export, import confirmation, refusals
tests/file-ui.test.tsx      · Settings file buttons and the notice shown after a File menu command
tests/expiringCredits.test.ts · Expiring list: use-by dates, month/year boundaries, travel selection, amount remaining
tests/print-ui.test.tsx     · Print Expiring Credits screen: options, per-row ticks, partly used wording, printing
tests/localDate.test.tsx    · "Today" follows the computer's local date, not UTC
```

Run `npm run test` to see the full suite. All 411 tests pass on a clean checkout.

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
