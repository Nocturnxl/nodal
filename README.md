# Relay

A single-user desktop chat client for any OpenAI-compatible LLM endpoint. You give it a base URL and an API key, it discovers the models that endpoint serves, and you chat with streamed replies. Nothing leaves the machine except the requests you send to the provider you choose.

"Relay" is a placeholder name. The icon is `build/icon.png`.

## Quick start

```bash
npm install
```

```bash
npm run dev
```

To try it without a real key, start the mock provider in a second terminal and add it in the app as a **Custom** provider. The command prints the URL and the key to use.

```bash
npm run mock
```

Each mock model ID triggers one behaviour (`mock-echo`, `mock-markdown`, `mock-long`, `mock-think`, `mock-401`, `mock-429-once`, `mock-disconnect`, and so on). The full list is in [tests/mock/server.ts](tests/mock/server.ts).

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Main, preload and renderer with hot reload. The CSP is relaxed for the dev server only. |
| `npm run typecheck` | Strict TypeScript over main, preload, renderer and tests. |
| `npm run lint` | ESLint. The renderer is barred from importing Node, Electron or main-process code. |
| `npm test` | Unit tests (Vitest): parsers, error table, adapters against the mock server, database, stream manager, key store, export/import. |
| `npm run e2e` | Bundles the app, then drives it with Playwright against the mock provider. |
| `npm run build` | Typecheck, bundle, unit tests. |
| `npm run dist` | `build`, then installers through electron-builder (NSIS on Windows, dmg on macOS, AppImage and deb on Linux) with Electron fuses applied. |
| `npm run verify:package` | Checks the packaged build in `dist/`: fuses, startup, refusal to run as Node, and that a tampered `app.asar` does not start. |
| `npm run notices` | Regenerates `THIRD-PARTY-NOTICES.md` from what actually ships. |
| `npm run perf:db`, `npm run perf:ui` | On-demand timings: database operations, and a 5,000-message conversation in the built app. |
| `npm run smoke:venice` | Live check against Venice. Needs `VENICE_API_KEY` in the environment; spends a few hundred tokens. |
| `npm run dist:dir` | Bundle and package an unpacked build in `dist/` without making an installer. |

## How it is put together

```text
src/
  main/                 the only place that touches secrets, the network and the disk
    index.ts            app lifecycle, window, sessions, hardening
    ipc/                handlers; every one checks the sender and validates its payload with zod
    providers/          adapter interface, the shared OpenAI-compatible adapter, Venice extension, registry
    chat/               stream manager (retry, cancel, persistence) and context trimming
    net/                fetch wrapper, SSE parser, timeouts, error normalization, redaction, URL policy
    db/                 SQLite connection, numbered SQL migrations, all queries
    secrets/keystore.ts safeStorage wrapper over keys.json
    data/exporter.ts    Markdown / JSON / ZIP export and merge import
  preload/index.ts      contextBridge surface `window.relay`: typed functions on fixed channels
  renderer/             React UI (Zustand, Radix, Tailwind); makes no network requests
  shared/               types, zod schemas, presets, the IPC contract
tests/
  mock/                 local mock provider
  unit/                 Vitest
  e2e/                  Playwright driving the built app
  fixtures/             a recorded Venice GET /models response
```

A provider is data plus a thin adapter. Venice, OpenRouter, OpenAI, LM Studio, Ollama and custom endpoints all run through `providers/openaiCompatible.ts`. Venice's extras (`venice_parameters`, balance and deprecation headers, key validation) live in `providers/venice.ts`. Its controls reach the UI as a declarative schema from `extensions()`, so shared UI code never mentions a provider.

## Security model

