# Changelog

All notable changes to Credit Card Benefit Tracker follow this file. Versions follow a simple `.` release pattern (never a major bump).

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
