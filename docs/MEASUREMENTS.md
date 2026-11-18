# Relay runtime measurements

Measured 2026-11-18 on one machine: Windows 11 Pro 10.0.26300 x64, AMD Ryzen 9 9950X3D 16-Core, 62 GB RAM, Electron 45.3.3. This is a fast desktop, so treat the absolute numbers as a best case.

Every figure here came from a run in this session. The provider in all of them is the local mock server on loopback, so nothing here measures a real provider or a real network.

## Against the specification's performance targets

| Target (spec section 9) | Result | Measured? |
| --- | --- | --- |
| Window shown and interactive within 2 s of launch | 1607 ms on the first launch of a new profile; 332 to 372 ms on the next five | Partly. This is the unpackaged build started by the test driver, timed from process start to the UI being present. The installed build was not timed. |
| Search across 10,000 messages in under 200 ms | 36.19 ms median when every message matches; 0.82 ms when a tenth match; 0.14 ms for a single hit | Yes, for the database query in the main process. IPC and rendering time are not included. |
| A 5,000-message conversation scrolls without visible jank | Scrolling the whole thread end to end in 6 s: median frame gap 4.2 ms, 99th percentile 12.6 ms, worst 20.8 ms; no frame over 33 ms in 948 frames | Yes, in the built app on a 247 Hz display. Scripted scrolling, not a hand on a wheel. |
| Typing latency under one frame while a reply streams | Key press to the second frame after it: median 6.2 ms, worst 8.2 ms over 62 keys, in the 5,000-message chat while a reply streamed | Yes. One 60 Hz frame is 16.7 ms. |

## A 5,000-message conversation in the app

Seeded by importing a 5,000-message export, then driven in the built app (`npm run perf:ui`).

| Measure | Result |
| --- | ---: |
| Import the 5,000 messages | 1.4 s |
| Reload to newest message on screen | 98 ms |
| Message elements mounted at once (the list is virtualized) | 11 |
| Enter pressed to reply streaming, with all 5,000 messages sent as context | 132 ms |
| Frame gaps while streaming and typing | median 4.2 ms, worst 4.3 ms, none over 33 ms |
| Stop clicked to reply marked stopped | 47 ms |
| Memory, all processes, after the above | 731 MB (window 385 MB, main 173 MB, GPU 118 MB, utility 55 MB) |

Memory is working-set size as Electron reports it, at one moment in one run.

## Chat latency against the mock provider

Five sends in the built app, mock server with no artificial delay.

| Measure | Runs (ms) | Median |
| --- | --- | ---: |
| Enter pressed to first token on screen | 116, 44, 34, 43, 34 | 43 ms |
| Stop clicked to reply marked stopped | 31, 23, 32, 25, 22 | 25 ms |

The acceptance criterion for Stop is one second. These times include the test driver's own polling, so the app's share is smaller.

## Database operations

SQLite in the main process, 10,000 messages of about 80 words across 100 conversations, 25 runs each.

| Operation | Median | Worst |
| --- | ---: | ---: |
| Search, every message matches (100 conversations found) | 36.19 ms | 52.92 ms |
| Search, a tenth of messages match (10 found) | 0.82 ms | 1.1 ms |
| Search, one message matches | 0.14 ms | 0.3 ms |
| List all conversations | 0.08 ms | 0.21 ms |
| Load a 100-message conversation | 0.11 ms | 0.33 ms |
| Walk a 100-deep thread from leaf to root | 0.22 ms | 1.47 ms |
| Insert all 10,000 messages with search indexing, one transaction | 5.0 s | |

| Walk a 5,000-deep thread from leaf to root | 6.91 ms | 8.16 ms |
| Load a 5,000-message conversation | 3.51 ms | 5.6 ms |

The thread walk used to do one query per message (1.5 ms for 100 messages, so roughly 80 ms for 5,000 by extrapolation). It is now a single recursive query.

Taking these measurements found a bug, now fixed with a regression test: content search looked at only the 500 best-matching messages, so a query with many hits returned 9 of the 100 matching conversations. The numbers above are from after the fix.

## Test and build times

| Step | Result | Time |
| --- | --- | ---: |
| Unit tests (Vitest) | 106 of 106 passed | 9.7 s summed over files, about 4.6 s wall clock |
| End-to-end tests (Playwright, built app) | 27 of 27 passed | 23.8 s |
| Bundle (electron-vite) | ok | 2.2 s |

### Unit test files

| File | Passed | Time |
| --- | ---: | ---: |
| `adapter.test.ts` | 26 of 26 | 1.80 s |
| `errors.test.ts` | 11 of 11 | 0.02 s |
| `exporter.test.ts` | 8 of 8 | 1.19 s |
| `sse.test.ts` | 4 of 4 | 0.01 s |
| `store.test.ts` | 20 of 20 | 2.41 s |
| `streams.test.ts` | 25 of 25 | 4.20 s |
| `venice.test.ts` | 12 of 12 | 0.04 s |

### End-to-end tests

| Test | Result | Time |
| --- | --- | ---: |
| welcome and provider form (light) | passed | 0.46 s |
| welcome and provider form (dark) | passed | 0.31 s |
| set up a provider and a conversation with rich content and an error | passed | 1.64 s |
| chat, model picker and settings (light) | passed | 2.38 s |
| chat, model picker and settings (dark) | passed | 2.33 s |
| first run: a rejected key is not kept, a valid key connects and lists models | passed | 0.29 s |
| a reply streams and is saved | passed | 0.24 s |
| Stop cancels mid-stream within a second and keeps the partial text | passed | 0.28 s |
| the renderer is sealed: no Node, no ipcRenderer, no key read-back, no network | passed | 0.22 s |
| edit-and-resend creates a branch that can be switched back | passed | 0.31 s |
| error table: mock-401 shows "Key rejected" with status and request id | passed | 0.06 s |
| error table: mock-402 shows "Out of balance" with status and request id | passed | 0.06 s |
| error table: mock-403 shows "Not allowed" with status and request id | passed | 0.06 s |
| error table: mock-404-html shows "Model or endpoint not found" with status and request id | passed | 0.05 s |
| error table: mock-400-context shows "Conversation too long" with status and request id | passed | 0.06 s |
| error table: mock-429-always shows "Rate limited" with status and request id | passed | 1.41 s |
| error table: mock-500-always shows "The provider had an error" with status and request id | passed | 3.47 s |
| a mid-stream failure keeps the partial reply with Continue and Regenerate | passed | 0.15 s |
| reasoning is shown in its own collapsible block | passed | 0.27 s |
| export writes Markdown through the native save dialog | passed | 0.03 s |
| killing the app mid-stream leaves the reply interrupted after relaunch | passed | 3.60 s |
| search finds conversations by message content | passed | 0.21 s |
| the renderer made no network requests and no key string is anywhere in the user-data folder | passed | 0.63 s |
| a failed first attempt leaves no provider behind | passed | 0.64 s |
| attach an image, send it, and deleting the chat deletes the image file | passed | 0.80 s |
| math renders with KaTeX when switched on, and stays as text when off | passed | 0.77 s |
| export everything to a ZIP and restore it into an empty profile from the welcome screen | passed | 1.85 s |

The two slow error-table rows are the automatic retries: three for a 429 and two for a 5xx, with backoff.

## Sizes

- Installer: 126.3 MB
- `app.asar`: 12.2 MB
- Renderer JavaScript: 2.2 MB, one file
- Main process bundle: 115 KB

## Not measured

- CPU use, and memory over a long session.
- Anything against a real provider, including Venice.
- The installed (packaged) build's startup time.
- macOS and Linux.