- **The renderer never sees a key.** There is no `keys.get` channel. `keys.status` returns only presence and the last four characters.
- Keys are encrypted with Electron `safeStorage` (DPAPI, Keychain, libsecret or kwallet) and stored as ciphertext in `keys.json`. On Linux, if only the `basic_text` backend is available, Relay refuses to store keys and says why.
- Changing a provider's host deletes its stored key, so a key is never sent to a server it was not entered for.
- The window runs with `contextIsolation`, `sandbox`, no Node integration, and a strict CSP (`connect-src 'none'`). A `webRequest` filter cancels any renderer request outside the app's own `app://relay` origin. Navigation, new windows and webviews are denied.
- Provider traffic goes through a separate in-memory session with an egress allowlist of configured provider hosts. HTTPS is required. Plain HTTP is allowed for loopback, and for LAN addresses only after a per-provider confirmation.
- Model output is untrusted: Markdown renders without raw HTML, links open in the system browser only after a native dialog shows the full URL, and only `http(s)` links are accepted.
- Packaged builds set these fuses: `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off, `EnableNodeCliInspectArguments` off, `OnlyLoadAppFromAsar` on, `EnableEmbeddedAsarIntegrityValidation` on.
- Deleting a conversation deletes its attached images (unless another chat uses the same file) and overwrites the deleted rows in the database (`secure_delete`). Images attached but never sent are removed after a day.
- An unexpected error in the main process is logged, reported in a dialog with the log folder, and the app closes cleanly so in-flight replies are saved.
- No telemetry, analytics or crash upload. The update check is off by default.

## Where data lives

Everything is in the Electron user-data folder (Settings → Data → Open folder). On Windows that is `%APPDATA%\Relay`.

| Path | Contents |
| --- | --- |
| `relay.db` | SQLite (WAL): providers, conversations, the message tree, settings, model cache, request log |
| `keys.json` | `safeStorage` ciphertext, one entry per provider |
| `attachments/<sha256>` | Attached images, deduplicated by content hash |
| `logs/` | Rotating metadata-only logs, 5 files of 2 MB |
| `backups/` | Copy of `relay.db` taken before each schema migration |

Set `RELAY_USER_DATA` to run against a different folder. The tests use this.

On Linux, `RELAY_PASSWORD_STORE` (`gnome-libsecret`, `kwallet`, `kwallet5` or `kwallet6`) names the keyring to use when the desktop session is one Chromium does not recognise. It cannot select plain-text storage.

## What is implemented

All P0 and P1 requirements from the specification (F1 to F16): provider management from presets or custom URLs, encrypted key entry with validation, model discovery with a 24-hour cache and hand-entered model IDs, streaming chat with Stop, persistent conversations with full-text search, Markdown with code highlighting and optional math, per-conversation system prompt and sampling controls, regenerate, edit-and-resend and branch switching, provider extension controls, a separate reasoning block, image attachments, token counts with balance and rate-limit readouts, Markdown / JSON / ZIP export and import, themes and keyboard shortcuts, and several providers in one model picker.

Also added since: restore from an export on the welcome screen.

Not implemented (P2 in the specification): model-generated titles (F17; titles come from the first message), prompt library (F18), app lock and database encryption (F19), speech and image generation (F20).

## Where this differs from the specification

- **Connect timeout.** Chromium owns the socket, so the connect phase cannot be timed separately. Model-list and key-validation calls get 15 s to return headers. Chat requests get the first-byte budget (60 s by default, configurable to 300 s) to return headers and again for the first body byte, then 90 s between chunks.
- **Remote images.** The specification asks for "click to load". The strict CSP and the renderer request filter make that impossible without weakening both, so a remote image is shown as a link that opens in the system browser after the usual confirmation.
- **Continue.** No OpenAI-compatible provider advertises assistant-prefix support in a way that can be detected, so Continue always sends the partial reply back followed by an instruction to carry on, and appends the result to the same message.
- **Context errors.** "Drop oldest turns and retry" sets a per-conversation context limit (visible in the inspector) and regenerates, so later messages in that chat are trimmed the same way.
- **Unit tests run on plain Node.** better-sqlite3 13 ships N-API prebuilt binaries that load in both Node and Electron, so no Electron-specific rebuild is needed.
- **Updates.** `electron-updater` is wired in but no update feed is configured in `electron-builder.yml`, so the check does nothing until one is added.
- **Extra columns.** `messages.error_json` stores the normalized error for a failed reply, `models_cache.manual` marks hand-entered model IDs, and `providers.model_list_query_json` holds the model-list query.

## Venice notes

Confirmed against the live API on 2026-11-17 with `npm run smoke:venice` (a live smoke test that needs `VENICE_API_KEY` in the environment and is not part of `npm test`):

- `GET /models` is public, so key validation calls `GET /api_keys/rate_limits`: 200 for a valid key, 401 for an invalid one, 402 (a payment challenge) with no credentials. Relay reports that 402 as an authentication failure.
- Streaming works with `venice_parameters` and `stream_options.include_usage`. Usage arrives in a final chunk with an empty `choices` array.
- Reasoning text arrives in `delta.reasoning_content` (seen on `deepseek-v4-1-flash-1017`).
- `x-ratelimit-reset-requests` and `x-ratelimit-reset-tokens` are epoch milliseconds.
- `CF-RAY` is the request ID, and `x-venice-balance-usd` carries the balance.
- `model_spec.pricing.*.usd` is USD per million tokens.
- With `include_venice_system_prompt` on, a one-line prompt was billed as about 1,700 prompt tokens. Relay therefore sends it as off by default (the specification had it on); turn it on per conversation in the inspector's Model options.

Not seen yet: inline `<think>` tags from a real model, the deprecation headers, and a real 429.

## Other providers

- **OpenRouter.** `GET /models` is public, so the key is validated with `GET /key` (401 for a bad key). The model list mapping is tested against a recorded live response. No chat has been run against it.
- **OpenAI, LM Studio, Ollama.** Base URLs and auth match their docs, but none has been run. OpenAI's `GET /models` returns 401 without a key, so the generic check validates keys there.
- **Field differences.** If a server rejects `stream_options`, `max_tokens`, `temperature` or `top_p` by name with a 400, Relay drops or renames that field (`max_tokens` becomes `max_completion_tokens`) and retries before any output. This is tested against the mock only.

## Before a public release

Done and tested: attachment cleanup, the provider fallbacks above, removal of half-created providers, crash handling, a single-query thread walk, measured 5,000-message scrolling and typing, accessibility scans (axe-core, WCAG 2.1 A and AA, every screen, both themes), a packaged-build check, and third-party licence notices.

Still open, and not something the code can settle on its own:

- **Signing and notarization.** Builds are unsigned. Windows needs a code-signing certificate; macOS needs an Apple Developer ID.
- **An update feed.** `publish` is `null` in `electron-builder.yml`.
- **Name and licence.** "Relay" is a placeholder, and `package.json` says `UNLICENSED`.
- **macOS and Linux.** Never built or run. The CI workflow covers both but has not executed.
- **Real providers other than Venice**, and the app's own screens against Venice (only the adapter was tested live).
- **A screen-reader pass.** The automated scan finds missing labels and low contrast, not whether the app is pleasant to use without sight.
- **An independent security review.**
- **Build-time advisories.** `npm audit` reports issues in `picomatch` (no fixed version exists yet) and `minimatch` (fix needs a major downgrade of electron-builder). Both are glob libraries used only by build tools on patterns from this repository; nothing affected ships in the app. `npm audit --omit=dev` is clean.
- **Database encryption** and languages other than English.

## Open questions, and the defaults chosen

| Question | Default in this build |
| --- | --- |
| Primary OS | Windows; macOS and Linux build from the same code but were not run |
| Distribution | Personal use; builds are unsigned |
| Updates | Manual downloads |
| Other APIs | OpenAI-compatible only; Anthropic and Google would each need an adapter in `providers/registry.ts` |
| Encryption at rest | OS disk encryption; the database is a plain SQLite file |
| Window model | One window |
