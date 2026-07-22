// Main-process tunnel manager: resolves sing-box and its config, starts
// `sing-box run` as a child process, waits for the local SOCKS5 endpoint
// to accept connections, and stops it when the app quits.
//
// Used by main.js so that `npm start` and the installed .exe behave
// identically — no external launcher script required.

const { app } = require("electron");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { execSync, spawn } = require("child_process");

const { parseWireGuardConfig, toSingBoxConfig } = require("./wg-convert");

// Matches the NSIS productName; used to compute the userData path before
// app "ready" (app.getPath("userData") throws pre-ready).
const PRODUCT_NAME_FALLBACK = "YTM Tunnel Desktop";

const EXE_NAME = process.platform === "win32" ? "sing-box.exe" : "sing-box";

let tunnelProcess = null;
let tunnelStopped = false;
let stdoutLogPath = null;
let stderrLogPath = null;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Location of the sing-box runtime config.
 * - Packaged: %APPDATA%\<productName>\sing-box\config.json (persists across
 *   updates; computed manually because userData is unavailable pre-ready).
 * - Dev: ./sing-box/config.json (repo-local, gitignored).
 * Safe to call at module load.
 */
function resolveConfigPath() {
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
        return path.join(appData, name, "sing-box", "config.json");
    }

    return path.join(__dirname, "sing-box", "config.json");
}

/**
 * Directory for sing-box stdout/stderr logs. Call after app "ready".
 */
function resolveLogDir() {
    if (app.isPackaged) {
        return path.join(app.getPath("userData"), "logs");
    }
    return path.join(__dirname, "sing-box");
}

function findFileRecursive(rootDir, fileName) {
    const stack = [rootDir];
    const target = fileName.toLowerCase();

    while (stack.length > 0) {
        const dir = stack.pop();

        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            } else if (entry.name.toLowerCase() === target) {
                return full;
            }
        }
    }

    return null;
}

/**
 * Find a usable sing-box executable.
 * - Packaged: bundled via electron-builder extraResources.
 * - Dev: ./vendor/sing-box/ -> PATH -> winget install location.
 * Returns null when nothing is found. Safe to call at module load.
 */
function resolveSingBoxExe() {
    if (app.isPackaged) {
        const bundled = path.join(process.resourcesPath, "sing-box", EXE_NAME);
        return fs.existsSync(bundled) ? bundled : null;
    }

    const vendored = path.join(__dirname, "vendor", "sing-box", EXE_NAME);
    if (fs.existsSync(vendored)) {
        return vendored;
    }

    if (process.platform === "win32") {
        try {
            const out = execSync(`where ${EXE_NAME}`, {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            });
            const first = out.split(/\r?\n/)[0].trim();
            if (first && fs.existsSync(first)) {
                return first;
            }
        } catch {
            // Not on PATH; fall through.
        }

        const wingetRoot = path.join(
            os.homedir(),
            "AppData",
            "Local",
            "Microsoft",
            "WinGet",
            "Packages",
        );

        if (fs.existsSync(wingetRoot)) {
            const packageDirs = fs
                .readdirSync(wingetRoot)
                .filter((name) => name.startsWith("SagerNet.sing-box_"))
                .sort()
                .reverse();

            for (const dir of packageDirs) {
                const found = findFileRecursive(
                    path.join(wingetRoot, dir),
                    EXE_NAME,
                );
                if (found) {
                    return found;
                }
            }
        }
    }

    return null;
}

// ---------------------------------------------------------------------------
// Proxy URL helpers
// ---------------------------------------------------------------------------

/** Parse "socks5://host:port" into { host, port } with sane defaults. */
function parseProxyUrl(proxyUrl) {
    try {
        const url = new URL(proxyUrl);
        const port = url.port ? Number(url.port) : 1080;
        return { host: url.hostname || "127.0.0.1", port };
    } catch {
        return { host: "127.0.0.1", port: 1080 };
    }
}

