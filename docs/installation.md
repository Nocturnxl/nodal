# Installing NODAL

NODAL is installed from a downloaded installer. You do not need to build anything.

All downloads are on the [Releases page](https://github.com/Nocturnxl/nodal/releases/latest). The files named `NODAL-…` are the installers. "Source code (zip)" and "Source code (tar.gz)" are the program's source, which you do not need unless you intend to work on NODAL itself.

| Platform | File | Status |
| --- | --- | --- |
| Windows 10 or later, 64-bit | `NODAL-Setup-windows-x64.exe` | Developed and used on Windows 11 |
| macOS, Apple Silicon (M1 or later) | `NODAL-macos-arm64.dmg` | Experimental: passes automated tests, not yet used by hand |
| Linux, x86-64 | `NODAL-linux-x86_64.AppImage` | Experimental: passes automated tests on Ubuntu 24.04, not yet used by hand |
| Linux, x86-64, Debian or Ubuntu | `NODAL-linux-amd64.deb` | Experimental: same |

Not provided: Intel Macs, Windows on ARM, Linux on ARM.

NODAL needs no account and no internet connection of its own. To talk to a cloud provider you need an internet connection and an API key from that provider; to talk to a local model you need a local server such as LM Studio or Ollama.

## About the security warnings

NODAL's installers are **not code-signed yet**. Signing requires certificates the project does not have at this stage. Because of that, Windows and macOS warn you before running it. The warnings mean "the publisher of this file has not been verified by the operating system", not that something was found wrong with it.

If you want assurance that the file you downloaded is the one published here, [verify its checksum](#verifying-a-download) before you run it.

## Windows

1. Download `NODAL-Setup-windows-x64.exe`.
2. Open it. Windows may show **"Windows protected your PC"**. Choose **More info**, then **Run anyway**.
3. Follow the installer. You can choose the folder; it installs for your user account only and does not ask for administrator rights.
4. Start NODAL from the Start menu.

Some browsers also warn that the file "is not commonly downloaded". Choose to keep it.

**To uninstall:** *Settings → Apps → Installed apps → NODAL → Uninstall*. Your conversations and settings are kept in `%APPDATA%\NODAL`; delete that folder too if you want them gone.

## macOS

> This build has not yet been run by hand on a Mac. If you try it, please file a [platform test report](https://github.com/Nocturnxl/nodal/issues/new?template=platform_test_report.yml), whatever the result.

1. Download `NODAL-macos-arm64.dmg` and open it.
2. Drag **NODAL** into **Applications**.
3. Open NODAL from Applications. macOS will refuse the first time, because the app is not signed by an identified developer.
4. Open **System Settings → Privacy & Security**, scroll to the message about NODAL, and choose **Open Anyway**. Confirm when asked. This is needed only once.

If macOS says the app **"is damaged and can't be opened"**, that is the same protection described differently for unsigned downloads. Remove the download marker by running this in Terminal, then open NODAL again:

```bash
xattr -cr /Applications/NODAL.app
```

The first time you turn on voice chat, macOS should ask whether NODAL may use the microphone. Whether that prompt appears correctly in this unsigned build is one of the things not yet verified.

**To uninstall:** drag NODAL from Applications to the Trash. Your data is in `~/Library/Application Support/NODAL`.

## Linux

> These builds have not yet been run by hand. If you try one, please file a [platform test report](https://github.com/Nocturnxl/nodal/issues/new?template=platform_test_report.yml).

NODAL stores API keys in your desktop's keyring (GNOME Keyring / libsecret, or KWallet). **A keyring must be installed and unlocked.** If none is available, NODAL refuses to save keys rather than store them unprotected, and tells you so.

### AppImage

```bash
chmod +x NODAL-linux-x86_64.AppImage
```

```bash
./NODAL-linux-x86_64.AppImage
```

AppImages need FUSE 2. On recent Ubuntu releases it is not installed by default:

```bash
sudo apt install libfuse2t64
```

(On Ubuntu 22.04 the package is `libfuse2`.)

### Debian or Ubuntu package

```bash
sudo apt install ./NODAL-linux-amd64.deb
```

Then start NODAL from your application menu.

**To uninstall:** `sudo apt remove nodal` for the package, or delete the AppImage. Your data is in `~/.config/NODAL`.

If NODAL says it cannot store keys although you have a keyring, see [Troubleshooting](troubleshooting.md#linux-nodal-says-it-cannot-store-keys).

## Verifying a download

Every release includes a file named `SHA256SUMS.txt` listing the SHA-256 checksum of each installer. A checksum is a fingerprint of a file: if the fingerprint of your download matches the published one, the file arrived intact and unaltered.

Windows (PowerShell), in the folder with the download:

```powershell
Get-FileHash .\NODAL-Setup-windows-x64.exe -Algorithm SHA256
```

macOS:

```bash
shasum -a 256 NODAL-macos-arm64.dmg
```

Linux, with `SHA256SUMS.txt` in the same folder:

```bash
sha256sum --check --ignore-missing SHA256SUMS.txt
```

Compare the result with the line for your file in `SHA256SUMS.txt`. A checksum shows that the file matches what was published in this repository. It does not replace code signing, which this release does not have.

## Updating

There is no automatic update. To update, download the newer installer and install it over the old version. Conversations, settings and keys are kept, because they live in the data folder, not in the application.

Before a database format change, NODAL saves a copy of the database in the `backups` folder inside the data folder.

## Where your data is kept

| Platform | Data folder |
| --- | --- |
| Windows | `%APPDATA%\NODAL` |
| macOS | `~/Library/Application Support/NODAL` |
| Linux | `~/.config/NODAL` |

*Settings → Data → Open folder* opens it from inside NODAL, whatever the platform. The [configuration reference](configuration.md#the-data-folder) explains what each file is.

Uninstalling NODAL does not delete this folder.
