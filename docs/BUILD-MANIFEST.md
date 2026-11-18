# NODAL build manifest

Version 0.1.0, generated 2026-11-18T04:40:21+00:00. Machine-readable copy: `build-manifest.json`.

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
| `dist/NODAL Setup 0.1.0.exe` | 127.2 MB | `4a3c5b0694514c2489dba41c82f63b9fa1258a975aefbe55f1d6957bdca29d25` |
| `dist/NODAL Setup 0.1.0.exe.blockmap` | 136 KB | `38357642f8da1a2b75c32f39a4b1e97c291f38e73d79dfeda7ab7519855255bc` |
| `dist/win-unpacked/NODAL.exe` | 238.6 MB | `6e5bc90af21b6667333d092d4638752b74e30095ac5aca8a8adf8c62d9ddfd7c` |
| `dist/win-unpacked/resources/app.asar` | 12.3 MB | `7d7f0424c65998fd6cb73a2864ac029022d75849ad7630f4b01af8dfa604581b` |
| `out/main/index.js` | 116 KB | `b1ee69c7da28700ac018d0f87aa38a8ca11a9caf176f5ce23cd26f28e199f5e0` |
| `out/preload/index.js` | 4 KB | `80b9ee4f7f14221128d17f4a831feaced5ea7bd0bd6928c9914eee58b6709697` |
| `out/renderer/assets/index-Bgr78jP0.css` | 63 KB | `52e61abc63c9ba51a6d061d22097fcaf9585cdfc42c1a39a7be532886f28b3bb` |
| `out/renderer/assets/index-DwZx42r0.js` | 2.2 MB | `eb20666df2c3b25c80bd691db72fc386ef1afcd69d9e0ec7f821fc071e492883` |
| `out/renderer/index.html` | 1 KB | `ce90e89672be631d72aad11a3e843c05da9fbb7372b5acd85a23685de3f13e00` |
| `package-lock.json` | 381 KB | `300adde9a62f6cde01ee88399a417e8c01e81c0f7e261d5a0a3243327611254d` |

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

- Source: 53 files, 8022 lines
- Tests: 19 files, 2784 lines
