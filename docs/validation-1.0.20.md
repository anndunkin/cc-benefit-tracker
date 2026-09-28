# Credit Card Benefit Tracker 1.0.20: validation summary

Version 1.0.20 passed 209 automated tests, renderer and main-process builds, TypeScript checking, and an npm dependency audit with zero reported vulnerabilities. The successful [Windows validation run](https://github.com/anndunkin/cc-benefit-tracker/actions/runs/36457458696) built and tested commit `97f343a` (use the repository tag to resolve the full commit).

## Windows lifecycle validation

The following checks passed on the disposable Windows CI runner. The complete transcript is included with this report and the release.

- **Signing:** Installer, installed application and uninstaller Authenticode signatures verified using the release certificate trusted only on the disposable test runner.
- **Upgrade:** Installed 1.0.19, recorded usage and a certificate expiration date, then upgraded to 1.0.20 and verified both survived.
- **Native runtime:** Installed Electron launched, its bundled SQLite native module loaded, the renderer displayed, and preload IPC calls completed.
- **New controls:** Quantity logging, hidden flags, certificate dates, effective-date Lyft accounting, Diamond selection persistence, and removal of the MQD reference from projections were exercised.
- **Reinstall:** Same-version reinstall completed while the application was running.
- **Uninstall:** Application files were removed while the actual database path remained intact.
- **Repair:** Simulated leftover application directory was cleaned; the database remained intact.
- **Reinstall after repair:** A new installation opened the preserved database and retained the test usage.
- **Small-window visual inspection:** The earned-night entry dialog was inspected at 1000 × 640, with entry fields, Save usage, Cancel, history and Delete controls visible.

## Package identity

- **Installer:** Credit Card Benefit Tracker Setup 1.0.20.exe
- **SHA-256:** `da3c17b959b5493693fa75f0fdaef7d971ffe30303ffe5f3db5b0f926eec4c80`
- **Signing certificate thumbprint:** `3B9A2C3CF20B33B1E6791B1D9B0A7488E8E43D11`
- **Signer:** CN=Ann Dunkin, O=Dunkin Global Advisors, OU=Software, C=US

The certificate is new and self-signed, not publicly trusted. Windows SmartScreen/trust warnings may still appear; no certificate is installed into the user's trust store.

## Limits and installation guidance

These checks do not reproduce every Windows policy, antivirus product or interactive SmartScreen scenario. Back up the database using File > Save As or Export JSON, close the app, and run the installer over the existing installation without uninstalling first.

The repair utility's existing informational message checks a differently named data folder and reported no folder there. The lifecycle test separately checked the actual path reported by the installed app and proved that the database and its usage records survived uninstall and repair.
