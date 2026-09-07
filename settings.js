// App settings (not the sing-box tunnel config). Persisted as JSON so the
// Settings window can change behavior without environment variables.
// Env vars still override when explicitly set (e.g. `npm run start:noproxy`).

const { app } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PRODUCT_NAME_FALLBACK = "YTM Tunnel Desktop";

const DEFAULTS = {
    useProxy: true,
    minimizeToTray: false,
    startHidden: false,
};

function resolveSettingsPath() {
    if (app.isPackaged) {
        let name = PRODUCT_NAME_FALLBACK;
        try {
            name = app.getName() || PRODUCT_NAME_FALLBACK;
        } catch {
            // Keep the fallback.
        }

        const appData =
            process.env.APPDATA ||
            path.join(os.homedir(), "AppData", "Roaming");
        return path.join(appData, name, "settings.json");
    }

    return path.join(__dirname, "settings.json");
}

function loadSettings() {
    try {
        const parsed = JSON.parse(
            fs.readFileSync(resolveSettingsPath(), "utf8"),
        );
        return {
            useProxy: parsed.useProxy !== false,
            minimizeToTray: parsed.minimizeToTray === true,
            startHidden: parsed.startHidden === true,
        };
    } catch {
        return { ...DEFAULTS };
    }
}

function saveSettings(partial) {
    const current = loadSettings();
    const next = {
        useProxy:
            typeof partial.useProxy === "boolean"
                ? partial.useProxy
                : current.useProxy,
        minimizeToTray:
            typeof partial.minimizeToTray === "boolean"
                ? partial.minimizeToTray
                : current.minimizeToTray,
        startHidden:
            typeof partial.startHidden === "boolean"
                ? partial.startHidden
                : current.startHidden,
    };

    const filePath = resolveSettingsPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2) + "\n", "utf8");
    return next;
}

function resolveRuntimeSettings() {
    const stored = loadSettings();
    const useProxyEnv = process.env.YTM_USE_PROXY;
    const minimizeEnv = process.env.YTM_MINIMIZE_TO_TRAY;
    const hiddenEnv = process.env.YTM_START_HIDDEN;

    return {
        useProxy:
            useProxyEnv === undefined
                ? stored.useProxy
                : useProxyEnv !== "false",
        minimizeToTray:
            minimizeEnv === undefined
                ? stored.minimizeToTray
                : minimizeEnv === "true",
        startHidden:
            hiddenEnv === undefined
                ? stored.startHidden
                : hiddenEnv === "true",
    };
}

module.exports = {
    loadSettings,
    saveSettings,
    resolveRuntimeSettings,
    resolveSettingsPath,
};
