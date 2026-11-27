# Configuration reference

NODAL is configured entirely inside the application. There is no configuration file to edit.

## Providers

*Settings → Providers.*

| Preset | Address | Key |
| --- | --- | --- |
| Venice.ai | `https://api.venice.ai/api/v1` | Required |
| OpenRouter | `https://openrouter.ai/api/v1` | Required |
| OpenAI | `https://api.openai.com/v1` | Required |
| LM Studio | `http://localhost:1234/v1` | None |
| Ollama | `http://localhost:11434/v1` | None |
| Custom | You supply it | Optional |

Each provider has:

| Field | Meaning |
| --- | --- |
| Name | What NODAL calls it. |
| Base URL | The address of the API. Every request goes to this address and nowhere else. |
| API key | Stored encrypted by the operating system. Shown afterwards only as its last four characters. |
| Model list path | Where the list of models is served, relative to the base URL. `/models` unless your endpoint differs. |
| Extra headers | Additional HTTP headers to send with every request, one per line as `Name: value`. For gateways that need them. |
| Manual model IDs | Models to offer that the endpoint's list does not include. |

Changing a provider's host deletes its stored key. Deleting a provider that conversations still use lets you move those conversations to another provider first.

### Custom endpoints

Any server that implements the OpenAI chat completions API works: self-hosted model servers, gateways, and other providers' compatible endpoints.

1. Choose **Custom** and enter a name.
2. Enter the **base URL**: the part before `/chat/completions`. It usually ends in `/v1`.
3. Enter the key if the server needs one.
4. **Connect.** If the server publishes a model list, NODAL loads it; otherwise add model IDs by hand.

Rules NODAL applies to addresses:

- `https://` addresses are always allowed.
- `http://` is allowed for this computer (`localhost`, `127.0.0.1`).
- `http://` to an address on your local network is allowed only after you tick a confirmation for that provider, because the key and your messages would travel unencrypted on that network.
- `http://` to any other address is refused.

Small differences between servers are handled automatically: if a server rejects one of a few optional request fields by name, NODAL drops or renames that field and retries before any output appears.

### Provider notes

**Venice.ai.** Chat, streaming, reasoning and key validation were confirmed against the live service. Web search and URL scraping add usage-based charges on Venice's side and are labelled *extra cost*. *Venice system prompt* is off by default because, measured live, it added about 1,700 prompt tokens to every request; turn it on per conversation if you want it. The character list and voice chat use endpoints Venice marks Preview and Beta, and have not yet been confirmed against the live service.

**OpenRouter.** Key validation and the model list were confirmed against the live service. No chat has been run against it yet.

**OpenAI, LM Studio, Ollama.** The addresses and authentication follow each provider's documentation. None has been run yet. Reports are welcome.

## Per-conversation controls

In the inspector (`Ctrl+I`). Described in the [user guide](user-guide.md#the-inspector-prompts-and-controls).

| Control | Range | When empty |
| --- | --- | --- |
| System prompt | Free text | No system prompt is sent |
| Temperature | 0 to 2 | Provider or model default |
| Top-p | 0 to 1 | Provider or model default |
| Max output tokens | 1 to the model's limit | Provider default |
| Context limit | 256 tokens upward | The model's limit, when known |
| Model options | Depends on the provider | Each option's default |

## Settings

### Appearance

| Setting | Default | Notes |
| --- | --- | --- |
| Theme | System | System, Light or Dark |
| Render math | Off | Typesets `$…$` and `$$…$$` |
| Show archived conversations | Off | |
| Default system prompt | Empty | Used for new chats |
| Voice instructions | A short instruction to answer in spoken style | Added to the system prompt on spoken turns only |

### Data

Export this conversation, Export ZIP, Encrypted export, Import, and a button that opens the data folder. See [Export and import](user-guide.md#export-and-import).

### Security

| Setting | Default | Notes |
| --- | --- | --- |
| Encrypt chats on this computer | Off | Passphrase of at least 8 characters. No recovery if forgotten. |
| Lock automatically | After 15 minutes | Never, or 1, 5, 15, 30 or 60 minutes without input. Unless Never, also locks when the computer locks or sleeps. Applies only with encryption on. |
| Delete all chats after 5 wrong passphrases in a row | Off | Permanent. Also deletes stored API keys. |

### Network

| Setting | Default | Notes |
| --- | --- | --- |
| Check for updates | Off | No update feed is configured in this release, so turning it on has no effect yet. |
| Proxy | Empty (use the system proxy) | For example `http://127.0.0.1:8080` or `socks5://127.0.0.1:1080`. Applies to provider requests. |
| Wait for first token | 60 seconds | How long to wait for a reply to begin. 5 to 300. Raise it for slow reasoning models. |

### About

Version information and a button that opens the log folder.

## The data folder

| Platform | Location |
| --- | --- |
| Windows | `%APPDATA%\NODAL` |
| macOS | `~/Library/Application Support/NODAL` |
| Linux | `~/.config/NODAL` |

| File or folder | Contents |
| --- | --- |
| `nodal.db` | The database: providers, conversations, messages, settings, the cached model list. Encrypted when encryption is on. Files beside it ending `-wal` and `-shm` belong to it. |
| `keys.json` | Your API keys, encrypted by the operating system. Useless on another computer or user account. |
| `vault.json` | Only when encryption is on: the sealed encryption key and its settings. **Without it the database cannot be opened**, so back it up together with `nodal.db`. |
| `attachments/` | Images you attached. Encrypted, with unrevealing names, when encryption is on. |
| `backups/` | A copy of the database taken before each change of database format. |
| `logs/` | Diagnostic logs. They record events, sizes and error messages, never message text, keys or passphrases. Five files of 2 MB at most. |

The remaining files and folders in the data folder belong to the browser engine NODAL is built on and hold no conversation content.

**To back up NODAL**, the simplest reliable way is *Settings → Data → Encrypted export*. Copying the data folder while NODAL is closed also works on the same computer and user account, but the copied `keys.json` will not decrypt elsewhere.

**To move to another computer**, export on the old one, import on the new one, and enter your API keys again.

## Environment variables

For unusual setups. Most people need none of these.

| Variable | Effect |
| --- | --- |
| `NODAL_USER_DATA` | Use a different data folder. Useful for keeping separate profiles. |
| `NODAL_PASSWORD_STORE` | Linux only. Names the keyring to use when the desktop session is not recognised automatically: `gnome-libsecret`, `kwallet`, `kwallet5` or `kwallet6`. It cannot select unprotected storage. |
