# Build Spec — Credit Card Benefit Tracker v1.0.0

Reference document for building, testing, signing, and packaging the app.

## Stack

- **Runtime**: Electron 32 (Chromium 128, Node 20)
- **UI**: React 18 + TypeScript 5, react-router 6, Tailwind CSS
- **Bundler**: Vite 5
- **DB**: better-sqlite3 11 (native module, prebuilt binary bundled under `prebuilt-win32-x64/`)
- **Tests**: vitest 1.6 (node env for backend, jsdom optional for UI)
- **Installer**: electron-builder → NSIS x64
- **Signing**: osslsigncode + self-signed 10-year SHA-256 cert (`CN=Ann Dunkin, O=Dunkin Global Advisors, OU=Software, C=US`)

## Directory layout

```
cc-benefit-tracker/
├── electron/                Backend (main process, IPC, DB, seed data)
│   ├── main.ts              App lifecycle + window creation
│   ├── preload.ts           Whitelisted IPC bridge (contextIsolation:true, nodeIntegration:false)
│   ├── database.ts          SQLite schema + CRUD + refresh + projections + file I/O
│   ├── periods.ts           Period bucket math for reset cadences
│   ├── benefitsSeed.ts      Seed loader — reads generated data with fallback lists
│   ├── benefitsSeedData.ts  GENERATED from benefits-research.json (13 cards, 4 programs, 176 benefits)
│   ├── iconPath.ts          App-icon path resolution with traversal guard
│   └── types.ts             Shared TypeScript types
├── src/                     React frontend (pages, components, theme)
│   ├── pages/               Dashboard, Cards, CardDetail, Programs, ProgramDetail, ManageBenefits, Refresh, Settings
│   ├── components/          RefreshBanner, LogUsageModal, BenefitEditor
│   └── main.tsx, App.tsx, theme.tsx, index.css
├── tests/                   vitest test suites + electron mock + helpers
├── scripts/                 afterPack, copy-electron-assets, clean-tsbuildinfo, generate_seed.py, installer.nsh
├── build/                   sign.sh + signing.crt (signing.key gitignored)
├── prebuilt-win32-x64/      better_sqlite3.node prebuilt binary for Windows x64
└── benefits-research.json   Immutable input to scripts/generate_seed.py
```

## Commands

| Command | What it does |
|--|--|
| `npm install` | Install deps (655 packages, ~90s on first install) |
| `npm run dev` | Vite dev server + Electron reload; runs both main and renderer |
| `npm run test` | Run vitest suite (~1.5s, 46 tests) |
| `npm run test:watch` | Interactive test mode |
| `npm run typecheck` | Two-pass typecheck (frontend + electron backend) |
| `npm run build:renderer` | Vite build → `dist/` |
| `npm run build:electron` | TSC build of electron/*.ts → bundled by electron-builder |
| `npm run electron:build` | Full production build → `dist-installer/` |
| `bash build/sign.sh` | Sign every `.exe` and `.dll` produced by electron-builder |

## Regenerating seed data

`benefits-research.json` is produced by the research subagent. To regenerate `electron/benefitsSeedData.ts`:

```bash
python3 scripts/generate_seed.py \
  --input benefits-research.json \
  --output electron/benefitsSeedData.ts
```

The generator is idempotent — running it twice on the same input produces byte-identical output.

## Signing

- The private key at `build/signing.key` is gitignored. To regenerate on a fresh checkout:
  ```bash
  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -subj "/CN=Ann Dunkin/O=Dunkin Global Advisors/OU=Software/C=US" \
    -keyout build/signing.key -out build/signing.crt
  chmod 600 build/signing.key
  ```
- SmartScreen will still warn on first install (that's expected for any self-signed exe).

## Release process

1. `npm run typecheck` (both passes must be clean)
2. `npm run test` (all 46 tests must pass)
3. Bump `version` in `package.json` (`.` release — never a major)
4. Update `CHANGELOG.md`
5. `npm run electron:build`
6. `bash build/sign.sh`
7. Commit and tag: `git tag v1.0.0 && git push --tags`
8. Attach the signed installer to the GitHub release
