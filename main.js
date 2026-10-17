const {
    app,
    BrowserWindow,
    Menu,
    Tray,
    nativeImage,
    shell,
    globalShortcut,
    dialog,
    ipcMain,
} = require("electron");
const fs = require("fs");
const path = require("path");

const tunnel = require("./singbox");
const settingsStore = require("./settings");

const YTM_URL = "https://music.youtube.com/";
const PROXY = process.env.YTM_PROXY || "socks5://127.0.0.1:1080";
const runtimeSettings = settingsStore.resolveRuntimeSettings();
let USE_PROXY = runtimeSettings.useProxy;
let MINIMIZE_TO_TRAY = runtimeSettings.minimizeToTray;
let START_HIDDEN = runtimeSettings.startHidden;
const RESET_CONFIG =
    process.env.YTM_RESET_CONFIG === "true" ||
    process.env.YTM_RESET_CONFIG === "1";

const ICON_PATH = path.join(__dirname, "assets", "icon.png");

// Resolve the tunnel config up front so the proxy switch decision is made
// synchronously at module load (command-line switches must be appended
// before app "ready"). First-run onboarding happens after "ready".
const CONFIG_PATH = tunnel.resolveConfigPath();
const tunnelConfigured = fs.existsSync(CONFIG_PATH) && !RESET_CONFIG;

// Apply proxy only to this Electron/Chromium process, and only when a
// tunnel config exists (otherwise the app would proxy into nothing).
if (USE_PROXY && tunnelConfigured && PROXY) {
    app.commandLine.appendSwitch("proxy-server", PROXY);
}

let mainWindow = null;
let tray = null;
let eqWindow = null;
let settingsWindow = null;
let isQuitting = false;
let hasShownProxyError = false;
// 10-band
const EQ_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
let eqGains = new Array(EQ_FREQUENCIES.length).fill(0);

function buildEqScript(gains) {
    return `
(() => {
  const freqs = ${JSON.stringify(EQ_FREQUENCIES)};
  const gains = ${JSON.stringify(gains)};

  // Re-use existing context/filters if already injected
  if (window.__ytmEqFilters) {
    window.__ytmEqFilters.forEach((f, i) => { f.gain.value = gains[i]; });
    return;
  }

  const mediaEl = document.querySelector('video') || document.querySelector('audio');
  if (!mediaEl) return;

  const ctx = new AudioContext();
  const source = ctx.createMediaElementSource(mediaEl);

  const filters = freqs.map((freq, i) => {
    const filter = ctx.createBiquadFilter();
    filter.type = i === 0 ? 'lowshelf' : i === freqs.length - 1 ? 'highshelf' : 'peaking';
    filter.frequency.value = freq;
    filter.Q.value = 1.4;
    filter.gain.value = gains[i];
    return filter;
  });

  // Chain filters
  source.connect(filters[0]);
  for (let i = 0; i < filters.length - 1; i++) {
    filters[i].connect(filters[i + 1]);
  }
  filters[filters.length - 1].connect(ctx.destination);

  window.__ytmEqFilters = filters;
})();
`;
}

function applyEqToWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents
        .executeJavaScript(buildEqScript(eqGains), true)
        .catch(() => {});
}

ipcMain.on("eq:set-gains", (_event, gains) => {
    if (!Array.isArray(gains) || gains.length !== EQ_FREQUENCIES.length) return;
    eqGains = gains.map((v) => Math.max(-12, Math.min(12, Number(v) || 0)));
    applyEqToWindow();
});

ipcMain.handle("eq:get-gains", () => eqGains);

ipcMain.handle("settings:get", () => getSettingsView());
ipcMain.handle("settings:set", (_event, patch) => applySettingsPatch(patch));
ipcMain.handle("settings:import-wg", () => importWireGuardFromDialog());

