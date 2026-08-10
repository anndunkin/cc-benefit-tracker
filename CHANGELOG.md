# Changelog

All notable changes to Credit Card Benefit Tracker follow this file. Versions follow a simple `.` release pattern (never a major bump).

## v1.0.14 — 2026-08-10

### Fixed
- **Installer picking `C:\Program Files\Benefits Tracker\Credit Card Benefit Tracker\` on machines with a stale empty folder there.** The v1.0.13 installer’s `customInit` set `$INSTDIR` only when the HKCU `InstallLocation` value was empty, and even then only to `$EXEDIR\Credit Card Benefit Tracker`. On machines where an old machine-wide install had left an empty `C:\Program Files\Benefits Tracker\Credit Card Benefit Tracker\` folder behind, electron-builder’s NSIS default noticed that folder and targeted it — which then failed mid-install with `Error opening file for writing: ...Uninstall Credit Card Benefit Tracker.exe` because Program Files needs admin write and this build ships as `perMachine:false + asInvoker`.
- **App window and taskbar showing the default Electron icon in packaged builds.** `resolveIconPath` was reading `app.getAppPath()` (which returns `<install>/resources/app.asar`) but the icon lives at `<install>/resources/assets/icon.ico` as an `extraResources` sibling, not inside the asar. Every packaged candidate path failed `fs.existsSync`, so `BrowserWindow({ icon })` fell back to Electron's default logo.

### Changed
- `scripts/installer.nsh` moves the path decision from `customInit` to `preInit` (which runs before electron-builder's own `$INSTDIR` defaulting), and unconditionally forces `$INSTDIR` to `$LOCALAPPDATA\Programs\Credit Card Benefit Tracker` on a fresh install. A prior `InstallLocation` in the registry is honored only when it points at a per-user writable location — any `$PROGRAMFILES` / `$PROGRAMFILES64` path (including the `Benefits Tracker\...` layout) is rejected as an unwritable ghost.
- `electron/iconPath.ts` now prefers `process.resourcesPath` in packaged mode and looks for `icon.ico` before `icon.png` on Windows so `BrowserWindow` receives a multi-resolution ICO (16 / 24 / 32 / 48 / 128 / 256). The path-traversal guard was extended to accept both the dev tree and the packaged `resourcesPath/assets` root instead of rejecting the packaged path.

### Testing
- +4 tests (139 total, up from 135):
  - `v1.0.14 packaging release > migrates an existing v1.0.13 database forward without touching data` — rolling `seed_version` back to `1.0.13` and re-running migrations records `v1_0_14_seed_refresh`, stamps forward, and leaves benefit / usage counts untouched.
  - `v1.0.14 packaging release > does not re-run the v1.0.14 migration on an up-to-date database`.
  - `installer.nsh preInit forces $LOCALAPPDATA install path` — asserts the NSH source contains the `preInit` macro, hard-codes `$LOCALAPPDATA\Programs\Credit Card Benefit Tracker`, and rejects `PROGRAMFILES\Benefits Tracker` as a prior-install candidate.
  - `iconPath resolves via process.resourcesPath in packaged mode` — simulates a packaged install layout under a tempdir and asserts `resolveIconPath` returns a path anchored on `resourcesPath/assets/`, not a dev-tree fallback.

### Notes
- v1.0.14 remains a packaging-only release. Data model, seed data, and UI are unchanged from v1.0.13. All benefit rows, usages, and user overrides are preserved.
- The `repair-uninstall-admin.cmd` (shipped separately on 2026-08-10) targets a related but distinct failure mode: cleaning up per-machine residue under `C:\Program Files\Benefits Tracker\...` from a much older install lineage. Users who already have a working v1.0.13 install do not need to re-run it — the v1.0.14 installer’s `preInit` change means the same trap cannot happen again.

---

## v1.0.13 — 2026-08-09

### Fixed
- **The "Credit Card Benefit Tracker cannot be closed. Please close it manually and click Retry to continue" install loop.** v1.0.12 fixed the pre-install `$INSTDIR` / registry residue problems, but a separate failure mode remained: mid-install, electron-builder's default `_CHECK_APP_RUNNING` NSIS macro (in `node_modules/app-builder-lib/templates/nsis/include/allowOnlyOneInstallerInstance.nsh`) prefers a PowerShell + `Get-CimInstance Win32_Process` probe that filters by `$_.Path.StartsWith('$INSTDIR', ...)`. On some Windows configurations that query throws, exits with an unexpected code, or false-positives against ghost process records, and the template's own retry loop then pops the "cannot be closed" dialog with no way for the user to escape — even after a full reboot. Tracked upstream as electron-builder issue #8131 and follow-ups.

### Changed
- v1.0.13 defines a `customCheckAppRunning` macro in `scripts/installer.nsh`. The electron-builder template honors this via `!ifmacrodef customCheckAppRunning` and skips its own `_CHECK_APP_RUNNING` entirely. The replacement is intentionally simple:
  1. `tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq Credit Card Benefit Tracker.exe"` piped through `findstr` — no PowerShell path, no CIM query.
  2. If found, `taskkill /F` once and re-check.
  3. If still found, show a single actionable dialog (`Open Task Manager, end every process...`) and exit. No retry loop.

### Added
- Repair scripts (`scripts/repair-uninstall.cmd` and `.ps1`) now start with a diagnostic step that lists every `Credit Card Benefit Tracker.exe` / `Uninstall Credit Card Benefit Tracker.exe` process the OS reports — the same signal the installer uses — so users can see exactly what (if anything) is being detected. The PowerShell version also prints the executable path for each match, which makes stray helper processes obvious.
- Repair scripts now also clear `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\<APP_GUID>` in case an older machine-wide install left an entry there.

### Testing
- New v1.0.13 suite covers: rolling an existing DB from `1.0.12` to `1.0.13` records `v1_0_13_seed_refresh` and stamps forward without changing benefit / usage counts; a fresh DB that is already stamped `1.0.13` does not re-run the v1.0.13 block on a subsequent migration pass.

