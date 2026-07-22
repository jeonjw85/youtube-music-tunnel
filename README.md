# YTM Tunnel Desktop

**[한국어](./README.ko.md)**

An Electron-based YouTube Music desktop client with an app-local SOCKS5 tunnel that the app manages itself.

YTM Tunnel Desktop is designed for cases where YouTube Music should use a VPN/proxy tunnel, but the rest of Windows should keep using the normal network path. The app applies the proxy only to its own Electron/Chromium process, starts and stops its own bundled `sing-box` tunnel, and never changes Windows system proxy settings.

## What It Does

- Opens YouTube Music in a dedicated desktop window.
- Routes only this app through a local SOCKS5 proxy, by default `socks5://127.0.0.1:1080`.
- Starts and stops the `sing-box` WireGuard tunnel automatically with the app — no terminal, no separate launcher.
- On first launch, converts a WireGuard `.conf` file you pick (e.g. from Mullvad) into the tunnel config.
- Keeps system-wide Windows traffic untouched.
- Includes tray controls, media key support, and a simple equalizer window.

## Architecture

```text
YTM Tunnel Desktop (Electron)
  -> starts sing-box (bundled in the installer)
  -> 127.0.0.1:1080 SOCKS5
  -> WireGuard endpoint
```

The Electron app applies the proxy to its own Chromium process with:

```js
app.commandLine.appendSwitch("proxy-server", proxy);
```

No Windows system proxy setting is modified.

## Install (end users)

Download the Windows installer (`YTM Tunnel Desktop-*-Setup-x64.exe`) from the releases, install, and launch. `sing-box.exe` is bundled — nothing else to install.

On first launch the app asks you to pick a WireGuard `.conf` file (for example one exported from Mullvad). It converts the file automatically and starts the tunnel. The private key never leaves your machine.

## Quick Start (development)

Requirements: Windows, Node.js and npm. `sing-box` is **not** required on `PATH` — the app also finds a vendored copy.

1. Install dependencies:

```powershell
npm install
```

2. Make `sing-box` available (pick one):

```powershell
npm run vendor:singbox   # downloads the official release into vendor/sing-box/
# or
winget install SagerNet.sing-box
```

3. Run the app:

```powershell
npm start
```

On first launch, pick your WireGuard `.conf` file when prompted — the app converts it, restarts once, and connects through the tunnel. That's the whole flow; `npm start` always runs with the tunnel.

## Tunnel Config

- Dev: `./sing-box/config.json` (repo-local, gitignored).
- Installed app: `%APPDATA%\YTM Tunnel Desktop\sing-box\config.json`.

The app generates this file from the `.conf` you pick on first launch. To switch configs or providers, set `YTM_RESET_CONFIG=true` once and launch the app — the first-run picker appears again.

`sing-box` output is logged next to the config in dev, and to `%APPDATA%\YTM Tunnel Desktop\logs\` in the installed app.

### Manual Conversion (optional)

If you prefer the command line, convert a Mullvad/WireGuard `.conf` file yourself:

```powershell
npm run convert:wg -- --input "C:/Users/your-user/Downloads/your-mullvad.conf" --output "./sing-box/config.json"
```

The converter reads `Interface.PrivateKey`, `Interface.Address`, `Peer.PublicKey`, `Peer.Endpoint`, `Peer.AllowedIPs`, plus `Reserved` and `PresharedKey` if present. Useful options: `--listen-host` (default `127.0.0.1`), `--listen-port` (default `1080`), `--mtu` (default `1280`).

## Running

```powershell
npm start              # default: with the managed sing-box tunnel
npm run start:noproxy  # escape hatch: without any tunnel (testing)
```

To verify the tunnel end-to-end (exit IP check via `am.i.mullvad.net`):

```powershell
npm run test:tunnel
```

## Environment Variables

- `YTM_USE_PROXY`
  - `true` or unset: enable the app-local tunnel.
  - `false`: disable the tunnel.
- `YTM_PROXY`
  - Proxy URL used by Electron.
  - Default: `socks5://127.0.0.1:1080`
  - When generating a config (first run or reset), the SOCKS5 listener is created on this port.
- `YTM_RESET_CONFIG`
  - `true`: show the first-run `.conf` picker again and overwrite the existing tunnel config.
- `YTM_MINIMIZE_TO_TRAY`
  - `true`: closing the window hides it to the tray.
  - unset/other: closing behaves normally.
- `YTM_START_HIDDEN`
  - `true`: start hidden and rely on the tray.

## App Controls

- Media keys:
  - Play/Pause
  - Next track
  - Previous track
- `Ctrl+E`: open the equalizer window.
- Tray menu:
  - Show
  - Play/Pause
  - Next
  - Previous
  - Equalizer
  - Quit

Non-YouTube-Music links are opened in the external browser.

## Building the Windows Installer

```powershell
npm run build:win
```

The build downloads the official `sing-box` release into `vendor/sing-box/` (skipped if already present; use `npm run vendor:singbox -- --force` to refresh) and bundles `sing-box.exe` into the installer. The result is fully self-contained: users need only the installer and a WireGuard `.conf` file.

Build artifacts are written to:

```text
dist/
```

The Windows build uses `electron-builder` with an NSIS installer target.

## Troubleshooting

### "Tunnel failed to start" dialog

The dialog shows `sing-box`'s error output. Common causes:

- Another program is already using the SOCKS5 port (default 1080). Close it, or delete the tunnel config, launch with a different `YTM_PROXY` port, and re-run the first-run picker.
- The WireGuard key or endpoint is expired/invalid (e.g. rotated Mullvad keys). Set `YTM_RESET_CONFIG=true`, launch, and pick a fresh `.conf`.
- The config was edited manually and is invalid.

### `YTM_PROXY` port mismatch

If the tunnel config listens on a different port than `YTM_PROXY`, the app refuses to start the tunnel and tells you. Delete the config (or run with `YTM_RESET_CONFIG=true`) to regenerate it for the current port.

### `sing-box not found` (development)

```powershell
npm run vendor:singbox
# or
winget install SagerNet.sing-box
```

The dev app looks for `sing-box.exe` in `vendor/sing-box/`, then on `PATH`, then in the winget package directory.

## Notes

- The tunnel config is a local runtime file and contains secrets — it is never committed or uploaded.
- This project uses the `sing-box` 1.13+ endpoint schema.
- Legacy WireGuard outbound/sniff fields are not used.
- The app is intentionally scoped to YouTube Music and app-local tunneling.
