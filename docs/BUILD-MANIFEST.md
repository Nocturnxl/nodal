# NODAL build manifest

Version 0.1.0, generated 2026-11-20T08:31:46+00:00. Machine-readable copy: `build-manifest.json`.

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
| `dist/NODAL Setup 0.1.0.exe` | 128.9 MB | `9980b2e5043b5d7a0d85f580e677009ad314217ccb8d44f338d75bb55fa4ccb3` |
| `dist/NODAL Setup 0.1.0.exe.blockmap` | 140 KB | `050ae0df1ec080f568c09c58bc22afd62dd52281493e297b9fd8f27b1a415851` |
| `dist/win-unpacked/NODAL.exe` | 238.6 MB | `2d68368b252fc51d4a2250cfbdba91ab64901e23e561e41207d20aa8862f3bcd` |
| `dist/win-unpacked/resources/app.asar` | 12.4 MB | `ff5eac38404de6b22ca06a8022ae14012ec9eac72241b98512e973a6b7358d3f` |
| `out/main/index.js` | 142 KB | `4890554ac0e0aea8e2847387b868744ec2417c55114b02c684eeeabe14490e32` |
| `out/preload/index.js` | 5 KB | `84bbaa591a096bd909b68e4105e75c1ac6cb5273d5562107621aac4faadd25e1` |
| `out/renderer/assets/index-LvItv6xx.js` | 2.3 MB | `3dd92845f46a26f3d19841b38f286cbc55b02fcb8c55c563fde09551dbebe57a` |
| `out/renderer/assets/index-fCA3Y9wW.css` | 68 KB | `0a726065096c6518783454d448d1f8f436b4c5f17637057fd21eb0734431f51f` |
| `out/renderer/index.html` | 1 KB | `cdd528a36e03e42cc9cfc253376b62cfefa49148d7b3d2fcc1a77486a04a3984` |
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

- Source: 58 files, 9660 lines
- Tests: 24 files, 3919 lines