### Notes
- v1.0.13 remains a packaging-only release. Data model, seed data, and UI are unchanged from v1.0.12. All benefit rows, usages, and user overrides are preserved.
- Updating Electron itself would not have fixed this; the failure lives in electron-builder's NSIS template, not in the Electron runtime.

## v1.0.12 — 2026-08-09

### Fixed
- **Uninstaller / reinstall repair.** Users who ran the v1.0.11 uninstaller before it had a chance to finish (for example, to force the new taskbar icon to refresh) could end up in a state where re-running the installer failed with `unable to find the .exe` and `the app is open`. The custom NSIS `customInit` macro was clobbering `$INSTDIR` on every launch, so the installer's built-in `ALLOW_ONLY_ONE_INSTALLER_INSTANCE` check pointed at a folder that no longer existed while the registry still advertised the app as installed. v1.0.12 changes `customInit` to only override `$INSTDIR` when there is no `InstallLocation` recorded in the registry — truly-fresh installs still land next to the setup .exe, but updates and reinstalls now correctly follow the registry back to the real install directory.
- **Uninstall now leaves the machine in a clean state.** A new `customUnInit` macro runs `taskkill /F /IM "Credit Card Benefit Tracker.exe" /T` before the uninstaller starts deleting files, so lingering app or helper processes can no longer hold file locks that stall the uninstall. A new `customUnInstall` macro then removes the `InstallLocation` value and (if present) the secondary per-GUID Uninstall registry key that electron-builder writes, so the next installer treats the machine as fresh instead of trying to reuse stale metadata.

### Added
- **Repair scripts for users who are already stuck.** `scripts/repair-uninstall.cmd` (Batch) and `scripts/repair-uninstall.ps1` (PowerShell) ship in the repo and in the release artifacts. Either script kills any lingering `Credit Card Benefit Tracker.exe` / `Uninstall Credit Card Benefit Tracker.exe` process, deletes both registry keys electron-builder writes for this app (`HKCU\Software\0cad1474-5477-5366-bb89-f2f01e551ded` and the matching `Uninstall` entry), removes leftover install folders from the common electron-builder locations, and clears leftover Start Menu / Desktop shortcuts. User data at `%APPDATA%\Credit Card Benefit Tracker` (the SQLite database with logged usage history) is deliberately left untouched.

### Testing
- New v1.0.12 suite covers: the fresh-install seed stamp lands at `1.0.12`, and rolling an existing DB back to `1.0.11` and re-running `applyDataMigrations` leaves benefit / usage counts unchanged while stamping forward to `1.0.12`.

### Notes
- v1.0.12 is a packaging-only release. No data-model changes, no seed edits, no UI changes. All benefit rows, usages, and user overrides are preserved unchanged from v1.0.11.

## v1.0.11 — 2026-07-29

### Fixed
- **Sky Club "Unlimited" duplicates on Delta Reserve removed for good.** v1.0.10 deleted the exact-title row, but some databases still carried older pre-rename variants (e.g. `Unlimited Sky Club after $75k Spend`, `Unlimited Delta Sky Club Access (75,000 spend threshold)`) that the exact-title DELETE missed. v1.0.11 widens the dedupe with a LIKE-based pattern that catches any Sky Club row on `delta_reserve` whose title mentions *Unlimited*, *75,000*, *75000*, or *$75*, migrates any logged usages onto the Amex Platinum combined Sky Club + Centurion row, and then deletes the leftover. The single legitimate `15 Delta Sky Club Visits per Medallion Year` row is untouched.
- **Marriott Bonvoy Bevy / Premier `1 Elite Night Credit per $3,000 spent (uncapped)` is now trackable.** The row previously used `reset_cadence = 'unlimited'`, which puts it in the Ongoing view with no earned-vs-cap count. It now uses `reset_cadence = 'annual'` with `uses_per_period = 999` so users can log one usage each time they cross another $3,000 in card spend and see how many Elite Night Credits they've earned this year. The 999 is a soft ceiling for trackability, not a real Marriott cap; existing usages are preserved during migration.
- **IHG One Rewards Ambassador `Complimentary Weekend Night` value set to $0.** The certificate value depends heavily on redemption context (property, night rate, blackout dates), so the previous $300 fixed value overstated the perk. Pre-v1.0.11 databases with the legacy $300 value are migrated to $0 automatically.

### Added
- **Custom app icon.** New teal + gold credit-card-with-checkmark icon replaces the placeholder. Ships as `assets/icon.png` (512×512) and `assets/icon.ico` (multi-size 16 / 24 / 32 / 48 / 64 / 128 / 256) so the Windows taskbar, installer, and shortcut all pick up the new artwork.
- **About dialog and full application menu.** New Help → About… entry (and macOS App menu About) shows the current app version, Electron / Node / Chromium versions, and a Copy version button. The header also now shows a `v1.0.11` badge that opens the same dialog when clicked, so the version is one click away without opening the native menus. The application now ships a full menu bar (File / Edit / View / Window / Help) on Windows and Linux with GitHub Repository and Report an Issue links.

### Testing
- New v1.0.11 suite covers: wide-pattern dedupe removes pre-rename Sky Club variants on `delta_reserve` while preserving the 15-visit row and migrating usages onto the Amex Platinum combo row; the seeded Marriott `1 EN per $3,000` row is `annual` / 999; a legacy `unlimited` Marriott EN row (with logged usages) migrates cleanly to `annual` / 999 without losing history; the seeded IHG Ambassador Weekend Night has `value_usd = 0`; a legacy `$300` value migrates to `$0`; the v1.0.11 `seed_version` stamp lands correctly.

## v1.0.10 — 2026-07-29

