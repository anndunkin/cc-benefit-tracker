# Changelog

All notable changes to Credit Card Benefit Tracker follow this file. Versions follow a simple `.` release pattern (never a major bump).

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
