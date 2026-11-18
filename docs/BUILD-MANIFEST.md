# Relay build manifest

Version 0.1.0, generated 2026-11-18T03:20:43+00:00. Machine-readable copy: `build-manifest.json`.

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
| better-sqlite3 | 13.2.0 |
| electron-updater | 6.8.11 |
| fflate | 0.8.3 |
| zod | 4.6.7 |

Everything else (32 direct dev dependencies, 708 packages in the lockfile) is build-time only. React, Zustand, Radix, Tailwind and the Markdown libraries are bundled into the renderer.

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
| `dist/Relay Setup 0.1.0.exe` | 126.3 MB | `87df3e8aa594bb9ac974cbe0e08d54bd21541d7b8b92cb46b199a1e9054144af` |
| `dist/Relay Setup 0.1.0.exe.blockmap` | 135 KB | `310fd0d590bbfa45e36f2b35d0f61c2a8f3ad2987fcfcf4c5761df3180abbc6a` |
| `dist/win-unpacked/Relay.exe` | 238.5 MB | `65c74b4b522b7a9bbad98cf45efa3143e5ed423c1ac9f88e68e6e12de6d66e26` |
| `dist/win-unpacked/resources/app.asar` | 12.2 MB | `f80a6481b37bd9665085bc33828260998433b05e58c9ce4321dc53a5edec1f2a` |
| `out/main/index.js` | 115 KB | `e44e8a40d82a4753682aacf2e0952df81a7eaccbd05a9421438be6421eb28192` |
| `out/preload/index.js` | 4 KB | `8390e4cfc5e15e4a1125ce6cc29da95f8a2e2fe0d2165ffdaa1630cee5586e3e` |
| `out/renderer/assets/index-Cgkw2frb.js` | 2.2 MB | `62ae66a76f014f22ecb6894686c03e99ad9ae007c69bc566d4d9e9acad3096fc` |
| `out/renderer/assets/index-i0E25jdN.css` | 63 KB | `a1f2061b603597572b25a64ebb6bbd869248431412172db5e0198d1bf546ee29` |
| `out/renderer/index.html` | 1 KB | `c333bb020dbcc49bdf01a5455f369d44f13baf18a3f5f5038dd785e3fb28b86a` |
| `package-lock.json` | 381 KB | `9fe5c1cb7299e8d0c068c86e572feedbc6b065841080cf646b00016b2e938314` |

The renderer bundle is 63 files, 3.3 MB in total. Most of the file count is KaTeX fonts.

The installer is unsigned and has no update feed. It will show a SmartScreen warning on other machines.

## Electron fuses (read back from `dist/win-unpacked/Relay.exe`)

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

- Source: 51 files, 7955 lines
- Tests: 18 files, 2729 lines
