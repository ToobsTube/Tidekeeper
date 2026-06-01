# Tidekeeper

A mod manager for **Subnautica 2**, built with Tauri and React.

Browse, install, and manage mods from Nexus Mods directly inside the app. Supports both UE4SS script mods and PAK content mods, with profiles for switching between mod setups and mod pack sharing for playing with friends.

---

## Features

- Browse and search Nexus Mods from within the app — click any mod card to see details, download count, endorsements, and summary before installing
- Install mods via **Mod Manager Download** (NXM protocol) — click the button on Nexus and Tidekeeper handles the rest
- **One-click updates for Nexus Premium members** — update directly from the Updates tab without opening a browser
- Enable and disable mods without uninstalling them
- **Smart update backup** — when a mod is updated, the old version is automatically backed up. Your config settings are preserved, and a rollback button appears in the Library if anything breaks
- **Config file access** — mods with config files show a ⚙ button in the Library that opens the file directly in your default text editor. After an update, a second button lets you compare your old settings against the new defaults
- **File integrity check** — verify that all installed mod files are still in place with one click
- **Library shows proper Nexus mod names** — mods installed from Nexus display their actual mod page name alongside the folder name, with variant labels (e.g. "Lite" / "Plus") so you always know what you have installed
- **Variant conflict detection** — warns you when two files from the same mod are both enabled at once, with the affected rows highlighted
- **Clickable Nexus badge** — jump straight to a mod's Nexus page from the Library
- **Mod profiles** — save and switch between different mod loadouts
- **Mod pack export/import** (.tkpack) — bundle your entire mod list and share it with friends. When importing, choose to save it as a profile so you can switch between your setup and a friend's with one click
- **Updates tab** — see which of your installed Nexus mods have newer versions available. Premium members get a direct Update button; free members get a link to the Nexus files page
- **Launch Subnautica 2** directly from the app
- Supports ZIP, 7z, and RAR archives
- Theme picker — choose from preset accent colors or pick a custom one
- Diagnostics tool — scan for common issues, view Tidekeeper and UE4SS logs, export a report

---

## Requirements

- **Windows 10 or later** (64-bit)
- **Subnautica 2** installed via Steam
- **7-Zip** installed at the default path (`C:\Program Files\7-Zip\`) — only required if you install mods packaged as `.rar` archives

---

## Installation

1. Download the latest installer from the [Releases](https://github.com/ToobsTube/Tidekeeper/releases) page
2. Run the installer
3. On first launch, point Tidekeeper to your UE4SS Mods folder

The UE4SS Mods folder is typically located at:
```
C:\Program Files (x86)\Steam\steamapps\common\Subnautica2\Binaries\Win64\ue4ss\Mods
```

> **Note on antivirus warnings:** A couple of scanners flag Tidekeeper because it is not yet code-signed. This is a false positive — all major consumer antivirus engines report it as clean. The full source code is in this repository for anyone who wants to verify it. We are in the process of applying for code signing through the [SignPath Foundation](https://signpath.org) open-source program, which should resolve these flags once approved. If Windows SmartScreen warns you on install, click "More info" → "Run anyway".

### Installing UE4SS

UE4SS is required for script mods. Tidekeeper installs it for you — but you must use the **Subnautica 2 specific build from Nexus Mods**, not the generic release from GitHub. The GitHub version will not work.

Download the SN2 build from [Nexus Mods (mod #36)](https://www.nexusmods.com/subnautica2/mods/36), then use **+ Install ZIP** in the Library tab. Tidekeeper detects the UE4SS archive automatically and places the files in the correct location. The **Diagnostics** tool will warn you if UE4SS is missing or not set up correctly.

---

## Installing Mods via Mod Manager Download

1. Find a mod on the [Nexus Mods](https://www.nexusmods.com/subnautica2) website
2. Go to the **Files** tab and click **Mod Manager Download**
3. Choose a download speed — when your browser asks to open Tidekeeper, allow it
4. Tidekeeper downloads and installs the mod automatically

> Nexus Premium members can also install and update mods directly from the **Discover** and **Updates** tabs inside the app without opening a browser.

---

## Mod Types

Tidekeeper manages two kinds of Subnautica 2 mods:

| Type | Format | Location |
|------|--------|----------|
| UE4SS script mods | `.lua` files | `Subnautica2\Binaries\Win64\ue4ss\Mods\` |
| PAK content mods | `.pak` + `.ucas` + `.utoc` | `Subnautica2\Content\Paks\LogicMods\` |

Both types are installed, enabled, disabled, and uninstalled from the same Library tab.

---

## Mod Packs

Mod packs let you export your full mod list (including enabled/disabled state) as a single `.tkpack` file and share it with friends. When they import it, Tidekeeper detects any conflicts with their existing mods before installing.

This is useful for multiplayer — everyone can run the same mods without manually matching versions.

---

## Roadmap

- [x] Browse and install mods from Nexus Mods (Discover tab)
- [x] Mod detail view — click any mod card to see full info before installing
- [x] Mod Manager Download / NXM protocol support
- [x] Mod pack export and import (.tkpack) for sharing with friends
- [x] App auto-updater
- [x] Installed mod tracking with source metadata, display names, variant labels, and version info
- [x] Mod update checker
- [x] Theme picker (preset colors + custom)
- [x] Updates tab — dedicated view for checking and acting on available mod updates
- [x] Profile creation on mod pack import — switch between your setup and a friend's in one click
- [x] Variant conflict detection — warns when two files from the same mod are both enabled
- [x] Launch Subnautica 2 from the app
- [x] One-click updates for Nexus Premium members
- [x] Smart update backup and rollback
- [x] Config file access — open mod config files directly from the Library
- [x] File integrity verification — check that all installed mod files are still present
- [ ] Appear in the Nexus Mods mod manager dropdown (NXM registration pending approval)
- [ ] Nexus account sign-in (pending Nexus OAuth approval)
- [ ] Support for multiple game installations (e.g. experimental vs live branch)

---

## Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

**Team roles:**
- Maintainer and approver: [ToobsTube](https://github.com/ToobsTube)

**Privacy policy:**
This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it. Tidekeeper communicates with the [Nexus Mods API](https://www.nexusmods.com) on behalf of the user; no data is sent to any servers operated by this project.

---

## Building from Source

Requirements: [Rust](https://rustup.rs/) and [Node.js](https://nodejs.org/) 18+

```bash
npm install
npm run tauri dev
```

---

## License

This project is not affiliated with Unknown Worlds Entertainment or Nexus Mods.