### Fixed
- **Migration guard bug: user edits (expiration dates, values) no longer disappear on restart.** The v1.0.3 → v1.0.9 migration guards used `!==` instead of `<`, so the entire migration chain re-ran on every launch and the seed UPSERT loop unconditionally overwrote user-entered `expiration_date`, `value_usd`, and `reset_cadence` fields. Guards now use a proper dotted-numeric `seedVersionLt(...)` comparison, so each migration runs at most once. The v1.0.10 UPSERT pass additionally checks `is_user_modified = 1` and preserves the user's `value_usd`, `expiration_date`, `expiration_note`, `reset_cadence`, `reset_years`, `uses_per_period`, and `spend_threshold_usd` when a row has been edited — only the description, category, sort order, source URL, and notes are refreshed from seed.
- **American Express Venue Collection deduped (Delta Reserve).** When v1.0.9 renamed the Venue row title, older migration passes couldn't find the pre-rename row and inserted a duplicate before the rename ran. v1.0.10 dedupes matching rows (keeps the lowest id, migrates any usages onto it, deletes the rest).
- **Nightly Upgrade Awards (2025) deduped (Marriott).** Same title-rename fallout as Venue; migration now dedupes so only one 2025 NUA row remains, and any logged usages survive on the surviving row.
- **Delta Reserve standalone "Unlimited Sky Club after $75,000 Spend" removed.** The combined Sky Club + Centurion row on Amex Platinum is the only surviving copy of this benefit; the Delta Reserve duplicate is deleted.
- **Virgin Atlantic "1 Personal Perk after $15,000 spend" → value $0.** Removed the misleading $300 flat value; the actual perk (hotel credit, lounge pass, points bonus, etc.) is entirely user-selected.
- **Virgin Atlantic "2nd Personal Perk after $30,000 spend" → value $0.** Same reasoning as above.
- **Virgin Atlantic "2,500 Virgin Points per Authorized User" → value $0.** Points value depends on redemption context, so the previous $130 fixed value was misleading.
- **British Airways Travel Together Ticket → value $0.** The certificate value depends entirely on the paid fare it accompanies; the previous $1,000 fixed value overstated the perk.
- **IHG $100 statement credit → value $100 (was $150).** The credit is $100 flat; the 10,000 bonus points are separate and heavily redemption-dependent, so the credit's `value_usd` now matches the dollar credit only.

### Added
- **Delta Medallion Choice Benefits restructured as tier gates with option children (AA-style).** Following the same pattern as the AA Loyalty Point tier system:
  - **"Platinum Medallion Choice Benefit (1 selection)"** is a hidden milestone row with 10 option children (4 Regional Upgrade Certificates, $250 Amex credit, 6,000 Starbucks Stars, $1,000 MQD Accelerator, gift 4 Silver Medallion, 35,000 bonus miles, $400 Delta Vacations, $250 SAF, $350 Delta voucher, $1,500 Wheels Up). Toggle *Select as choice* on the option you actually take; only selected options show in the dashboard.
  - **"Diamond Medallion Choice Benefits (3 selections)"** is a hidden milestone row with 14 option children (including 4 Global / 8 Regional / 2 Global + 4 Regional upgrade bundles, $500 Amex credit, Sky Club Individual (2 choices) or Executive (3 choices) membership, $2,000 MQD Accelerator, gift 4 Gold Medallion, 40,000 bonus miles, $500 Delta Vacations, $250 SAF, $550 Delta voucher, $2,000 Wheels Up).
  - Any usages logged on the legacy standalone "Global Upgrade Certificates (Diamond only)" or "Regional Upgrade Certificates (Diamond & Platinum)" rows are migrated onto the new "Diamond Choice - 4 Global Upgrade Certificates" and "Diamond Choice - 8 Regional Upgrade Certificates" children so no history is lost. Legacy rows are then removed.
- **12 carried-over Regional Upgrade Certificates from 2026 seeded.** New one-time row "Carried-over Regional Upgrade Certificates from 2026 (12 remaining)" tracks the RUCs carried forward with an assumed expiration of 2028-01-31 (adjust the date on the row editor if your certificates carry a different terminal date).

### Removed
- **IHG Ambassador Renewal row** removed from `ihg_ambassador`. Users track the paid renewal outside the app rather than as a negative-value benefit.

### Testing
- New v1.0.10 suite covers: idempotent migration guards preserve a user-entered `expiration_date` across three back-to-back `applyDataMigrations` calls; Venue duplicate rows dedupe and their usages survive; Delta Reserve Sky Club row is absent; 2025 NUA row is unique; Virgin/BA values are 0; IHG $100 credit is $100; Ambassador row is absent; Platinum tier gate has 10 option children linked via `prerequisite_benefit_id`; Diamond tier gate has 14 option children; the 12-cert carry-over row has `uses_per_period = 12`, `reset_cadence = one_time`, and `expiration_date = 2028-01-31`; usages on legacy Delta upgrade rows migrate cleanly onto the new choice children; and a user-modified row with a custom `value_usd = 999` and `expiration_date = 2027-05-05` retains those values through the v1.0.10 UPSERT pass while still receiving the refreshed description.

## v1.0.9 — 2026-07-29

### Fixed
- **Amex Venue Collection is clarified as 10% off concessions.** The benefit was previously logged as a flat $25 credit. Retitled to "American Express Venue Collection (10% off concessions, up to $250/yr)" with the correct $250 annual cap and a description explaining the 10% cash-back mechanic on eligible ticketed events.
- **Standalone Amex Platinum Centurion row cleaned up (belt-and-suspenders).** Any lingering copy of the standalone Centurion Guest Access row is deleted idempotently on the v1.0.8 → v1.0.9 path so the combined Sky Club + Centurion row is the only survivor.
- **Virgin third-night-free and 5,000-point anniversary bonus no longer show a dollar value.** Both rows have their `value_usd` reset to 0 since these perks are heavily context-dependent and the previous fixed dollar values were misleading.
- **Hyatt free-night awards no longer show a dollar value.** Both the annual free night and the spend-threshold free night are set to `value_usd = 0`; the point value depends on category and cash rate at redemption, so a fixed number was misleading.

