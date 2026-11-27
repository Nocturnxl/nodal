# Troubleshooting

If your problem is not here, [open an issue](https://github.com/Nocturnxl/nodal/issues/new/choose). The log folder (*Settings → About*) often helps; logs never contain your messages, keys or passphrases.

## Installing and starting

**Windows says "Windows protected your PC".** The installer is not code-signed yet. Choose *More info*, then *Run anyway*. See [Installing NODAL](installation.md#about-the-security-warnings).

**macOS says NODAL cannot be opened, or is damaged.** Same cause. Use *System Settings → Privacy & Security → Open Anyway*, or run `xattr -cr /Applications/NODAL.app` in Terminal. See [Installing NODAL](installation.md#macos).

**The AppImage does nothing when started.** It needs FUSE 2: `sudo apt install libfuse2t64` on recent Ubuntu (`libfuse2` on 22.04), and the file must be executable (`chmod +x`).

**NODAL closes with "cannot start" and mentions the database.** The message says why. If it says the database is encrypted but `vault.json` is missing, that file was removed from the data folder; restore it from a backup of the folder. Without it the database cannot be opened.

### Linux: NODAL says it cannot store keys

NODAL keeps API keys in your desktop keyring and refuses to save them unprotected. Make sure GNOME Keyring or KWallet is installed and unlocked. If you have one and NODAL still does not find it (common on minimal window managers), start NODAL with the keyring named explicitly:

```bash
NODAL_PASSWORD_STORE=gnome-libsecret ./NODAL-linux-x86_64.AppImage
```

Use `kwallet5` or `kwallet6` for KDE.

## Connecting to a provider

**"Key rejected".** The provider did not accept the key. Check that you copied all of it, that it has not been revoked, and that it belongs to this provider. A rejected key is not saved.

**"Model or endpoint not found".** Usually the base URL is slightly wrong (many end in `/v1`), or the model ID no longer exists at the provider. Refresh the model list in the provider's settings and pick the model again.

**"Out of balance".** The provider reports that your account has no credit.

**"Rate limited".** You are sending requests faster than the provider allows for your account. NODAL waits and retries a few times on its own before showing this.

**The model list is empty or will not load.** Check the base URL and, for custom endpoints, the *Model list path*. If the endpoint has no model list at all, add model IDs by hand in the provider's settings.

**A reply never starts and then times out.** Some models, reasoning models especially, take a long time to produce the first word. Raise *Wait for first token* under *Settings → Network*.

**Requests fail behind a company proxy.** Set the proxy under *Settings → Network*, or leave it empty to use the system proxy.

**"The provider URL is not allowed".** NODAL refuses plain `http://` to addresses outside your own computer and network. Use `https://`. For a server on your local network, tick the confirmation in the provider form.

## Local models

**LM Studio or Ollama will not connect.** Make sure the local server is actually running: in LM Studio it has to be started (the *Developer* tab); Ollama runs in the background once installed. Then check the address: `http://localhost:1234/v1` for LM Studio and `http://localhost:11434/v1` for Ollama unless you changed them.

**No models listed.** Load or download a model in LM Studio or Ollama first, then refresh the list.

**The server is on another computer on my network.** Use its address (for example `http://192.168.1.20:11434/v1`), tick the local-network confirmation, and make sure that server is set to accept connections from other machines.

These presets follow LM Studio's and Ollama's documentation but have not been run against them yet. If something does not work, an issue describing it is very welcome.

## Images

**There is no image button.** The provider says the selected model cannot take images. Choose a model with vision.

**The model ignores or rejects my image.** Where the button is marked *unverified*, the provider did not say whether the model supports images, and this one evidently does not.

## Voice chat

**There is no microphone button.** Voice chat is offered only for Venice.ai conversations.

**"No sound is coming from the microphone".** NODAL is receiving complete silence. Check that the microphone is not muted (on the device or in the system's sound settings) and that NODAL is allowed to use it: *Settings → Privacy & security → Microphone* on Windows, *System Settings → Privacy & Security → Microphone* on macOS.

**It never notices that I stopped talking.** In a noisy room the pause may not register. Choose **Send now** to end your turn.

**It says voice chat stopped, with an error.** The message is the provider's. A key problem, an empty balance, or a change in Venice's Beta speech services are the likely causes.

Voice chat is experimental and has not yet been confirmed against the live Venice service. Please report what you find.

## Encryption

**I forgot my passphrase.** It cannot be reset or recovered, by anyone. If you have an export, you can start fresh and import it: close NODAL, rename the data folder, start NODAL, and use *Restore from an export*.

**I turned on "Delete all chats after 5 wrong passphrases" and it triggered.** The conversations, images and stored keys are gone and cannot be brought back. Exports you saved elsewhere are unaffected and can be imported.

**NODAL keeps locking.** *Settings → Security → Lock automatically* sets the idle time, or *Never*.

## Data

**Where are my conversations?** *Settings → Data → Open folder*. See [the data folder](configuration.md#the-data-folder).

**I want to start completely fresh.** Close NODAL and delete or rename the data folder. NODAL starts as new.

**My API keys vanished after copying the data folder to another computer.** Expected: keys are encrypted for one computer and user account. Enter them again.
