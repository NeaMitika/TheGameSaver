# GameSaver

<img width="630" height="500" alt="image" src="https://github.com/user-attachments/assets/b5f9ffa6-90e8-46ee-be0b-96a16eccaa64" />


GameSaver is a desktop app that protects save files for standalone Windows games (CD installs, DRM-free downloads, portable installs, and other non-launcher setups).

It tracks your games, watches save locations, creates versioned snapshots, and lets you restore or verify backups from a simple Electron UI.

## Why GameSaver

- Designed for non-Steam / non-launcher workflows.
- Multiple save locations per game (folders and single files).
- Automatic backups from file watcher events and periodic scans.
- Session-aware protection: detects game start/stop and triggers backup on exit.
- One-click restore with a required pre-restore safety snapshot.
- Snapshot integrity verification with SHA-256 checksums.
- Portable-friendly data root support (USB workflows).
- Tray integration and compact widget mode.

## Current Feature Set

- Add/remove games manually with executable + install path.
- Auto-suggest save locations from common Windows paths:
  - `%USERPROFILE%\Documents\My Games\{GameName}`
  - `%APPDATA%\{GameName}`
  - `%LOCALAPPDATA%\{GameName}`
  - `%PROGRAMDATA%\{GameName}`
  - `{InstallDir}\Save`, `{InstallDir}\Saves`, `{InstallDir}\Profiles`
- Manage save locations per game:
  - add, remove, enable/disable, missing-path visibility
- Snapshot operations:
  - backup now
  - restore
  - verify
  - delete
  - scan/import snapshots from disk into library state
- Global settings:
  - backup frequency (minutes)
  - retention count per game
  - storage root
  - data folder (with migration + restart prompt)
- Recovery mode when startup data paths are unavailable.

## Tech Stack

- Electron (main + preload + renderer)
- React 18 + TypeScript
- Vite 7
- Tailwind CSS 4 + Radix UI primitives
- Vitest + ESLint
- `electron-builder` (NSIS on Windows)

## Requirements

- Windows 10/11
- Node.js `22.17.0` (see `.nvmrc`)
- npm

## Quick Start (Development)

```bash
npm ci
npm run dev
```

`npm run dev` runs:

- Vite renderer on `http://localhost:5175`
- TypeScript watch build for main/preload/shared
- Electron app launch once renderer + main build are ready

## Quality Checks

```bash
npm run typecheck
npm run lint
npm test
```

## Build and Package

```bash
npm run build      # compile renderer + electron code into dist/
npm run pack       # unpacked app via electron-builder --dir
npm run dist       # NSIS installer + publish config
```

Configured build target:

- Windows NSIS installer (`build.win.target = nsis`)

## How It Works

1. Add a game with name, executable path, and install path.
2. GameSaver auto-detects candidate save locations and stores manual/auto locations.
3. Backup engine creates timestamped snapshot folders and per-file checksums.
4. Watchers + periodic scan + session monitor trigger automatic backups.
5. Retention policy keeps only the latest `N` snapshots per game.
6. Restore requires a successful `pre-restore` safety snapshot first.

## Data and Folder Layout

GameSaver uses two key paths:

- Data Folder: app state (`settings.json`, `library.json`, etc.)
- Storage Root: backup payloads (defaults to `<Data Folder>\Backups`)

Typical layout:

```text
<Data Folder>\
  AppState\
    settings.json
    library.json

<Storage Root>\
  <GameFolder>\
    metadata.json
    Snapshots\
      2026-02-09_20-14-18-120\
        snapshot.manifest.json
        <LocationFolderA>\...
        <LocationFolderB>\...
```

Notes:

- In packaged mode, GameSaver prefers a portable local data root at `<InstallDir>\GameSaverData` when writable.
- A bootstrap file is kept under Electron app-data to remember the selected data root.

## Security Model

- `contextIsolation: true`
- `nodeIntegration: false` (renderer)
- `sandbox: true`
- strict navigation/window restrictions
- CSP enforced for renderer content
- IPC payload validation in main process before handling actions

## CI / Release

GitHub Actions workflow (`.github/workflows/release.yml`) on pushes to `main`:

1. Resolves version from `package.json`
2. Creates/pushes tag `v<version>`
3. Builds and publishes via `electron-builder --publish always`

`publish` is configured for `NeaMitika/GameSaver`.

## Project Structure

```text
src/
  main/        # Electron main process + services
  preload/     # secure renderer API bridge
  renderer/    # React UI
  shared/      # shared types/contracts
tests/         # Vitest coverage for core services
scripts/       # dev runtime helpers
```

## Known Limitations

- Windows-focused implementation.
- Snapshots are full copies (no dedup/delta yet).
- `compressionEnabled` exists in settings/state but compression is not active yet.
- No explicit license file is present yet.