### Added
- **Carry-over benefit support.** Benefits can now be seeded with a fixed `expiration_date` and `reset_cadence = one_time`, letting rewards earned in a prior year carry forward with their real expiration. The base seed insert and the v1.0.9 UPSERT loop both write `expiration_date` so existing DBs pick up the new column values.
- **Two Hyatt Category 1-4 carry-over rows** are now seeded: one expiring 2026-11-26 and one expiring 2027-03-27. Both are one-time, single-use benefits.
- **Marriott Bonvoy Annual Choice Benefits are gated by achievement.** Modeled like the AA Loyalty Point tier system:
  - A hidden "50 Elite Nights - Choice Benefit unlocked" milestone row becomes visible once the user logs the qualification.
  - Five choice options at the 50-night milestone (5 Nightly Upgrade Awards, 5 Elite Night Credits, $1,000 bed/mattress, gift Silver status, $100 charity) are hidden until the milestone is achieved, and once achieved the user selects a single option per benefit.
  - A chained "75 Elite Nights - Additional Choice Benefit unlocked" row (prerequisite = 50-night milestone) exposes six 75-night choice options (Free Night up to 40k, 5 Elite Night Credits, gift Gold status, 5 more Nightly Upgrade Awards, $1,000 bed/mattress, $100 charity).
  - Any usages logged on the legacy "Annual Choice Benefit at 50/75 Elite Nights" rows migrate onto the new milestone row so no history is lost.
