# NODAL build manifest

Version 0.1.0, generated 2026-11-19T09:34:50+00:00. Machine-readable copy: `build-manifest.json`.

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
| `dist/NODAL Setup 0.1.0.exe` | 128.9 MB | `d571761e86f2c7a82a8f2ff1b8d7e552c81147542b611bc89eaa13950ea75727` |
| `dist/NODAL Setup 0.1.0.exe.blockmap` | 140 KB | `0a4ac2bade240184e9ef681824184efd9290097668b0c4f7f8c5b1d6c3fb153e` |
| `dist/win-unpacked/NODAL.exe` | 238.6 MB | `1538cfa84d68edc2c2a4373a31c44692502a84e19641e9064399fed65c6b8cf8` |
| `dist/win-unpacked/resources/app.asar` | 12.4 MB | `40d1a2cf16d549afc1ceb92e5f35dcc84c916a58154e7c7858731a60866486bf` |
| `out/main/index.js` | 133 KB | `ed849271bf6574e22306cac3ad4643c3c1bcbd48287943a0610dcef9df88bb51` |
| `out/preload/index.js` | 4 KB | `f8c5e3eec8b60c08e20d7a2c56a4a4abb47d72c82604b0265c67fd0024747757` |
| `out/renderer/assets/index-CGDxmLCc.js` | 2.2 MB | `7098f65e02bdc956b731330139263f432a5bc2f17a85706e6d7ccd2e2a466253` |
| `out/renderer/assets/index-D5rRQ8Hm.css` | 68 KB | `5d41c2a33a410251f88fdbdaf0e3b66844229b66cb7d6ad0f548b522e0327638` |
| `out/renderer/index.html` | 1 KB | `8c8219a0a1aa3a50c218d58bb79b93fc6edb454712ff42eac18c9629666bdbb1` |
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

- Source: 56 files, 9070 lines
- Tests: 21 files, 3373 lines
