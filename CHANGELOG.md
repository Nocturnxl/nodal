# Changelog

All notable changes to NODAL are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-27

The first public release.

### Added

- **Providers.** Presets for Venice.ai, OpenRouter, OpenAI, LM Studio and Ollama, and custom OpenAI-compatible endpoints. API keys are validated on entry and stored encrypted by the operating system; the interface never receives a key.
- **Models.** Automatic model discovery with a daily refresh, hand-entered model IDs, and one searchable picker across every provider.
- **Chat.** Streamed replies with Stop, regenerate, continue, and edit-and-resend. Conversations are stored as a tree, so every edit and regeneration is a branch that can be switched back to.
- **Controls.** Per-conversation system prompt, temperature, top-p, maximum output tokens and context limit, with defaults for new chats.
- **Reasoning.** Model reasoning shown in a separate collapsible block, from a dedicated field or inline `<think>` tags.
- **Images.** Attach, paste or drop images for models with vision.
- **Provider options.** Venice.ai web search, citations, URL scraping, thinking controls and a searchable character list (Preview).
- **Voice chat (experimental).** Turn-based spoken conversation with Venice.ai, with voice instructions that apply to spoken turns only.
- **Search** across the full text of every conversation.
- **Export and import.** Markdown, JSON and ZIP export, passphrase-protected exports, and merge import, including restoring into a fresh installation.
- **Encryption at rest.** Optional passphrase encryption of the database, attachments and settings, with Lock now, auto-lock, and an opt-in wipe after five wrong passphrases.
- **Usage readouts.** Token counts per reply, and balance and rate-limit information where the provider reports it.
- **Interface.** Light and dark themes, keyboard shortcuts, optional math rendering, Markdown with code highlighting.
- **Installers** for Windows (x64), macOS (Apple Silicon) and Linux (x86-64 AppImage and .deb), with SHA-256 checksums.

### Known limitations

- Installers are not code-signed. Windows and macOS show a warning on first run.
- No automatic updates.
- The macOS and Linux builds pass automated tests but have not been run by hand.
- Voice chat and the Venice character list were built from Venice's API reference and have not been confirmed against the live service.
- The OpenAI, LM Studio and Ollama presets follow each provider's documentation and have not been run against them.
- Only OpenAI-compatible APIs are supported.
- English only.
- No independent security review has been carried out.

[0.1.0]: https://github.com/Nocturnxl/nodal/releases/tag/v0.1.0