function openEqWindow() {
    if (eqWindow && !eqWindow.isDestroyed()) {
        eqWindow.focus();
        return;
    }

    eqWindow = new BrowserWindow({
        width: 420,
        height: 280,
        resizable: false,
        minimizable: false,
        maximizable: false,
        title: "Equalizer",
        backgroundColor: "#111111",
        parent: mainWindow || undefined,
        webPreferences: {
            preload: path.join(__dirname, "preload-eq.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    eqWindow.removeMenu();
    eqWindow.loadFile("eq.html");
    eqWindow.on("closed", () => {
        eqWindow = null;
    });
}

function openSettingsWindow() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.focus();
        return;
    }

    settingsWindow = new BrowserWindow({
        width: 400,
        height: 420,
        resizable: false,
        minimizable: false,
        maximizable: false,
        title: "Settings",
        backgroundColor: "#111111",
        parent: mainWindow || undefined,
        webPreferences: {
            preload: path.join(__dirname, "preload-settings.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    settingsWindow.removeMenu();
    settingsWindow.loadFile("settings.html");
    settingsWindow.on("closed", () => {
        settingsWindow = null;
    });
}

function relaunchWithoutProxy() {
    // Relaunch with proxy explicitly disabled so command-line proxy switch is not applied.
    process.env.YTM_USE_PROXY = "false";

    app.relaunch();
    isQuitting = true;
    app.quit();
}

function relaunchApplyingSettings() {
    delete process.env.YTM_USE_PROXY;
    delete process.env.YTM_MINIMIZE_TO_TRAY;
    delete process.env.YTM_START_HIDDEN;

    app.relaunch();
    isQuitting = true;
    app.quit();
}

function getSettingsView() {
    const summary = tunnel.readTunnelSummary(CONFIG_PATH);
    const proxyTarget = tunnel.parseProxyUrl(PROXY);
    const listenPort = summary.listenPort || proxyTarget.port;

    return {
        useProxy: USE_PROXY,
        minimizeToTray: MINIMIZE_TO_TRAY,
        startHidden: START_HIDDEN,
        configured: summary.configured,
        endpoint: summary.endpoint,
        listen: `${summary.listenHost || proxyTarget.host}:${listenPort}`,
    };
}

function applySettingsPatch(patch) {
    if (!patch || typeof patch !== "object") {
        return getSettingsView();
    }

    const saved = settingsStore.saveSettings(patch);

    if (typeof patch.minimizeToTray === "boolean") {
        MINIMIZE_TO_TRAY = saved.minimizeToTray;
        if (!tray) {
            createTray();
        }
    }

    if (typeof patch.startHidden === "boolean") {
        START_HIDDEN = saved.startHidden;
    }

    if (typeof patch.useProxy === "boolean" && saved.useProxy !== USE_PROXY) {
        relaunchApplyingSettings();
        return {
            ...getSettingsView(),
            useProxy: saved.useProxy,
            relaunching: true,
        };
    }

    return getSettingsView();
}

async function importWireGuardFromDialog() {
    const parent =
        settingsWindow && !settingsWindow.isDestroyed()
            ? settingsWindow
            : mainWindow;

    const openOpts = {
        title: "Select WireGuard configuration",
        properties: ["openFile"],
        filters: [
            { name: "WireGuard config", extensions: ["conf"] },
            { name: "All files", extensions: ["*"] },
        ],
    };
    const picked = parent
        ? await dialog.showOpenDialog(parent, openOpts)
        : await dialog.showOpenDialog(openOpts);

    if (picked.canceled || picked.filePaths.length === 0) {
        return { canceled: true };
    }

    const confPath = picked.filePaths[0];
    const proxyTarget = tunnel.parseProxyUrl(PROXY);

    try {
        tunnel.convertWgFile(confPath, CONFIG_PATH, {
            listenHost: proxyTarget.host,
            listenPort: proxyTarget.port,
        });
    } catch (error) {
        await dialog.showMessageBox({
            type: "error",
            title: "Conversion failed",
            message: `Could not convert ${path.basename(confPath)}`,
            detail: error.message,
            buttons: ["OK"],
        });
        return { ok: false, error: error.message };
    }

    if (USE_PROXY && tunnelConfigured) {
        tunnel.stopTunnel();
        const exePath = tunnel.resolveSingBoxExe();
        if (exePath) {
            try {
                await tunnel.startTunnel({
                    configPath: CONFIG_PATH,
                    exePath,
                    proxyUrl: PROXY,
                });
            } catch (error) {
                await dialog.showMessageBox({
                    type: "error",
                    title: "Tunnel failed to start",
                    message: "sing-box could not start the tunnel",
                    detail: error.message,
                    buttons: ["OK"],
                });
                return { ok: false, error: error.message };
            }
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.reload();
        }
        return getSettingsView();
    }

    if (USE_PROXY) {
        relaunchApplyingSettings();
        return { ...getSettingsView(), relaunching: true };
    }

    return getSettingsView();
}

/**
 * First-run onboarding: no tunnel config exists yet. Ask the user to pick a
 * WireGuard .conf file and convert it into the sing-box runtime config.
 * Returns "relaunch" (config written; restart to apply the proxy switch),
 * "noproxy" (user opted out), or "quit".
 */
async function runConfigOnboarding() {
    const proxyTarget = tunnel.parseProxyUrl(PROXY);

    for (;;) {
        const { response } = await dialog.showMessageBox({
            type: "info",
            title: "Tunnel setup",
            message: "No tunnel configuration found",
            detail:
                "This app routes YouTube Music through an app-local WireGuard tunnel (sing-box).\n\n" +
                "Select a WireGuard .conf file (for example one exported from Mullvad) and the app " +
                "converts it automatically. The file is only read locally; your private key stays on this machine.\n\n" +
                `The generated config will listen on ${proxyTarget.host}:${proxyTarget.port}.`,
            buttons: [
                "Select WireGuard .conf…",
                "Continue without tunnel",
                "Quit",
            ],
            defaultId: 0,
            cancelId: 2,
        });

        if (response === 1) {
            return "noproxy";
        }

        if (response === 2) {
            return "quit";
        }

        const picked = await dialog.showOpenDialog({
            title: "Select WireGuard configuration",
            properties: ["openFile"],
            filters: [
                { name: "WireGuard config", extensions: ["conf"] },
                { name: "All files", extensions: ["*"] },
            ],
        });

        if (picked.canceled || picked.filePaths.length === 0) {
            continue;
        }

        const confPath = picked.filePaths[0];

        try {
            tunnel.convertWgFile(confPath, CONFIG_PATH, {
                listenHost: proxyTarget.host,
                listenPort: proxyTarget.port,
            });
            return "relaunch";
        } catch (error) {
            await dialog.showMessageBox({
                type: "error",
                title: "Conversion failed",
                message: `Could not convert ${path.basename(confPath)}`,
                detail: `${error.message}\n\nPick another file, continue without the tunnel, or quit.`,
                buttons: ["OK"],
            });
        }
    }
}

/**
 * Start the managed sing-box tunnel, surfacing failures in dialogs.
 * Returns "ok", "noproxy" (relaunch needed — proxy switch is already
 * applied), or "quit".
 */
async function startTunnelWithDialogs() {
    for (;;) {
        const exePath = tunnel.resolveSingBoxExe();

        if (!exePath) {
            const { response } = await dialog.showMessageBox({
                type: "error",
                title: "sing-box not found",
                message: "Could not find the sing-box executable",
                detail: app.isPackaged
                    ? "This app should bundle sing-box.exe, but it is missing.\nPlease reinstall the app."
                    : "Install sing-box with one of:\n\n" +
                      "  winget install SagerNet.sing-box\n" +
                      "  npm run vendor:singbox\n\n" +
                      "Then restart the app.",
                buttons: ["Continue without tunnel", "Quit"],
                defaultId: 0,
                cancelId: 1,
            });

            return response === 1 ? "quit" : "noproxy";
        }

        try {
            await tunnel.startTunnel({
                configPath: CONFIG_PATH,
                exePath,
                proxyUrl: PROXY,
            });
            return "ok";
        } catch (error) {
            const { response } = await dialog.showMessageBox({
                type: "error",
                title: "Tunnel failed to start",
                message: "sing-box could not start the tunnel",
                detail:
                    `${error.message}\n\n` +
                    `Tunnel config: ${CONFIG_PATH}\n\n` +
                    "Check that the WireGuard key/endpoint is still valid and that no other program is using the SOCKS5 port.",
                buttons: ["Retry", "Continue without tunnel", "Quit"],
                defaultId: 0,
                cancelId: 2,
            });

            if (response === 0) {
                continue;
            }

            return response === 2 ? "quit" : "noproxy";
        }
    }
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
}

function isAllowedNavigation(urlString) {
    try {
        const { hostname, protocol } = new URL(urlString);
        return (
            protocol === "https:" &&
            (hostname === "music.youtube.com" ||
                hostname.endsWith(".youtube.com") ||
                hostname.endsWith(".google.com") ||
                hostname.endsWith(".gstatic.com"))
        );
    } catch {
        return false;
    }
}

function openExternalLink(urlString) {
    try {
        const { protocol } = new URL(urlString);
        if (protocol !== "https:" && protocol !== "http:") return;
    } catch {
        return;
    }

    shell.openExternal(urlString);
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 840,
        minWidth: 960,
        minHeight: 640,
        show: !START_HIDDEN,
        autoHideMenuBar: true,
        title: "YouTube Music",
        icon: ICON_PATH,
        backgroundColor: "#111111",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
        },
    });

    // Keep UI native and clean for a dedicated app feel.
    mainWindow.removeMenu();

    // Open non-YouTube-Music links in external browser.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (isAllowedNavigation(url)) {
            return { action: "allow" };
        }

        openExternalLink(url);
        return { action: "deny" };
    });

    const handleNavigation = (event, url) => {
        if (!event.isMainFrame) return;

        if (!isAllowedNavigation(url)) {
            event.preventDefault();
            openExternalLink(url);
        }
    };
    mainWindow.webContents.on("will-navigate", handleNavigation);
    mainWindow.webContents.on("will-redirect", handleNavigation);

    mainWindow.loadURL(YTM_URL);

    mainWindow.webContents.on("did-finish-load", () => {
        if (eqGains.some((g) => g !== 0)) {
            setTimeout(applyEqToWindow, 1500);
        }
    });

    // Give a clear, actionable message when the local SOCKS5 endpoint is down.
    mainWindow.webContents.on(
        "did-fail-load",
        (_event, errorCode, errorDescription, _url, isMainFrame) => {
            if (!isMainFrame) {
                return;
            }

            const proxyConnectionFailed =
                errorCode === -130 ||
                String(errorDescription).includes(
                    "ERR_PROXY_CONNECTION_FAILED",
                );

            if (!USE_PROXY || !proxyConnectionFailed || hasShownProxyError) {
                return;
            }

            hasShownProxyError = true;

            dialog
                .showMessageBox({
                    type: "error",
                    buttons: [
                        "Retry (restart tunnel)",
                        "Restart without proxy (no tunnel)",
                        "Quit",
                    ],
                    defaultId: 0,
                    cancelId: 2,
                    title: "SOCKS5 proxy not reachable",
                    message: `Cannot connect to ${PROXY}`,
                    detail:
                        "This app manages its own sing-box tunnel. The tunnel may have crashed, " +
                        "or the WireGuard key/endpoint in the config may no longer be valid.\n\n" +
                        `Tunnel config: ${CONFIG_PATH}\n\n` +
                        "Retry restarts the tunnel and reloads the page.",
                })
                .then(async ({ response }) => {
                    if (!mainWindow || mainWindow.isDestroyed()) {
                        return;
                    }

                    if (response === 0) {
                        hasShownProxyError = false;

                        // The tunnel may have died; restart it before reloading.
                        tunnel.stopTunnel();
                        const exePath = tunnel.resolveSingBoxExe();
                        if (exePath) {
                            try {
                                await tunnel.startTunnel({
                                    configPath: CONFIG_PATH,
                                    exePath,
                                    proxyUrl: PROXY,
                                });
                            } catch {
                                // Still reload; if the proxy is still down the
                                // error dialog will appear again.
                            }
                        }

                        if (!mainWindow.isDestroyed()) {
                            mainWindow.reload();
                        }
                        return;
                    }

                    if (response === 1) {
                        relaunchWithoutProxy();
                        return;
                    }

                    isQuitting = true;
                    app.quit();
                });
        },
    );

    // Hide to tray instead of fully closing.
    mainWindow.on("close", (event) => {
        if (!isQuitting && MINIMIZE_TO_TRAY) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    mainWindow.on("minimize", (event) => {
        if (MINIMIZE_TO_TRAY) {
            event.preventDefault();
            mainWindow.hide();
        }
    });
}

function getTrayIcon() {
    const bundled = nativeImage.createFromPath(ICON_PATH);
    if (!bundled.isEmpty()) {
        return bundled.resize({ width: 16, height: 16 });
    }

    const exeIcon = nativeImage.createFromPath(process.execPath);
    if (!exeIcon.isEmpty()) {
        return exeIcon.resize({ width: 16, height: 16 });
    }

    const fallbackSvg =
        "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'><rect x='4' y='4' width='56' height='56' rx='14' fill='%231d4ed8'/><polygon points='26,20 26,44 46,32' fill='white'/></svg>";
    return nativeImage
        .createFromDataURL(
            `data:image/svg+xml;charset=utf-8,${encodeURIComponent(fallbackSvg)}`,
        )
        .resize({ width: 16, height: 16 });
}

function showMainWindow() {
    if (!mainWindow) {
        return;
    }

    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }

    mainWindow.show();
    mainWindow.focus();
}

function executePlayerAction(script) {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    mainWindow.webContents.executeJavaScript(script, true).catch(() => {
        // Ignore page-level action errors.
    });
}

function registerMediaKeys() {
    // Best-effort global media key support for Play/Pause/Next/Previous.
    const shortcuts = [
        {
            accelerator: "MediaPlayPause",
            script: `
        (() => {
          const btn = document.querySelector('button.play-pause-button, tp-yt-paper-icon-button.play-pause-button');
          if (btn) btn.click();
        })();
      `,
        },
        {
            accelerator: "MediaNextTrack",
            script: `
        (() => {
          const btn = document.querySelector('button.next-button, tp-yt-paper-icon-button.next-button');
          if (btn) btn.click();
        })();
      `,
        },
        {
            accelerator: "MediaPreviousTrack",
            script: `
        (() => {
          const btn = document.querySelector('button.previous-button, tp-yt-paper-icon-button.previous-button');
          if (btn) btn.click();
        })();
      `,
        },
    ];

    for (const shortcut of shortcuts) {
        globalShortcut.register(shortcut.accelerator, () => {
            executePlayerAction(shortcut.script);
        });
    }

    // Open EQ window with Ctrl+E
    globalShortcut.register("CommandOrControl+E", openEqWindow);
    globalShortcut.register("CommandOrControl+,", openSettingsWindow);
}

function createTray() {
    tray = new Tray(getTrayIcon());
    tray.setToolTip("YTM Tunnel Desktop");

    const contextMenu = Menu.buildFromTemplate([
        {
            label: "Show",
            click: showMainWindow,
        },
        {
            label: "Play/Pause",
            click: () => {
                executePlayerAction(`
          (() => {
            const btn = document.querySelector('button.play-pause-button, tp-yt-paper-icon-button.play-pause-button');
            if (btn) btn.click();
          })();
        `);
            },
        },
        {
            label: "Next",
            click: () => {
                executePlayerAction(`
          (() => {
            const btn = document.querySelector('button.next-button, tp-yt-paper-icon-button.next-button');
            if (btn) btn.click();
          })();
        `);
            },
        },
        {
            label: "Previous",
            click: () => {
                executePlayerAction(`
          (() => {
            const btn = document.querySelector('button.previous-button, tp-yt-paper-icon-button.previous-button');
            if (btn) btn.click();
          })();
        `);
            },
        },
        {
            type: "separator",
        },
        {
            label: "Equalizer",
            click: openEqWindow,
        },
        {
            label: "Settings",
            click: openSettingsWindow,
        },
        {
            type: "separator",
        },
        {
            label: "Quit",
            click: () => {
                isQuitting = true;
                app.quit();
            },
        },
    ]);

    tray.setContextMenu(contextMenu);
    tray.on("double-click", showMainWindow);
}

app.on("second-instance", () => {
    showMainWindow();
});

app.whenReady().then(async () => {
    // Remove the default app menu globally.
    Menu.setApplicationMenu(null);

    // Tunnel lifecycle: on first run convert a picked .conf, otherwise start
    // sing-box and wait for the SOCKS5 endpoint before opening the window.
    if (USE_PROXY) {
        if (!tunnelConfigured) {
            const outcome = await runConfigOnboarding();

            if (outcome === "quit") {
                app.exit(0);
                return;
            }

            if (outcome === "relaunch") {
                // Restart so the proxy switch is applied with the new config.
                app.relaunch();
                app.exit(0);
                return;
            }

            // "noproxy": the proxy switch was never applied; continue below.
        } else {
            const outcome = await startTunnelWithDialogs();

            if (outcome === "quit") {
                app.exit(0);
                return;
            }

            if (outcome === "noproxy") {
                // The proxy switch is already applied, so a relaunch with
                // YTM_USE_PROXY=false is required to drop it.
                relaunchWithoutProxy();
                return;
            }

            // "ok": tunnel is up; continue below.
        }
    }

    createMainWindow();
    createTray();
    registerMediaKeys();

    if (START_HIDDEN && mainWindow) {
        mainWindow.hide();
    }
});

app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
        createMainWindow();
    } else {
        showMainWindow();
    }
});

app.on("before-quit", () => {
    isQuitting = true;
    globalShortcut.unregisterAll();
    tunnel.stopTunnel();
});

// Cover Ctrl+C in dev and any other abrupt exit paths: never leave
// sing-box running after the app goes away.
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
        tunnel.stopTunnel();
        process.exit(0);
    });
}

process.on("exit", () => {
    tunnel.stopTunnel();
});
