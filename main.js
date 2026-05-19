const {
    app,
    BrowserWindow,
    Menu,
    Tray,
    nativeImage,
    shell,
    globalShortcut,
    dialog,
} = require("electron");
const path = require("path");

const YTM_URL = "https://music.youtube.com/";
const PROXY = process.env.YTM_PROXY || "socks5://127.0.0.1:1080";
const USE_PROXY = process.env.YTM_USE_PROXY !== "false";
const MINIMIZE_TO_TRAY = process.env.YTM_MINIMIZE_TO_TRAY !== "false";
const START_HIDDEN = process.env.YTM_START_HIDDEN === "true";

// Apply proxy only to this Electron/Chromium process.
if (USE_PROXY && PROXY) {
    app.commandLine.appendSwitch("proxy-server", PROXY);
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let hasShownProxyError = false;

if (!app.requestSingleInstanceLock()) {
    app.quit();
}

function isAllowedNavigation(urlString) {
    try {
        const { hostname } = new URL(urlString);
        return (
            hostname === "music.youtube.com" ||
            hostname.endsWith(".youtube.com") ||
            hostname.endsWith(".google.com") ||
            hostname.endsWith(".gstatic.com")
        );
    } catch {
        return false;
    }
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

        shell.openExternal(url);
        return { action: "deny" };
    });

    mainWindow.webContents.on("will-navigate", (event, url) => {
        if (!isAllowedNavigation(url)) {
            event.preventDefault();
            shell.openExternal(url);
        }
    });

    mainWindow.loadURL(YTM_URL);

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
                    buttons: ["Retry", "Quit"],
                    defaultId: 0,
                    cancelId: 1,
                    title: "SOCKS5 proxy not reachable",
                    message: `Cannot connect to ${PROXY}`,
                    detail:
                        "This app uses an app-local proxy only. Start sing-box (or another SOCKS5 server) first, then retry.\n\n" +
                        "Example: sing-box run -c ./sing-box/config.json",
                })
                .then(({ response }) => {
                    if (!mainWindow || mainWindow.isDestroyed()) {
                        return;
                    }

                    if (response === 0) {
                        hasShownProxyError = false;
                        mainWindow.reload();
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
    // Minimal built-in icon fallback for first run; replace with your own .ico for production branding.
    const fallbackPng =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2p6YcAAAAASUVORK5CYII=";
    const icon = nativeImage
        .createFromDataURL(fallbackPng)
        .resize({ width: 16, height: 16 });
    return icon;
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

app.whenReady().then(() => {
    // Remove the default app menu globally.
    Menu.setApplicationMenu(null);

    createMainWindow();
    createTray();
    registerMediaKeys();

    if (START_HIDDEN && MINIMIZE_TO_TRAY && mainWindow) {
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
});