/** Read the SOCKS5 inbound port from an existing sing-box config. */
function readConfigListenPort(configPath) {
    try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        const inbound = (config.inbounds || []).find(
            (entry) => entry && entry.type === "socks",
        );
        return inbound ? Number(inbound.listen_port) : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Config conversion (first-run onboarding)
// ---------------------------------------------------------------------------

/**
 * Convert a WireGuard .conf file into a sing-box config written to outputPath.
 * Throws on parse/conversion errors; does not write partial output.
 */
function convertWgFile(confPath, outputPath, opts) {
    const listenHost = (opts && opts.listenHost) || "127.0.0.1";
    const listenPort = (opts && opts.listenPort) || 1080;
    const mtu = (opts && opts.mtu) || 1280;

    const text = fs.readFileSync(confPath, "utf8");
    const config = toSingBoxConfig(parseWireGuardConfig(text), {
        listenHost,
        listenPort,
        mtu,
    });

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Tunnel lifecycle
// ---------------------------------------------------------------------------

/**
 * Resolve when host:port accepts a TCP connection; reject if the child
 * process exits first or the timeout elapses. A single promise avoids
 * dangling/unhandled rejections from racing two independent promises.
 */
function waitForPortOrExit(child, host, port, timeoutMs, stderrLogPath) {
    const deadline = Date.now() + timeoutMs;

    return new Promise((resolve, reject) => {
        let settled = false;

        const settle = (fn, value) => {
            if (settled) {
                return;
            }
            settled = true;
            child.removeListener("exit", onExit);
            fn(value);
        };

        const onExit = (code, signal) => {
            const detail = scrubSecrets(readLogTail(stderrLogPath, 2000));
            const suffix = signal ? `, signal ${signal}` : "";
            settle(
                reject,
                new Error(
                    `sing-box exited early (code ${code}${suffix}).\n${detail}`.trim(),
                ),
            );
        };

        child.once("exit", onExit);

        const attempt = () => {
            if (settled) {
                return;
            }

            const socket = net.connect({ host, port });
            socket.setTimeout(500);

            socket.once("connect", () => {
                socket.destroy();
                settle(resolve);
            });

            const retry = () => {
                socket.destroy();
                if (settled) {
                    return;
                }
                if (Date.now() >= deadline) {
                    settle(
                        reject,
                        new Error(
                            `SOCKS5 endpoint ${host}:${port} did not become ready within ${Math.round(timeoutMs / 1000)} seconds`,
                        ),
                    );
                    return;
                }
                setTimeout(attempt, 300);
            };

            socket.once("timeout", retry);
            socket.once("error", retry);
        };

        attempt();
    });
}

function readLogTail(logPath, maxChars) {
    try {
        const text = fs.readFileSync(logPath, "utf8");
        if (text.length <= maxChars) {
            return text;
        }
        return "...(truncated)...\n" + text.slice(text.length - maxChars);
    } catch {
        return "";
    }
}

/** Strip private key material before showing log text in dialogs. */
function scrubSecrets(text) {
    return text.replace(
        /"(private_key|pre_shared_key)"\s*:\s*"[^"]*"/gi,
        '"$1": "***"',
    );
}

/**
 * Start sing-box and wait until the SOCKS5 endpoint accepts connections.
 * Resolves when the tunnel is usable; rejects with an Error whose message
 * is safe to show to the user (log tails are scrubbed of key material).
 * Idempotent: returns immediately if a tunnel is already running.
 */
async function startTunnel({ configPath, exePath, proxyUrl, timeoutMs }) {
    const isRunning =
        tunnelProcess && !tunnelStopped && !tunnelExited(tunnelProcess);
    if (isRunning) {
        return;
    }

    const { host, port } = parseProxyUrl(proxyUrl);

    const configPort = readConfigListenPort(configPath);
    if (configPort && configPort !== port) {
        throw new Error(
            `Tunnel config listens on port ${configPort}, but the app proxy is ${proxyUrl}. ` +
                "Delete the config file and restart the app to regenerate it, or unset YTM_PROXY.",
        );
    }

    const waitMs = timeoutMs || 15000;

    const logDir = resolveLogDir();
    fs.mkdirSync(logDir, { recursive: true });
    stdoutLogPath = path.join(logDir, "sing-box-stdout.log");
    stderrLogPath = path.join(logDir, "sing-box-stderr.log");

    const outFd = fs.openSync(stdoutLogPath, "w");
    const errFd = fs.openSync(stderrLogPath, "w");

    let child;
    try {
        child = spawn(exePath, ["run", "-c", configPath], {
            stdio: ["ignore", outFd, errFd],
            windowsHide: true,
        });
    } finally {
        fs.closeSync(outFd);
        fs.closeSync(errFd);
    }

    tunnelProcess = child;
    tunnelStopped = false;

    try {
        await waitForPortOrExit(child, host, port, waitMs, stderrLogPath);
    } catch (error) {
        stopTunnel();
        throw error;
    }
}

function tunnelExited(child) {
    return child.exitCode !== null || child.signalCode !== null;
}

/** Kill the sing-box process tree. Idempotent. Synchronous. */
function stopTunnel() {
    const child = tunnelProcess;
    if (!child || tunnelStopped) {
        return;
    }

    tunnelStopped = true;

    if (tunnelExited(child)) {
        return;
    }

    if (process.platform === "win32") {
        try {
            execSync(`taskkill /T /F /PID ${child.pid}`, {
                stdio: ["ignore", "ignore", "ignore"],
            });
            return;
        } catch {
            // Fall through to child.kill().
        }
    }

    try {
        child.kill("SIGKILL");
    } catch {
        // Already dead.
    }
}

module.exports = {
    resolveConfigPath,
    resolveLogDir,
    resolveSingBoxExe,
    parseProxyUrl,
    convertWgFile,
    startTunnel,
    stopTunnel,
    scrubSecrets,
};
