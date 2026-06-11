# YTM Tunnel Desktop

An Electron-based YouTube Music desktop client with an app-local SOCKS5 tunnel.

YTM Tunnel Desktop is designed for cases where YouTube Music should use a VPN/proxy tunnel, but the rest of Windows should keep using the normal network path. The app applies the proxy only to its own Electron/Chromium process and does not change Windows system proxy settings.

## What It Does

- Opens YouTube Music in a dedicated desktop window.
- Routes only this app through a local SOCKS5 proxy, by default `socks5://127.0.0.1:1080`.
- Uses `sing-box` with a WireGuard endpoint for the tunnel.
- Keeps system-wide Windows traffic untouched.
- Includes tray controls, media key support, and a simple equalizer window.

## Architecture

```text
YTM Tunnel Desktop (Electron)
  -> 127.0.0.1:1080 SOCKS5
  -> sing-box
  -> WireGuard endpoint
```

The Electron app applies the proxy to its own Chromium process with:

```js
app.commandLine.appendSwitch("proxy-server", proxy);
```

No Windows system proxy setting is modified.

## Requirements

- Windows
- Node.js and npm
- `sing-box` installed and available on `PATH`
  - Recommended install command:

```powershell
winget install SagerNet.sing-box
```

- A WireGuard configuration file, for example one exported from Mullvad VPN

## Quick Start

1. Install dependencies:

```powershell
npm install
```

2. Convert a Mullvad/WireGuard `.conf` file into a `sing-box` config:

```powershell
npm run convert:wg -- --input "C:/Users/your-user/Downloads/your-mullvad.conf" --output "./sing-box/config.json"
```

3. Start `sing-box` and the Electron app together:

```powershell
npm run start:with-singbox
```

Keep this terminal window open while using the app. Closing it also stops `sing-box`.

To run the app without the proxy for testing:

```powershell
npm run start:noproxy
```

## WireGuard Configuration

When using Mullvad VPN or another WireGuard provider, the converter reads these values from the `.conf` file:

- `Interface.PrivateKey`
- `Interface.Address`
- `Peer.PublicKey`
- `Peer.Endpoint`
- `Peer.AllowedIPs`
- `Peer.Reserved` or `Interface.Reserved`, if present
- `Peer.PresharedKey`, if present

The generated runtime file is written to:

```text
sing-box/config.json
```

This file contains private key material. Do not commit it to version control.

## Creating `sing-box/config.json`

### Recommended: Automatic Conversion

```powershell
npm run convert:wg -- --input "C:/Users/your-user/Downloads/your-mullvad.conf" --output "./sing-box/config.json"
```

Useful converter options:

- `--listen-host` default: `127.0.0.1`
- `--listen-port` default: `1080`
- `--mtu` default: `1280`

Example with a custom local SOCKS5 port:

```powershell
npm run convert:wg -- --input "C:/Users/your-user/Downloads/your-mullvad.conf" --output "./sing-box/config.json" --listen-port 1081
```

### Manual: Edit the Template

1. Copy the template:

```powershell
Copy-Item ./sing-box/config.template.json ./sing-box/config.json
```

2. Fill in the WireGuard placeholders in `sing-box/config.json`:

- `endpoints[0].peers[0].address` - endpoint host
- `endpoints[0].peers[0].port` - endpoint port
- `endpoints[0].address` - interface address list
- `endpoints[0].private_key`
- `endpoints[0].peers[0].public_key`
- `endpoints[0].peers[0].allowed_ips`
- `endpoints[0].peers[0].reserved`, if your provider requires it

## Running

Run without the proxy:

```powershell
npm run start:noproxy
```

Run with an already-running SOCKS5 proxy:

```powershell
npm run start:proxy
```

Run `sing-box` manually in one terminal, then start the app in another:

```powershell
sing-box run -c ./sing-box/config.json
```

```powershell
npm run start:proxy
```

Run `sing-box` and the app together:

```powershell
npm run start:with-singbox
```

The combined start script checks the `sing-box` config, starts `sing-box`, waits until the SOCKS5 endpoint is reachable, starts the Electron app, and stops `sing-box` when the app exits.

## Environment Variables

- `YTM_USE_PROXY`
  - `true` or unset: enable the app-local proxy.
  - `false`: disable the proxy.
- `YTM_PROXY`
  - Proxy URL used by Electron.
  - Default: `socks5://127.0.0.1:1080`
- `YTM_MINIMIZE_TO_TRAY`
  - `true`: closing the window hides it to the tray.
  - unset/other: closing behaves normally.
- `YTM_START_HIDDEN`
  - `true`: start hidden and rely on the tray.

Example:

```powershell
$env:YTM_PROXY="socks5://127.0.0.1:1081"
npm run start:proxy
```

If you change the `sing-box` `listen_port`, set `YTM_PROXY` to the same host and port.

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

Build artifacts are written to:

```text
dist/
```

The Windows build uses `electron-builder` with an NSIS installer target.

## Troubleshooting

### `sing-box executable not found`

Install `sing-box`:

```powershell
winget install SagerNet.sing-box
```

Or pass the executable path directly to the helper script:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/start-with-singbox.ps1 -SingBoxExe "C:/path/to/sing-box.exe"
```

### `SOCKS5 proxy not reachable`

The app shows a proxy error dialog when proxy mode is enabled but `127.0.0.1:1080` is not reachable.

Check that:

- `sing-box/config.json` exists.
- `sing-box check -c ./sing-box/config.json` succeeds.
- No other process is already using the SOCKS5 port.
- `YTM_PROXY` matches the `sing-box` listen host and port.

### Port `1080` Is Already In Use

Generate a config with another port:

```powershell
npm run convert:wg -- --input "C:/Users/your-user/Downloads/your-mullvad.conf" --output "./sing-box/config.json" --listen-port 1081
```

Then run with the matching proxy:

```powershell
$env:YTM_PROXY="socks5://127.0.0.1:1081"
npm run start:with-singbox
```

## Notes

- `sing-box/config.json` is a local runtime file and may contain secrets.
- This project uses the `sing-box` 1.13+ endpoint schema.
- Legacy WireGuard outbound/sniff fields are not used.
- The app is intentionally scoped to YouTube Music and app-local tunneling.
