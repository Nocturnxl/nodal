# Contributing to NODAL

Thank you for considering it. There are useful contributions at every level of technical skill.

## Without writing code

- **Test on macOS or Linux.** Those builds have never been used by hand. Install NODAL, try it, and file a [platform test report](https://github.com/Nocturnxl/nodal/issues/new?template=platform_test_report.yml), whether it works or not. This is the most valuable contribution right now.
- **Try a provider that has not been verified.** The OpenAI, LM Studio and Ollama presets, Venice voice chat and the Venice character list have not yet been run against the real services. Tell us what happens.
- **Report a problem** with the [bug report form](https://github.com/Nocturnxl/nodal/issues/new?template=bug_report.yml).
- **Suggest an improvement** with the [feature request form](https://github.com/Nocturnxl/nodal/issues/new?template=feature_request.yml).

When reporting, never paste API keys, passphrases or private conversations. NODAL's logs (*Settings → About*) contain none of these and are safe to attach.

Security problems go through [private reporting](SECURITY.md), not public issues.

## Contributing code

1. **Open an issue first** for anything beyond a small fix, so the approach can be agreed before you spend time on it.
2. Set up the project as described in the [development guide](docs/development.md).
3. Create a branch, make your change, and add or update tests.
4. Before opening a pull request, run:

   ```bash
   npm run lint
   ```

   ```bash
   npm run typecheck
   ```

   ```bash
   npm test
   ```

   ```bash
   npm run e2e
   ```

5. Open a pull request describing what changed and why. CI runs the same checks on Windows, macOS and Linux.

### What a change needs

- **Tests.** New behaviour comes with tests; a bug fix comes with a test that fails without it.
- **The security boundaries kept intact.** The interface window never receives API keys and never makes network requests. Every IPC handler validates its input. See the [architecture document](docs/architecture.md).
- **No provider-specific code in shared interface code.** Provider features go through the adapter extension interface.
- **Honest documentation.** If a feature has not been verified against a real service or platform, the documentation says so.
- **The existing style.** There is no automatic formatter; match the file you are editing.

### Adding a provider

Providers that speak the OpenAI-compatible API need only a preset in `src/shared/presets.ts`. Provider-specific behaviour is added as a provider extension; `src/main/providers/venice.ts` is the fullest example. The [architecture document](docs/architecture.md#providers-and-adapters) lists the hooks.

## Licence

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE) that covers the project.
