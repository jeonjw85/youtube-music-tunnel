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
const path = require("path");

const YTM_URL = "https://music.youtube.com/";
const PROXY = process.env.YTM_PROXY || "socks5://127.0.0.1:1080";
const USE_PROXY = process.env.YTM_USE_PROXY !== "false";
const MINIMIZE_TO_TRAY = process.env.YTM_MINIMIZE_TO_TRAY === "true";
const START_HIDDEN = process.env.YTM_START_HIDDEN === "true";

// Apply proxy only to this Electron/Chromium process.
if (USE_PROXY && PROXY) {
    app.commandLine.appendSwitch("proxy-server", PROXY);
}

let mainWindow = null;
let tray = null;
let eqWindow = null;
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

function relaunchWithoutProxy() {
    // Relaunch with proxy explicitly disabled so command-line proxy switch is not applied.
    const env = {
        ...process.env,
        YTM_USE_PROXY: "false",
    };

    app.relaunch({ env });
    isQuitting = true;
    app.quit();
}

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
                        "Retry",
                        "Restart without proxy (no tunnel)",
                        "Quit",
                    ],
                    defaultId: 0,
                    cancelId: 2,
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
    if (MINIMIZE_TO_TRAY) {
        createTray();
    }
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
