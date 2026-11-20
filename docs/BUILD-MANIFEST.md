# NODAL build manifest

Version 0.1.0, generated 2026-11-20T09:56:01+00:00. Machine-readable copy: `build-manifest.json`.

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
| `dist/NODAL Setup 0.1.0.exe` | 128.9 MB | `20d9895b69d160e61fca34a057191d0023aab8bbeb52559aaf90ee52e0105282` |
| `dist/NODAL Setup 0.1.0.exe.blockmap` | 140 KB | `4e010b51a1ce4ec5979de8e7c19276f80055bd22cde48a0781b3e11e7fd3dc00` |
| `dist/win-unpacked/NODAL.exe` | 238.6 MB | `c7f602e89726f65a252cf9e59d4526ca0756d309be23b6dbc56d52e0185b010b` |
| `dist/win-unpacked/resources/app.asar` | 12.4 MB | `adfe632ec1fef159b8f672a1e38613c805dc3c2d53e621ebe750357d9e1bd1fe` |
| `out/main/index.js` | 149 KB | `9506558f1583c1f6186380434bad507bbb62b1df6d8048983573c09cd09373ae` |
| `out/preload/index.js` | 5 KB | `336b2b5f32c27c35ef256058976612c3f8134bb84785c7b5fc10965f07db1be1` |
| `out/renderer/assets/index-B1IKsxX6.css` | 68 KB | `426ac7191181228e4c8409f207ddd6df19c285e092bd9a17fddc19180473c3b0` |
| `out/renderer/assets/index-Ddch0lJU.js` | 2.3 MB | `22055b236ee60082e717a4294ba85f2d8515b7003367cfefefb13f519c984100` |
| `out/renderer/index.html` | 1 KB | `e6db32abc44f24d03f5b63e9bf65daef95448243d57d3ab79767539844ce052a` |
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

- Source: 61 files, 10400 lines
- Tests: 26 files, 4334 lines
