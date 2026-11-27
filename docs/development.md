# Development guide

For people who want to build NODAL from source or work on it. To just use NODAL, [download an installer](installation.md) instead.

## Requirements

- **Node.js 24** (what CI uses) and npm.
- Git.
- Nothing else: the SQLite driver ships prebuilt binaries that load in both Node and Electron, so no compiler toolchain is needed.

Development happens on Windows. macOS and Linux are built and tested by CI on every push.

## Run from source

```bash
git clone https://github.com/Nocturnxl/nodal.git
cd nodal
npm install
```

```bash
npm run dev
```

This starts the application with hot reload. To use it without a real provider, start the mock provider in a second terminal and add it in the app as a **Custom** provider; the command prints the URL and key to use.

```bash
npm run mock
```

Each mock model ID triggers one behaviour (`mock-echo`, `mock-markdown`, `mock-long`, `mock-think`, `mock-401`, `mock-429-once`, `mock-disconnect`, and so on). The full list is in [`tests/mock/server.ts`](../tests/mock/server.ts).

Set `NODAL_USER_DATA` to a folder of your choice to keep development data apart from a real installation.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Main, preload and renderer with hot reload. The CSP is relaxed for the dev server only. |
| `npm run typecheck` | Strict TypeScript over main, preload, renderer and tests. |
| `npm run lint` | ESLint. The renderer is barred from importing Node, Electron or main-process code. |
| `npm test` | Unit tests (Vitest). |
| `npm run e2e` | Bundles the app, then drives it with Playwright against the mock provider. |
| `npm run build` | Typecheck, bundle, unit tests. |
| `npm run dist` | `build`, then installers through electron-builder for the platform you are on, with Electron fuses applied. |
| `npm run dist:dir` | Bundle and package an unpacked build in `dist/` without making an installer. |
| `npm run verify:package` | Checks the packaged build in `dist/`: fuses, startup, refusal to run as Node, and that a tampered `app.asar` does not start. |
| `npm run notices` | Regenerates `THIRD-PARTY-NOTICES.md` from what actually ships. |
| `npm run screenshots` | Regenerates the screenshots in `assets/screenshots` from the built app against a local demo server. |
| `node scripts/make-diagrams.mjs` | Regenerates the architecture diagram in `assets/branding`. |
| `npm run brand` | Rebuilds the icon and in-app logo from the artwork in `assets/branding/source`. |
| `npm run perf:db`, `npm run perf:ui` | On-demand timings; results are recorded in [measurements.md](measurements.md). |
| `npm run smoke:venice` | Live check against Venice. Needs `VENICE_API_KEY` in the environment and spends a few hundred tokens. Not part of `npm test`. |

## Tests

- **Unit tests** (`tests/unit`) cover the parsers, the error table, the adapters against the mock server, the database, the stream manager, the key store, the vault, export and import.
- **End-to-end tests** (`tests/e2e`) launch the built application and drive it through real use: first run, streaming, stop, branches, errors, attachments, export and restore, encryption, locking, the character list and voice chat (with Chromium's simulated microphone).
- **Accessibility:** axe-core scans every main screen in both themes against WCAG 2.1 A and AA. This finds missing labels and low contrast; it is not a substitute for testing with a screen reader, which has not been done.
- **CI** ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs lint, typecheck, unit and end-to-end tests, a production dependency audit, packaging, and the package check on Windows, macOS and Linux for every push and pull request.

On the macOS CI machine the simulated microphone delivers only silence, so the spoken round trip is exercised on Windows and Linux, and macOS exercises the silent-microphone notice instead.

All tests run against the local mock provider. Nothing in the automated suite contacts a real service.

## Conventions

- TypeScript strict mode. No Prettier configuration: code is hand-wrapped with single quotes and long lines; match the file you are editing.
- The renderer must not import from `src/main` or use Node or Electron APIs. ESLint enforces this.
- Every IPC channel is declared in `src/shared/api.ts`, validated by a schema in `src/shared/schemas.ts`, and registered through `handle()` in `src/main/ipc/register.ts`.
- Nothing provider-specific goes into shared interface code. Provider controls reach the interface as a schema from the adapter's `extensions()`.
- New behaviour comes with tests. End-to-end tests should assert what a user would see.
- Comments say why, not what.

See the [architecture document](architecture.md) for how the pieces fit.

## Packaging

`npm run dist` produces the installer for the platform it runs on:

| Platform | Output in `dist/` |
| --- | --- |
| Windows | `NODAL-Setup-windows-x64.exe` (NSIS) |
| macOS | `NODAL-macos-arm64.dmg` |
| Linux | `NODAL-linux-x86_64.AppImage`, `NODAL-linux-amd64.deb` |

Builds are unsigned. electron-builder signs automatically when a certificate is configured (`CSC_LINK` and `CSC_KEY_PASSWORD`); none is, yet. The macOS build declares the microphone entitlement and usage text that a signed build will need.

## Releasing

Releases are built by CI, not on a developer's machine.

1. Update the version in `package.json`, add the release to [`CHANGELOG.md`](../CHANGELOG.md), and write `docs/release-notes/vX.Y.Z.md`.
2. Commit, and wait for CI to pass on `main`.
3. Tag the commit and push the tag:

   ```bash
   git tag v0.1.0
   ```

   ```bash
   git push origin v0.1.0
   ```

4. CI opens a **draft** GitHub release with the release notes, runs the full checks again for the tag on all three platforms, attaches each platform's installers to the draft, and then adds `SHA256SUMS.txt`.
5. Review the draft on GitHub and publish it.

Not in place yet: code signing, notarization, and an update feed (`publish` is `null` in `electron-builder.yml`, so the in-app update check does nothing).
