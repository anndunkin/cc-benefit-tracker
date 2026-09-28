# Credit Card Benefit Tracker 1.0.20

This update implements the nine requested changes to Credits & Usages. It preserves the existing desktop application and local file-management workflow; no cloud data account or telemetry is introduced.

## Installation

Use File > Export JSON or Save As to make a backup before upgrading. Close the app and run the Windows Setup executable over your existing installation; uninstalling first is not required.

The default location remains your per-user Local AppData Programs folder. Open About to confirm version 1.0.20.

## Using the changes

- **Hide credits:** Click Hide on a credit. Enable Show hidden to see it again, then click Unhide. History stays intact; hidden credits are omitted from totals.
- **Platinum Sky Club duplicate:** The migration merges unlimited-access variants into the combined Sky Club/Centurion row and transfers usage history.
- **Marriott Premier earned nights:** Click Log nights earned and enter newly earned nights for the entry, not your year-to-date cumulative total. Previous one-entry/one-night records still count as one night.
- **Free-night expiration:** Open Details or Log usage on the Hyatt annual Category 1-4 or Marriott Business annual award. Save expiration only records the date without consuming a night. Clearing the date and saving removes it. Save usage records both the date and the usage atomically.
- **Lyft:** The supplied $15/month change starts September 1, 2026; January through August remain $10/month. The 2026 annual scheduled value is $140, not $180.
- **Milestones:** AA LP/status, Marriott Choice and Delta Choice parent tiles display Achieved instead of Used. Individual selected rewards still track actual usage separately.
- **Diamond:** Mark achieved once, then choose rewards using three inputs. Choices are stored for the selected year. A two-choice membership uses two slots and a three-choice membership uses all three; leave unneeded inputs blank. This is a recording tool, not a replacement for issuer eligibility rules.
- **MQD reference:** The Delta Medallion Tier MQD Requirements tile is inactive, but previous history remains available in stored data.

## Signing and trust

The previous private signing key was unavailable in this session and no signing secret was configured in the repository. This release uses a new self-signed certificate with the existing Dunkin Global Advisors identity. It is not a commercial/publicly trusted certificate, so Windows can still show a trust warning.

The build signs the application before packaging, then signs the uninstaller and installer. The public certificate is included with the GitHub release; no private key is committed or published. No certificate is installed into your computer's trust store by the app.

## Verification

The release workflow runs the full automated security, validation, boundary, functionality and UI test suites, type checks and dependency audit before packaging. It then verifies Authenticode signatures on the disposable Windows runner and tests the installed application with its packaged native SQLite module.

The Windows validation transcript records actual pass/fail outcomes for upgrade from 1.0.19 with existing data, reinstall while running, uninstall preserving data, repair cleanup, and fresh reinstall reopening the preserved data. Interactive SmartScreen and every possible machine-specific policy cannot be reproduced by these automated checks.

## Source and maintenance

The implementation and release history are maintained in the [Credit Card Benefit Tracker repository](https://github.com/anndunkin/cc-benefit-tracker). New release details are in CHANGELOG.md, and automated Windows validation lives in scripts/test-windows-release.ps1.