- **Nightly Upgrade Awards restructured to a real earn ledger.** Replaces the annual reset row with a `one_time` benefit "Nightly Upgrade Awards (10 earned in 2025)" with 10 uses and an explicit expiration date of 2026-12-31 (matches Marriott's "expire December 31 of the year after they were earned" rule).
- **Hyatt Discoverist status is now an ongoing benefit.** Reset cadence changed from `annual` to `unlimited` so it shows up as an always-available status perk rather than a benefit that resets each year.

### Removed
- **Marriott Lifetime Platinum Elite** row removed entirely. It was a lifetime-earned status, not a benefit to track annually.
- **Legacy flat "Annual Choice Benefit at 50 Elite Nights" and "Annual Choice Benefit at 75 Elite Nights" rows** superseded by the gated milestone + choice-option structure above. Any usage rows are migrated onto the new milestone parents.

### Testing
- New v1.0.9 suite covers: Hyatt carry-over rows exist with correct `expiration_date`; Marriott milestone parents exist and are hidden until achieved; Lifetime Platinum row is absent; the old "Nightly Upgrade Awards (formerly Suite Night Awards)" row is absent and the new "10 earned in 2025" row has `uses_per_period = 10` and `expiration_date = 2026-12-31`; Discoverist is `unlimited` cadence; Virgin/Hyatt values are 0; Venue Collection is retitled with the 10% description; and the full v1.0.6 → v1.0.9 upgrade path correctly rewrites Bonvoy rows without dropping user usage history.

## v1.0.8 — 2026-07-28

### Fixed
- **Amex Platinum Sky Club + Centurion perks are now one benefit.** They unlock together at the same $75,000 calendar-year spend threshold, so tracking them as two separate rows was misleading. Combined into a single benefit; any usage/spend logged on the standalone Centurion row is migrated onto the merged row so nothing is lost.
- **AA Loyalty Point tiers no longer duplicate.** Every LP tier (60K/100K/175K/250K/400K) was appearing twice — once with a legacy em-dash title from v1.0.0 and once with the current hyphen title from v1.0.6+. The v1.0.6 seed rewrite left the em-dash rows orphaned in existing DBs. v1.0.8 removes those legacy rows and moves any usages onto the current tier row.
- **Removed obsolete high LP tiers.** 550K, 750K, 1M, 3M and 5M rows lingered from v1.0.0 (dropped from later seeds). The AA program only publishes rewards up through 400K in the current version.
- **175K tier no longer shows a $250 value.** The legacy em-dash 175K row carried the old $250 marker from v1.0.0. Deleting it removes the stray dollar value alongside the duplicate.
- **Log Usage amount field is more resilient.** Every save now clears the amount and notes state, so re-opening a benefit's modal doesn't inherit stale input. Spend-threshold benefits no longer prefill with any prior value — the field always starts empty, ready for the fresh increment.

### Testing
- New v1.0.8 suite: combined Amex Platinum row present + duplicates gone, no em-dash LP tiers surviving, no LP tiers above 400K, every LP tier-gate row has value_usd = 0, and full v1.0.6 → v1.0.8 upgrade path with usage-migration verification.

---

## v1.0.7 — 2026-07-28

### Fixed
- **Spend-progress benefits now let you enter dollar amounts.** The Log Usage dialog was hiding the amount field for benefits whose value is unlocked by spend (SkyClub $75k, Centurion $75k, Delta Reserve $75k spend rewards, IHG $20k / $40k unlocks, Marriott $60k Ambassador, Hyatt $15k Globalist, BA $30k Companion Voucher, VS £15k/£30k Personal Perks, and the VS monthly Tier Points on Spend). The field is now always visible for `spend_threshold` benefits with a clear helper that shows the spend goal.
- **Legacy Virgin Atlantic “Tier Points on Spend” duplicate finally removed.** The v1.0.6 cleanup used the wrong card_id and never fired. v1.0.7's migration targets `card_id = 'virgin_atlantic'` correctly.
- **Admirals Club Access reference row removed.** The old `aa_status` program-level “Admirals Club Access” row (dropped from the v1.0.6 seed) still lingered in existing DBs. v1.0.7 explicitly deletes it. The real Admirals Club Membership benefit lives on the `aa_executive` card as an ongoing (unlimited) benefit with no dollar value.
- **IHG anniversary free night no longer carries a dollar value.** Because point value varies widely by property, `value_usd` for the Anniversary Free Night is now 0. Notes describe it as a point redemption up to 40,000 points.
- **IHG One Rewards Platinum Elite moved to ongoing.** Both the card-linked automatic status (IHG Premier) and the program-tier status now use `unlimited` cadence, so they appear under the Ongoing tab rather than looking like a resetting yearly benefit.

### Changed
- **AA elite ladder shows only achieved tiers plus the next one.** The dashboard now walks each prerequisite chain and hides tiers past the immediate next unmet tier. The “Choose rewards” button appears only after the parent tier itself has been achieved.
- **v1.0.7 migration re-runs the seed UPSERT** so IHG anniversary night and IHG Platinum Elite Status updates flow into pre-existing databases.

### Testing
- New tests cover: spend_threshold amount visibility, orphan `Admirals Club Access` deletion, VS legacy `Tier Points on Spend` deletion, IHG anniversary night value = 0, IHG Platinum Elite (card + program) cadence = unlimited, v1.0.6 → v1.0.7 upgrade path with legacy rows present.

---

## v1.0.6 — 2026-07-28

Data/UX iteration prompted by the user's second review pass. Fixes and refinements to how visits, spend-unlocks, cadences, and AA elite tiers are modeled; also purges a handful of legacy rows still lingering in existing databases from earlier seed versions.

### Fixed
- **Delta Sky Club visits logged as count, not dollars.** The "15 Delta Sky Club Visits per Medallion Year" benefit (Delta Reserve) now explicitly instructs the user to log each visit as one use, no dollar amount. Progress reads `visits_used / 15`; no more inflated dollar totals for lounge visits.
- **Duplicate Virgin Atlantic rows removed.** The legacy `"Tier Points on Spend"` and `"2,500 Virgin Points per Authorized User"` benefit rows (which were superseded by more specific titles in a later seed) are deleted from existing databases by v1.0.6 migration.
- **Legacy Bank of America benefit rows removed.** Any leftover benefit rows still tagged `[LEGACY BofA card]` are deleted from existing databases (the user does not hold any BofA products under the tracker's supported set).
- **Deleting a logged usage removes its dashboard row.** `LogUsageModal` already surfaced this in v1.0.5 for open-modal edits; verified end-to-end via new functionality test.

### Changed
- **Delta Reserve unlimited Sky Club access after $75,000 spend.** New spend-threshold benefit on Delta Reserve modeling the unlimited Sky Club unlock at $75k of qualifying spend on the card. Source: [delta.com/us/en/delta-sky-club/access](https://www.delta.com/us/en/delta-sky-club/access).
- **Amex Platinum unlimited Centurion Lounge guest access after $75,000 spend.** New spend-threshold benefit on the Business Platinum card mirroring the current terms: no per-visit guest fee once cardholder spend hits $75k in a calendar year. Source: [thecenturionlounge.com/info/terms](https://www.thecenturionlounge.com/info/terms/).
- **Uber One membership credit cadence.** Moved from the ambiguous "other" category to `monthly` cadence (`uses_per_period: 1`) so the benefit resets each month like a normal recurring credit.
- **Amex Platinum $200 Uber credit description clarified.** Now explicitly documents the $15/mo Jan–Nov + $35 December schedule so the user does not lose the December stub.
- **Bonvoy Gold + Hilton Honors Gold statuses are ongoing.** Both cardholder-status benefits (Amex Platinum → Bonvoy Gold + Hilton Gold; Marriott Bonvoy Business → Bonvoy Gold) now use `reset_cadence: 'unlimited'` and appear on the Ongoing tab.
- **AA Admirals Club Access is ongoing.** The AA Executive card's Admirals Club membership benefit is now `unlimited`/ongoing rather than a countable annual benefit — access is continuous while the card is active.

### Added
- **AAdvantage tier prerequisite chain + Loyalty Choice Reward split (≤400K only).** The AA elite ladder is now modeled as a proper prerequisite chain: `15K Loyalty Points → Gold (60K) → Platinum (100K) → Platinum Pro + 1 Choice (175K) → Executive Platinum + 2 Choices (250K) → 400K + 2 Choices`. Each Loyalty Choice Reward menu is broken out into individual `is_choice_option` child rows keyed to their parent tier. Only tier ladders ≤400K are enumerated (555K/750K/1M/3M/5M are outside the practical scope of this tracker). Systemwide Upgrades and Complimentary Upgrades by Status Tier remain as unlimited reference rows.
- **`prerequisite_benefit_id`, `is_choice_option`, `choice_selected` columns on benefits.** New schema fields let a benefit declare a parent benefit that must be achieved before it appears on the dashboard, and let choice-option rows stay hidden until the user explicitly picks them.
- **Dashboard filtering for locked / unpicked benefits.** Benefits whose prerequisite has not been reached are hidden; benefits flagged as choice options only render once the user ticks them.
- **"Choose rewards" picker.** Any parent tier that has choice-option children now shows a **Choose rewards (N)** button. The picker lists each child option with a checkbox; ticked options appear on the dashboard, unticked options stay hidden. Manual selections survive re-seed — the v1.0.6 seed refresh does not overwrite `choice_selected`.

### Migration notes
- Existing databases at `seed_version` ≤ 1.0.5 have three columns added, legacy Virgin Atlantic + BofA rows deleted by title, all seed benefits re-upserted, and the prerequisite title→id links wired via a title lookup. `seed_version` is set to `1.0.6` on completion. Fresh installs go straight to `1.0.6` seed with prerequisite FKs resolved in-line.

## v1.0.5 — 2026-07-28

Restore Marriott Rewards Premier Visa (user has this card; it was removed in v1.0.4 by mistake), model Global Entry / TSA PreCheck reset windows correctly (4 years for Amex/Chase, 5 years for Citi), and delete a stray Citi Prestige informational tile.

### Added
- **`reset_years` field on benefits.** New nullable `INTEGER` column on `benefits` for `one_time` benefits that reset on a multi-year cycle. Editable in the benefit editor (only visible when the reset cadence is set to `one_time`). Dashboard tiles for `one_time` benefits with `reset_years` set now render a **"Last used: YYYY • Next available: YYYY"** line; when the next-available year is at or before the current year, the line turns green with an "(available now)" hint.
- **Marriott Rewards Premier Visa is back.** Card row and all 10 seeded benefits restored to `GENERATED_CARDS` / `GENERATED_BENEFITS` and to `FALLBACK_CARDS`. Existing installs get it re-inserted via the v1.0.5 migration UPSERT.

### Fixed
- **Citi AA Executive Global Entry credit corrected to a 5-year reset.** v1.0.4 modeled every Global Entry credit with the same reset; Citi's terms actually resets every 5 years, while Amex Platinum, Chase IHG Premier, and Delta Reserve reset every 4 years. Sourced from the Citi AA Executive product page ([creditcards.aa.com](https://creditcards.aa.com/credit-cards/citi-executive-card-american-airlines-direct/)), Amex's expedited-travel benefits page ([americanexpress.com](https://www.americanexpress.com/en-us/benefits/travel/expedite-your-travel/)), and Chase IHG Premier's product page ([chase.com](https://creditcards.chase.com/travel-credit-cards/ihg-rewards-club/premier)). Citi Prestige also stays at 5 years ([One Mile at a Time](https://onemileatatime.com/guides/citi-prestige-card/)).
- **`reset_years` populated on all five Global Entry tiles.** IHG Premier / Amex Platinum / Delta Reserve = 4; AA Executive / Citi Prestige = 5.
- **Citi Prestige "Closed to New Applicants" informational tile removed.** Was a benefit-shaped row that displayed as a normal tile on the Citi Prestige card page; deleted from the seed and from existing DBs via the v1.0.5 migration.

### Migration path
On first launch of v1.0.5, `applyDataMigrations` runs a one-shot upgrade for any install with `seed_version != '1.0.5'`:
1. `ALTER TABLE benefits ADD COLUMN reset_years INTEGER` (idempotent via `PRAGMA table_info`).
2. `DELETE FROM benefits WHERE card_id = 'citi_prestige' AND title = 'Closed to New Applicants (existing benefits retained)'`.
3. `INSERT OR IGNORE` marriott_premier card, then UPSERT every seeded benefit by `(card_id, program_id, title)` so `reset_years` lands, AA Exec's 5-year window replaces the previous 4-year value, and the 10 marriott_premier benefit rows re-materialize.
4. Stamp `seed_version = '1.0.5'`.

### Tests
- AA Exec GE resets every 5 years (reset_years + description regex).
- Amex Platinum / IHG Premier / Delta Reserve GE reset every 4 years.
- Citi Prestige GE resets every 5 years.
- marriott_premier is seeded with at least 10 benefits.
- Citi Prestige "Closed to New Applicants" tile is absent from the seeded DB.
- `reset_years` persists on `benefitCreate` and `benefitUpdate`.
- Legacy DB gains `reset_years` column after migration.
- Existing v1.0.4 assertions updated: seed stamps `1.0.5`, marriott_premier is preserved (not purged), and the seeded card count is `>= 11` again.

## v1.0.4 — 2026-07-28

Dashboard history, per-card visibility toggle, seed corrections, and a few tile clean-ups. Every change is covered by the v1.0.4 migration so existing installs converge on first launch.

### Added
- **Per-benefit history strip on the dashboard.** Consumable tiles now show a compact dot-row under the progress bar with one dot per period in the current reference year: green = used at cap, amber = partial, gray = unused (past), faint = future. Hover for the exact dollars-used and use-count for that period. Driven by a new `period_history` field on `BenefitProjection` and a `buildPeriodHistory(db, benefit, refYear, today)` helper.
- **`expiration_date` field on benefits.** New nullable `TEXT` column on `benefits`. Editable via the benefit editor with a native date picker. When set, tiles show a 📅 expiration line so free-night certificates and other time-boxed awards no longer rely on the free-form expiration note.
- **Per-card visibility toggle.** New `is_visible INTEGER NOT NULL DEFAULT 1` column on `cards`, plus `cardSetVisible(db, id, visible)` and a `cards:setVisible` IPC. Cards page shows a "Show on dashboard" checkbox next to each card; hidden cards render dimmed with a "Hidden" badge, and dashboard projections filter them out. Program benefits are unaffected. Lets users toggle cards they don't own (Marriott Bonvoy Brilliant, Boundless, and Bevy) without deleting the seed rows.

### Fixed
- **Marriott Rewards Premier Visa removed from seed.** The Chase Marriott Premier card has been closed to new applicants since 2018; per user report it should not be in the default deck. Removed from both `GENERATED_CARDS` and `FALLBACK_CARDS` and all its benefit rows are gone. The v1.0.4 migration also deletes `marriott_premier` from any installed DB and cascades its benefits.
- **Global Entry / TSA PreCheck credit no longer annualized.** Was previously modelled as a $24/year credit (five-year fee divided by five). Corrected to a single-use benefit with `value_usd = 120`, `uses_per_period = 1`, and `reset_cadence = 'annual'` — the tile now reads "1 of 1 used" with a $120 value. Applied across every card that offers this credit: IHG Premier, Amex Platinum, Delta Reserve, Citi AA Executive, and Citi Prestige.
- **Amex Platinum Global Lounge Collection moved to ongoing.** Was annual/uses_per_period=1; there's no annual reset for lounge access. Set to `reset_cadence = 'unlimited'` with `value_usd = 0` so it shows on the ongoing dashboard instead of the consumable one.
- **Amex Platinum Car Rental Elite Status (Hertz, Avis, National) moved to ongoing.** Same rationale — status is continuous, not annually consumed.
- **Delta Reserve Annual Companion Certificate `value_usd` zeroed.** The certificate has no fixed cash value (redeems for a Y-fare domestic Main Cabin companion ticket). Was $500; now $0 so it doesn't inflate the annual value totals. Still tracks as annual/uses_per_period=1.
- **Delta Reserve Hertz President's Circle Status moved to ongoing.** Continuous status, not annual.
- **Citi Prestige Priority Pass Membership moved to ongoing.** Membership is continuous; `value_usd = 0` (there's no fixed annual cash value to a lounge pass).
- **Virgin Atlantic card renamed to "Virgin Atlantic Credit Card".** Header now shows the plain card name instead of the older marketing string.
- **Tiles hide the "per use" field when the benefit has no dollar value.** Point-based benefits (free-night awards, upgrade certificates, status boosts) no longer show a misleading `$0.00` "per use" pill on the dashboard. The pill only appears when `value_usd > 0`.
- **Marriott Bonvoy Brilliant, Boundless, and Bevy purge re-runs in the v1.0.4 migration.** Idempotent; harmless on any DB where the previous v1.0.3 purge already ran.

### Migration path
On first launch of v1.0.4, `applyDataMigrations` runs a one-shot upgrade for any install with `seed_version != '1.0.4'`:
1. `ALTER TABLE cards ADD COLUMN is_visible INTEGER NOT NULL DEFAULT 1` and `ALTER TABLE benefits ADD COLUMN expiration_date TEXT` (idempotent via `PRAGMA table_info`).
2. `DELETE FROM cards WHERE id IN ('marriott_bonvoy_brilliant', 'marriott_bonvoy_boundless', 'marriott_bonvoy_bevy', 'marriott_premier')` — FKs cascade to their benefits and usages.
3. Rename `virgin_atlantic` card to "Virgin Atlantic Credit Card" if it's still under a legacy name.
4. `INSERT OR IGNORE` every currently-seeded card and program, then UPSERT every seeded benefit by (card_id, program_id, title) so the v1.0.4 corrections land in existing DBs. Existing `benefit.id` values are preserved, so all logged usages continue to point at the correct benefit.
5. Stamp `seed_version = '1.0.4'` in `app_meta`.

### Tests
- 71 passing (up from 63 in v1.0.3). New v1.0.4 coverage: `marriott_premier` purge, `is_visible` / `expiration_date` column additions on legacy DBs, Virgin Atlantic rename, `cardSetVisible` filters `computeProjections`, `expiration_date` persistence on create + update, `period_history` presence, and every seed correction (Global Entry $120, Priority Pass unlimited, President's Circle unlimited, Companion Certificate $0, Global Lounge unlimited, marriott_premier absent).

## v1.0.3 — 2026-07-28

Corrections to v1.0.2, which shipped with broken totals and stale card data still visible in installed copies. This release both fixes the underlying seed data and installs the migration path that v1.0.2 was missing.

### Fixed
- **Sub-year benefit values were still storing annual sums.** v1.0.1 corrected six *quarterly* rows but left every *monthly* and *semiannual* row wrong. Fixed 10 rows across Hilton Aspire, IHG Premier, Amex Platinum, Delta Reserve, and Citi AA Executive so `value_usd` now holds the true per-USE dollar amount and `uses_per_period = 1` in every case. `computeProjections` annualizes with `value_usd × uses_per_period × periodsPerYear` where `periodsPerYear ∈ {monthly:12, quarterly:4, semiannual:2, annual:1, one_time:1}`. Examples: Amex Platinum Uber $15/mo → $180/yr; Hilton Aspire Resort $200/half → $400/yr; IHG Instacart $10/mo → $120/yr.
- **Installed databases now receive seed updates.** `seedIfFresh` is idempotent — it never rewrites existing card/benefit rows — so any change to `benefitsSeedData.ts` never reached users who installed v1.0.0/v1.0.1/v1.0.2. New `applyDataMigrations` v1.0.3 path UPSERTs every seeded benefit by (card_id, title). Preserves `benefit.id`, so all logged usages continue to point at the correct benefit. Gated on `app_meta.seed_version` so it runs exactly once per install.
- **Deprecated Marriott cards now purged from installed databases.** Removed `marriott_bonvoy_brilliant`, `marriott_bonvoy_boundless`, and `marriott_bonvoy_bevy` from both fallback and generated seeds, and the v1.0.3 migration deletes them from existing DBs. FK cascade removes their benefits and any usages logged against them. Marriott Business (Amex) and Marriott Premier (Chase legacy) remain.
- **Header totals are now annualized.** The dashboard "Value remaining" and "Value used" tallies previously summed each benefit's *current-period* dollar cap, so a quarterly $50 credit contributed $50 to the year total instead of $200. `computeProjections` now returns `annual_value_usd`, `annual_value_used_usd`, and `annual_value_remaining_usd` for each benefit, and `BenefitDashboard` sums those. Sub-year usages (quarterly, monthly, semiannual) are rolled up across the full reference year.
- **Partial-amount usages now credit against the dollar cap.** For a benefit that stores a real per-use dollar value, status now keys off `value_used_usd` vs `total_value` rather than `uses_count` vs `uses_max`. Logging $30 against a $50 quarterly airline credit stays "partial" with $20 left instead of jumping to "exhausted." Point-based, status-boost, and count-only benefits still use the count-based status resolution.
- **Spend-threshold trackers now track spend, not uses.** The $30K and $60K Hilton Aspire free nights and the $60K Marriott Business free night are `spend_threshold` benefits: the *dollar value* is the free night itself (points-based), and the *trigger* is calendar-year card spend. Tiles now show a progress bar of "$X of $Y spent" with "$Z to go / Unlocked," driven by a new `spend_progress_usd` projection field.
- **Hilton annual free nights carry no dollar value.** Both the Aspire annual free night and the two Aspire spend-based free nights are points-based redemptions whose dollar value depends entirely on the property chosen. `value_usd` is now `0` on all three (spend thresholds are preserved). Marriott Business anniversary and $60K free nights also switched to `value_usd = 0`.
- **Moved insurance / status benefits to Ongoing.** These are not consumable credits; they were surfacing on the Credits & Usages page with a fake "1 use / year" toggle. Now `reset_cadence = 'unlimited'` (with `uses_per_period = null`):
  - Complimentary Hilton Honors Diamond status (Aspire)
  - National Emerald Club Executive status (Aspire)
  - Cell Phone Protection (Hilton Aspire, Amex Platinum, Delta Reserve, Citi Prestige)

### Added
- Tile UI for `spend_threshold` benefits shows a progress bar of cumulative spend toward the threshold instead of a generic "unlocks at $X" hint.
- `computeProjections` returns yearly aggregates (`annual_value_usd`, `annual_value_used_usd`, `annual_value_remaining_usd`) plus `spend_progress_usd`.

### Tests
- 63 tests passing (up from 48 in v1.0.1 / 59 in v1.0.2). New coverage in v1.0.3:
  - v1.0.3 seed-refresh migration: purges deprecated Marriott cards and cascades their benefits
  - Migration UPSERTs seeded benefits and preserves user usages (usage count unchanged after migration)
  - Migration is idempotent — running twice does not double-insert cards or benefits
  - Migration stamps `seed_version = 1.0.3` in `app_meta`
- v1.0.2 coverage retained: annualized totals math for quarterly/semiannual/monthly/annual, partial-amount status resolution, spend-threshold progress accumulation, seed data assertions for moved-to-unlimited benefits, zeroed Hilton free-night dollar values.

### Migration behavior
On first launch of v1.0.3, `applyDataMigrations` runs a one-shot upgrade for any install with `seed_version != '1.0.3'`:
1. Delete `marriott_bonvoy_brilliant`, `marriott_bonvoy_boundless`, `marriott_bonvoy_bevy` cards. FK cascade removes their benefits and any usages on them.
2. INSERT OR IGNORE every seeded card and program (adds Marriott Business + Marriott Premier for anyone missing them).
3. For each seeded benefit, look up by (card_id, program_id, title). If found, UPDATE all metadata columns — `benefit.id` is preserved so usage rows stay linked. If not found, INSERT.
4. Stamp `seed_version = '1.0.3'` in `app_meta`.

User-added cards, user-added benefits, and all logged usages are untouched.

## v1.0.2 — 2026-07-28  *(broken — superseded by v1.0.3)*

Attempted to fix quarterly totals and add spend-threshold tracking, but shipped with two remaining bugs: (a) monthly/semiannual rows still stored annual sums in `value_usd`; (b) no migration path existed, so installed databases from v1.0.0/v1.0.1 kept the old broken data and the deprecated Marriott cards. The dashboard code was correct; the data behind it was not. See v1.0.3 for the actual fix.

## v1.0.1 — 2026-07-28

Follow-up on feedback from the initial build session.

### Fixed
- **Virgin Atlantic card identity** — replaced the discontinued Bank of America Virgin Atlantic World Elite Mastercard with the current Virgin Red Rewards Mastercard from Synchrony Bank (11 benefits rewritten against [synchrony.com/partner/virgin-red-rewards-card](https://www.synchrony.com/partner/virgin-red-rewards-card)).
- **Quarterly / monthly credit math** — six quarterly benefit rows (Hilton airline, Hilton resort, Amex Green CLEAR, Amex Green Away, Delta Reserve resort, Amex Platinum Resy) now store `uses_per_period=1` with `value_usd` set to the per-quarter dollar cap instead of the annual sum. The Details page's exhaustion math now matches what the user actually sees on the card statement.
- **Marriott personal card identity** — removed the three seeded candidates (Bonvoy Brilliant, Boundless, Bevy). The user's actual card is the legacy Chase Marriott Rewards Premier Visa ($85 annual fee, closed to new applicants since 2018). Ten Premier-specific benefits added from [marriott.chase.com/premier](https://marriott.chase.com/premier).

### Changed
- **Dashboard split** into two pages that share a single `BenefitDashboard` component:
  - **Credits & Usages** (`/`) — the original consumable dashboard covering annual, semiannual, quarterly, monthly, one-time, and spend-threshold benefits. Log usage, track dollar burn, filter by cadence.
  - **Ongoing Benefits** (`/ongoing`) — reference-only tiles for `unlimited` benefits (Amex Platinum lounge access, Delta upgrade lists, Marriott Silver status, etc.). No usage logging, no totals, no cadence dropdown.
- **Single-use "Mark used" toggle** — benefits with `uses_per_period === 1` now expose a one-click "Mark used" button that logs a null-amount, null-note usage for today. A second click un-marks. Backdating and annotating still available via the "Details…" button.

### Tests
- 48 tests passing (up from 46): added "quarterly benefit reports per-period max and only counts current-quarter usages" and "single-use toggle: null-amount usage still counts toward exhaustion".

## v1.0.0 — 2026-07-27

Initial release.

### Added
- Electron + React + TypeScript + SQLite scaffolding with `contextIsolation:true` / `nodeIntegration:false` preload bridge.
- Seed catalog covering 13 credit cards, 4 loyalty programs, and 176 benefits, generated from public issuer / airline / hotel pages. Every value carries a source URL back to the page it came from.
- Separate **Cards** and **Programs** sections so status-driven benefits (Delta upgrades, Marriott suite nights, IHG Ambassador perks) don't clutter the card list.
- Reset-cadence coverage for annual, semiannual, quarterly, monthly, spend-threshold, one-time, and unlimited benefits.
- Usage log per benefit with date, dollar amount, and optional note; per-period bucketing at insert time.
- **Diff & review quarterly refresh workflow** — the app proposes a change set from a new source of truth; each pending row is approved or rejected before it touches saved data. Benefits with `is_user_modified=1` are always skipped by an applied refresh run.
- Full file management: save the database anywhere, load it back, export a portable JSON payload with a version stamp.
- Windows NSIS installer signed with a self-signed 10-year SHA-256 certificate (`CN=Ann Dunkin, O=Dunkin Global Advisors, OU=Software, C=US`) — freshly generated for this application, not reused from other Dunkin Global Advisors apps.
- 46-test vitest suite across security, validation, boundary, and functionality — all passing on a clean checkout.

### Notes
- Virgin Atlantic World Elite Mastercard (Bank of America) is included with a note that it was discontinued to new applicants in October 2024. The live U.S. co-brand is the Virgin Red Rewards Mastercard from Synchrony.
- Citi Prestige is included with a note that it is closed to new applicants.
- Amex Platinum reflects the 2025 refresh: $895 fee, Resy $400, lululemon $300, Oura $200, Uber One $120; the old Saks credit is removed.
