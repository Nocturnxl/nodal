# NODAL build manifest

Version 0.1.0, generated 2026-11-18T05:31:07+00:00. Machine-readable copy: `build-manifest.json`.

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
| `dist/NODAL Setup 0.1.0.exe` | 127.2 MB | `8d701e4fc3d6ac52e78b617808296904431d3c6796dd9fd0868199f90a9e22f5` |
| `dist/NODAL Setup 0.1.0.exe.blockmap` | 137 KB | `ab3876c64aff63dddd213110a0143e8a3aeac0f302484c2b95d61bf7a56adb02` |
| `dist/win-unpacked/NODAL.exe` | 238.6 MB | `92e2290dc7f59cc9ff5f63e1064c3675222d29712874cb715dcaa0577eb9bddb` |
| `dist/win-unpacked/resources/app.asar` | 12.3 MB | `21e0d8def81b53f049839de8a9eeb811c609c58b7de6ee5b6d3c93f8afd087de` |
| `out/main/index.js` | 116 KB | `deea193020c2c86f0f9931693a3f144c4bda44bb5a97da7bd6dfc79dad2a6827` |
| `out/preload/index.js` | 4 KB | `80b9ee4f7f14221128d17f4a831feaced5ea7bd0bd6928c9914eee58b6709697` |
| `out/renderer/assets/index-kpyRYBGa.js` | 2.2 MB | `c5f27c03df85db68ebc3bd1e23cf814a3bcd1300b04a625af214cedbd66a9d1f` |
| `out/renderer/assets/index-zxHsCkBG.css` | 67 KB | `0e689d3d9de17f222e5153f30368e2323be5ec167f9a8d704398a107561b5630` |
| `out/renderer/index.html` | 1 KB | `1f304f59ddde8ad36e6aa845dbbee5ae038743cf74434c1b1474672a936433bf` |
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

- Source: 53 files, 8062 lines
- Tests: 19 files, 2784 lines
