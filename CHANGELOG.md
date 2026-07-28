# Changelog

All notable changes to Credit Card Benefit Tracker follow this file. Versions follow a simple `.` release pattern (never a major bump).

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
