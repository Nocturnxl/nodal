# NODAL build manifest

Version 0.1.0, generated 2026-11-19T20:13:15+00:00. Machine-readable copy: `build-manifest.json`.

The project folder is not a git repository, so this build is pinned by the lockfile hash and the artifact hashes below, not by a commit.

## Toolchain

| Tool | Version |
| --- | --- |
| node | v24.19.0 |
| npm | 11.17.0 |
| electron | 45.3.3 |
| electron-vite | 6.0.0 |
| vite | 8.3.8 |
| typescript | 5.9.3 |
| electron-builder | 26.18.0 |
| vitest | 5.1.0 |
| playwright | 1.65.1 |

Build host: Windows 11 Pro 10.0.26300 x64, AMD Ryzen 9 9950X3D 16-Core, 62 GB RAM.

## Runtime dependencies (shipped in the installer)

| Package | Version |
| --- | --- |
| better-sqlite3-multiple-ciphers | 13.2.0 |
| electron-updater | 6.8.11 |
| fflate | 0.8.3 |
| zod | 4.6.7 |

Everything else (31 direct dev dependencies, 707 packages in the lockfile) is build-time only. React, Zustand, Radix, Tailwind and the Markdown libraries are bundled into the renderer.

## Build steps

| Step | Command |
| --- | --- |
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint` |
| Unit tests | `npm test` |
| Bundle | `npm run bundle` (electron-vite, output in `out/`) |
| End-to-end | `npx playwright test` |
| Licence notices | `npm run notices` |
| Package | `npx electron-builder --publish never` (output in `dist/`) |
| Verify the package | `npm run verify:package` |

## Artifacts

| File | Size | SHA-256 |
| --- | ---: | --- |
| `dist/NODAL Setup 0.1.0.exe` | 128.9 MB | `7f48cc4e6b9c9dc842e8856af2bddd9a509a0c854e90695706b330ab25331435` |
| `dist/NODAL Setup 0.1.0.exe.blockmap` | 140 KB | `0f94e853795a193264e452b9087d44f223e700be77a6a167415ae1b4931bd9aa` |
| `dist/win-unpacked/NODAL.exe` | 238.6 MB | `97b2a7a7f0fbb282b9d2bf3c98032b35d3a938cdc1069b194ddd603e8861d953` |
| `dist/win-unpacked/resources/app.asar` | 12.4 MB | `7d85ee546850e19963af223911cbc2b6a207b7e1ab044d689f9d520f6158848e` |
| `out/main/index.js` | 139 KB | `1470ab0989ae5ec65215bd68342ec649f3cf4027b5289e4c773e4dad6f66cb9a` |
| `out/preload/index.js` | 5 KB | `0963bc2f1efd169eb18e6e77a491b4699f0e05d37921c4dc2b7253739187e73c` |
| `out/renderer/assets/index-D5rRQ8Hm.css` | 68 KB | `5d41c2a33a410251f88fdbdaf0e3b66844229b66cb7d6ad0f548b522e0327638` |
| `out/renderer/assets/index-Dv8iLBtG.js` | 2.2 MB | `2228ae4a4c79aa9a511dd30547f6dc552e9ace7c24f536e303ac0de6fef9f6d5` |
| `out/renderer/index.html` | 1 KB | `1c39b3bd69dbc9cb56c029e7cb32c82439485ce3cc570bf79ce7cb3f2ae58a30` |
| `package-lock.json` | 381 KB | `c06380b4479af62b50fd4b6ddce063bf8f3845cadf051212542b58f5f6533daf` |

The renderer bundle is 65 files, 3.4 MB in total. Most of the file count is KaTeX fonts.

The installer is unsigned and has no update feed. It will show a SmartScreen warning on other machines.

## Electron fuses (read back from `dist/win-unpacked/NODAL.exe`)

- RunAsNode is Disabled
- EnableCookieEncryption is Enabled
- EnableNodeOptionsEnvironmentVariable is Disabled
- EnableNodeCliInspectArguments is Disabled
- EnableEmbeddedAsarIntegrityValidation is Enabled
- OnlyLoadAppFromAsar is Enabled
- LoadBrowserProcessSpecificV8Snapshot is Disabled
- GrantFileProtocolExtraPrivileges is Disabled
- WasmTrapHandlers is Enabled

## Size of the code

- Source: 58 files, 9455 lines
- Tests: 23 files, 3717 lines
