## Download

| Platform | File |
| --- | --- |
| macOS, Apple Silicon (M1 and later) | `Lagoon-<version>-arm64.dmg` |
| macOS, Intel | `Lagoon-<version>-x64.dmg` |
| Windows 10 / 11 (64-bit) | `Lagoon-<version>-setup.exe` |
| Linux (64-bit) | `Lagoon-<version>-x86_64.AppImage` or `lagoon_<version>_amd64.deb` |

## First launch

These builds are not signed with a paid certificate yet, so the system asks once before opening them.

- **macOS:** open the DMG and drag Lagoon to Applications. Open it once; when macOS says it can't verify the app, go to **System Settings → Privacy & Security** and click **Open Anyway**. Or run `xattr -dr com.apple.quarantine /Applications/Lagoon.app`.
- **Windows:** if SmartScreen shows "Windows protected your PC", click **More info → Run anyway**.
- **Linux:** `chmod +x Lagoon-*.AppImage` and run it, or `sudo apt install ./lagoon_*_amd64.deb`.

Moving from another app? **Connections → ⋯ → Import Connections** reads TablePlus, DBeaver and Navicat (.ncx) connections.
