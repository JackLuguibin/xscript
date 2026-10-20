# Desktop client: installers, updates and diagnostics

![About and updates](images/desktop-update-en.png)

## Install

- **macOS (Apple Silicon)**: open `xscript-desktop-vX.Y.Z-macos-arm64.dmg` and drag XScript into Applications. The app is only ad-hoc signed (no Developer ID, not notarized), so the first launch needs **System Settings → Privacy & Security → Open Anyway** (macOS 14 and earlier: right-click → Open).
- **Windows (x64)**: run `xscript-desktop-vX.Y.Z-windows-x64-setup.exe`. It installs per user into `%LOCALAPPDATA%\Programs\XScript` without admin rights, and a newer setup upgrades in place. The installer is not code-signed: when SmartScreen warns, choose **More info → Run anyway**. Uninstall from Settings → Apps.

## Updates

**Settings and updates** in the sidebar → **Check for updates**. The update manifest (`desktop-update.json`) lists the version and each installer's size and sha256 and is signed with Ed25519; the client verifies the signature before reading it and the file's size and sha256 after downloading. Nothing is installed until you confirm **Install and restart**: on macOS the new app is copied next to the old one and checked (signature, bundle id, version), then a small helper swaps them after XScript quits and reopens it (rolling back on failure); on Windows the verified setup runs silently after XScript quits. **Check at startup** checks at most once a day and puts a dot on the sidebar button.

Release builds do not ship an update public key yet, so they say updates are not configured and point to GitHub Releases. Enabling it needs a repository admin: create a key with `python desktop/app/packaging/make_update_feed.py --new-key key.txt`, store the private key as the `DESKTOP_UPDATE_KEY` secret and put the printed public key into `UPDATE_PUBLIC_KEYS` in `desktop/app/xscript_desktop/services/updater.py`.

### Testing without a release (macOS)

```bash
desktop/app/.venv/bin/python scripts/desktop_update_e2e.py
```

It builds the current version and a test version `X.Y.(Z+1)-dev1`, checks both dmgs really open, installs the old one into a temporary folder, serves a local feed signed with a throwaway key, checks that a different key is refused, then runs `--update-now` and verifies the swapped, relaunched app reports the new version. To try it by hand, start the app with `XSCRIPT_UPDATE_FEED=http://127.0.0.1:<port>/desktop-update.json` and `XSCRIPT_UPDATE_PUBKEY=<public key>`.

## Diagnostics bundle

**Export diagnostics…** in the same dialog writes a zip with `info.json` (versions, system, device counts and states, update state) and the desktop logs (`<data dir>/logs/desktop.log`, 3 × 1 MB rotated). Tokens, passwords, pairing codes and private keys are replaced with `***` and the home folder with `~`; the credential store is never read and nothing is uploaded.

## Release workflow

Pull requests touching the packaging or `release.yml`, and manual runs, build and check both installers (dmg: signature and launch; setup.exe: silent install, `--selftest`, silent uninstall) and sign a throwaway-key feed for them that is verified with the client's own code. Everything is uploaded as artifacts; no Release or tag is created. A tagged release attaches the setup.exe and, only when the update key is set up, the signed feed.
