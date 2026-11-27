# Security policy

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue.

Use GitHub's private reporting: on this repository, open the **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/Nocturnxl/nodal/security/advisories/new)). Only the maintainers can see the report.

Please include:

- what you found and why it matters,
- the NODAL version and your operating system,
- steps to reproduce it, or a proof of concept.

Do not include real API keys, passphrases or private conversations in a report.

NODAL is a small independent project and offers no bounty and no guaranteed response time. Reports are read, and a confirmed problem is fixed and disclosed in the changelog and a security advisory, with credit to the reporter unless they prefer otherwise.

## Supported versions

Only the latest release receives fixes.

## What NODAL is designed to protect

- **API keys** are encrypted by the operating system's credential store and are never given to the interface window.
- **The interface window** is sandboxed and cannot make network requests.
- **Outbound requests** go only to hosts of providers you configured, over HTTPS (plain HTTP only to your own computer, or your local network after confirmation).
- **Model output** is treated as untrusted: no raw HTML, no automatic loading of remote content, links only after confirmation.
- **Conversations at rest** can be encrypted with a passphrase.
- **Packaged builds** refuse to run with a modified application archive.

The details are in the [architecture document](docs/architecture.md#security-model).

## What it does not protect against

- Malware or another person already acting as you on your computer while NODAL is unlocked.
- A provider's handling of the requests you send it.
- A weak encryption passphrase.
- Loss of your data: a forgotten passphrase cannot be recovered.

## Current limitations

Stated plainly, so you can judge for yourself:

- **No independent security review** of NODAL, including its encryption design, has been carried out.
- **Installers are not code-signed**, so the operating system cannot verify their publisher. Verify downloads against `SHA256SUMS.txt` from the release page.
- **No automatic updates**, so security fixes reach you only when you install a newer release.
