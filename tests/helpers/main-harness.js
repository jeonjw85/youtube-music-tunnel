const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

function loadMain({ env = {}, useProxy = true, tunnelAvailable = false } = {}) {
    const root = path.join(__dirname, "..", "..");
    const handlers = new Map();
    const relaunches = [];
    const windows = [];
    const externalUrls = [];
    const processStub = new EventEmitter();
    processStub.env = { ...env };
    const app = new EventEmitter();
    let quitCount = 0;
    let resolveReady;
    let startup;
    const ready = new Promise((resolve) => {
        resolveReady = resolve;
    });
    app.commandLine = { appendSwitch() {} };
    app.requestSingleInstanceLock = () => true;
    app.whenReady = () => ({
        then(callback) {
            startup = ready.then(callback);
            return startup;
        },
    });
    app.relaunch = (options) => {
        relaunches.push({ options, env: { ...processStub.env } });
    };
    app.quit = () => {
        quitCount += 1;
    };

    class BrowserWindow extends EventEmitter {
        constructor() {
            super();
            this.webContents = new EventEmitter();
            this.webContents.setWindowOpenHandler = (handler) => {
                this.windowOpenHandler = handler;
            };
            windows.push(this);
        }

        removeMenu() {}
        loadURL() {}
    }

    class Tray extends EventEmitter {
        setToolTip() {}
        setContextMenu() {}
    }

    const tunnel = {
        resolveConfigPath: () => "test-config.json",
        resolveSingBoxExe: () => "test-sing-box",
        startTunnel: async () => {
            if (!tunnelAvailable) throw new Error("Tunnel unavailable");
        },
        readTunnelSummary: () => ({ configured: true }),
        parseProxyUrl: () => ({ host: "127.0.0.1", port: 1080 }),
    };
    let settings = { useProxy, minimizeToTray: false, startHidden: false };
    const electron = {
        app,
        BrowserWindow,
        Tray,
        nativeImage: {
            createFromPath: () => ({ isEmpty: () => false, resize: () => ({}) }),
        },
        globalShortcut: { register() {} },
        shell: {
            async openExternal(url) {
                externalUrls.push(url);
            },
        },
        ipcMain: {
            on() {},
            handle(channel, handler) {
                handlers.set(channel, handler);
            },
        },
        Menu: { setApplicationMenu() {}, buildFromTemplate: (items) => items },
        dialog: { showMessageBox: async () => ({ response: 1 }) },
    };
    const dependencies = {
        electron,
        fs: { existsSync: () => true },
        "./singbox": tunnel,
        "./settings": {
            resolveRuntimeSettings: () => settings,
            saveSettings(patch) {
                settings = { ...settings, ...patch };
                return settings;
            },
        },
    };
    vm.runInNewContext(fs.readFileSync(path.join(root, "main.js"), "utf8"), {
        require: (id) => dependencies[id] || require(id),
        __dirname: root,
        process: processStub,
        URL,
    }, { filename: "main.js" });

    return {
        handlers,
        relaunches,
        windows,
        externalUrls,
        get quitCount() {
            return quitCount;
        },
        start() {
            resolveReady();
            return startup;
        },
    };
}

module.exports = { loadMain };
