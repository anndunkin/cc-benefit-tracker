# Credit Card Benefit Tracker v1.0.33 validation

The [v1.0.33 release](https://github.com/anndunkin/cc-benefit-tracker/releases/tag/v1.0.33) was built from [commit `f76e568`](https://github.com/anndunkin/cc-benefit-tracker/commit/f76e568bdbf8993569a0fdba5ec80f680717832c). The [Windows release workflow](https://github.com/anndunkin/cc-benefit-tracker/actions/runs/45489550232) passed. The verification below distinguishes release-time checks on the published installer from follow-up source tests on `main`.

## Published installer

- **Release suite:** Windows CI passed 435 tests across 18 files; two file-operation tests are intentionally skipped on Windows (removing an open file and Unix-style read-only permissions). TypeScript, the production build and the high-severity dependency audit gate passed. [Windows release workflow](https://github.com/anndunkin/cc-benefit-tracker/actions/runs/45489550232)
- **Installed functionality:** Two separate one-night Omni stays did not combine; logging one completed two-night reservation on the dashboard created a separate, unused award. The IHG summary showed the $250 minimum for a single flight-ticket purchase booked directly with the airline. The earlier Hyatt expiration edit was also retested without recording a redemption. [Windows validation transcript](https://github.com/anndunkin/cc-benefit-tracker/releases/download/v1.0.33/windows-validation.txt)
- **Upgrade and file safety:** Upgrade from v1.0.19 preserved data. The workflow also exercised same-version reinstall while the app was running, uninstall with data preservation, repair, fresh install after uninstall, reopening the last-used data file, saving a complete SQLite file, and fallback when the remembered file was unavailable. [Windows validation transcript](https://github.com/anndunkin/cc-benefit-tracker/releases/download/v1.0.33/windows-validation.txt)
- **Release integrity:** The installer passed SHA-256 Authenticode verification with the release-specific Dunkin Global Advisors certificate. The rebuilt, vendored and installed Electron SQLite bindings had identical SHA-256 hashes. The signing certificate is self-signed; Windows may still show a trust or SmartScreen warning. [Windows validation transcript](https://github.com/anndunkin/cc-benefit-tracker/releases/download/v1.0.33/windows-validation.txt)
- **Dependency audit detail:** The production-dependency audit reported no vulnerabilities. The full audit reported six moderate entries in the development packaging dependency chain for one [`minimatch` advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249); it reported no high or critical issues. The packaging dependencies were not changed in this follow-up.

## Source regression coverage

- **Award qualification:** Tests check that one-night reservations don’t combine, a future checkout and a dollar-only entry don’t qualify, two or more nights in one reservation do qualify, and repeat reconciliation doesn’t create duplicates. They also cover correcting a stay, preservation of prior redemption history, suppression of legacy automatic Omni renewals, saved expiration, and a JSON backup round-trip. [`tests/certificateAwards.test.ts`](../tests/certificateAwards.test.ts)
- **Dashboard and report:** Component tests save a stay through the actual form, verify the separate award and expiration control, and confirm the $250 wording in the IHG tile and report. [`tests/release20-ui.test.tsx`](../tests/release20-ui.test.tsx)
- **Follow-up tests on `main`:** A Dec. 31 checkout earns in the closing year; a new award requires a qualifying checkout in the new calendar year. An integration test applies the actual Omni and IHG bundled refresh records and checks that the award and report note go to their respective cards. The full follow-up suite passed all 439 tests in 18 files on Linux, including the two file-operation tests skipped on Windows. These are test-only additions; they do not change the already-published installer. [`tests/certificateAwards.test.ts`](../tests/certificateAwards.test.ts), [`tests/refreshProposal.test.ts`](../tests/refreshProposal.test.ts)

Reproduce the source checks with Node.js 22:

```bash
npm ci
npm run test
npx tsc --noEmit -p tsconfig.json
npm audit --audit-level=high
npm audit --omit=dev --audit-level=low
```

These tests use synthetic tracker files and a Windows CI runner. They verify the tracker, not a live Omni or Chase account or the contents of a user’s own file.
