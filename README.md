# Tidekeeper

A mod manager for **Subnautica 2**, built with Tauri and React.

Browse, install, and manage mods from Nexus Mods directly inside the app. Supports both UE4SS script mods and PAK content mods, with profiles for switching between mod setups and mod pack sharing for playing with friends.

---

## Features

- Browse and search Nexus Mods from within the app
- Install mods via **Mod Manager Download** (NXM protocol) — click the button on Nexus and Tidekeeper handles the rest
- Direct install from the app for Nexus Premium members
- Enable and disable mods without uninstalling them
- **Mod profiles** — save and switch between different mod loadouts
- **Mod pack export/import** (.tkpack) — bundle your entire mod list and share it with friends
- **Update checker** — see which installed mods have newer versions available on Nexus
- Supports ZIP, 7z, and RAR archives
- App auto-updater — stay up to date automatically

---

## Requirements

- **Windows 10 or later** (64-bit)
- **Subnautica 2** installed
- **Nexus Mods account** with a Personal API Key (free tier works)
- **7-Zip** installed at the default path (`C:\Program Files\7-Zip\`) — only required if you install mods packaged as `.rar` archives

---

## Installation

1. Download the latest `.msi` or `.exe` installer from the [Releases](https://github.com/ToobsTube/Tidekeeper/releases) page
2. Run the installer
3. On first launch, point Tidekeeper to your UE4SS Mods folder

The UE4SS Mods folder is typically located at:
```
C:\Program Files (x86)\Steam\steamapps\common\Subnautica2\Binaries\Win64\ue4ss\Mods
```

### Installing UE4SS

UE4SS is required for script mods. Tidekeeper installs it for you — download the Subnautica 2 build from [Nexus Mods (mod #36)](https://www.nexusmods.com/subnautica2/mods/36), then use **+ Install ZIP** in the Library tab. Tidekeeper detects the UE4SS archive automatically and places the files in the correct location. The **Diagnostics** tool will warn you if UE4SS is missing or not set up correctly.

---

## Setting Up Your Nexus API Key

A Nexus API key lets Tidekeeper browse mods and check for updates on your behalf.

1. Log in at [next.nexusmods.com/settings/api-keys](https://next.nexusmods.com/settings/api-keys)
2. Copy your **Personal API Key**
3. Open **Settings** in Tidekeeper and paste it in

---

## Installing Mods via Mod Manager Download

1. Find a mod on the [Nexus Mods](https://www.nexusmods.com/subnautica2) website
2. Go to the **Files** tab and click **Mod Manager Download**
3. Choose a download speed — when your browser asks to open Tidekeeper, allow it
4. Tidekeeper downloads and installs the mod automatically

> Nexus Premium members can also install mods directly from the **Discover** tab inside the app without opening a browser.

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

## Building from Source

Requirements: [Rust](https://rustup.rs/) and [Node.js](https://nodejs.org/) 18+

```bash
npm install
npm run tauri dev
```

---

## License

This project is not affiliated with Unknown Worlds Entertainment or Nexus Mods.
