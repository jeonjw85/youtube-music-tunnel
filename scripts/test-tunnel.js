#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const net = require("net");
const tls = require("tls");
const path = require("path");
const { spawn } = require("child_process");

function parseArgs(argv) {
    const args = {
        singBox: process.env.SING_BOX_EXE || "sing-box",
        config: "./sing-box/config.json",
        checkHost: "am.i.mullvad.net",
        checkPath: "/json",
        startupTimeoutMs: 15000,
        requestTimeoutMs: 15000,
        keepRunning: false,
        help: false,
    };

    for (let i = 2; i < argv.length; i += 1) {
        const token = argv[i];
        const next = () => argv[(i += 1)] || "";

        if (token === "--help" || token === "-h") args.help = true;
        else if (token.startsWith("--sing-box="))
            args.singBox = token.slice("--sing-box=".length);
        else if (token === "--sing-box") args.singBox = next();
        else if (token.startsWith("--config="))
            args.config = token.slice("--config=".length);
        else if (token === "--config") args.config = next();
        else if (token.startsWith("--check-host="))
            args.checkHost = token.slice("--check-host=".length);
        else if (token === "--check-host") args.checkHost = next();
        else if (token.startsWith("--timeout="))
            args.startupTimeoutMs =
                Number(token.slice("--timeout=".length)) * 1000;
        else if (token === "--keep-running") args.keepRunning = true;
    }

    return args;
}

function printHelp() {
    process.stdout.write(
        [
            "Usage: node scripts/test-tunnel.js [options]",
            "",
            "  --sing-box <path>    sing-box executable (default: SING_BOX_EXE env or 'sing-box')",
            "  --config <path>      sing-box config (default: ./sing-box/config.json)",
            "  --check-host <host>  IP-echo host reached through the tunnel (default: am.i.mullvad.net)",
            "  --timeout <seconds>  proxy startup timeout (default: 15)",
            "  --keep-running       leave sing-box running after the check",
            "  -h, --help           show this help",
            "",
        ].join("\n"),
    );
}

function readSocksInbound(configPath) {
    const raw = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(raw);
    const inbounds = Array.isArray(config.inbounds) ? config.inbounds : [];
    const socks = inbounds.find((entry) => entry && entry.type === "socks");

    if (!socks) {
        throw new Error(`No socks inbound found in ${configPath}`);
    }

    return {
        host: socks.listen || "127.0.0.1",
        port: socks.listen_port || 1080,
    };
}

function resolveSingBox(candidate) {
    if (
        candidate.includes(path.sep) ||
        candidate.toLowerCase().endsWith(".exe")
    ) {
        if (fs.existsSync(candidate)) return path.resolve(candidate);
    }

    // Prefer the repo-vendored binary (npm run vendor:singbox), matching
    // the dev lookup order in singbox.js.
    const vendored = path.join(
        __dirname,
        "..",
        "vendor",
        "sing-box",
        process.platform === "win32" ? "sing-box.exe" : "sing-box",
    );
    if (fs.existsSync(vendored)) return vendored;

    const wingetRoot = path.join(
        os.homedir(),
        "AppData",
        "Local",
        "Microsoft",
        "WinGet",
        "Packages",
    );
    if (fs.existsSync(wingetRoot)) {
        const pkgDir = fs
            .readdirSync(wingetRoot)
            .filter((name) => name.startsWith("SagerNet.sing-box_"))
            .map((name) => path.join(wingetRoot, name))
            .sort()
            .pop();

        if (pkgDir) {
            const stack = [pkgDir];
            while (stack.length > 0) {
                const dir = stack.pop();
                for (const entry of fs.readdirSync(dir, {
                    withFileTypes: true,
                })) {
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) stack.push(full);
                    else if (entry.name.toLowerCase() === "sing-box.exe")
                        return full;
                }
            }
        }
    }

    return candidate;
}

function waitForPort(host, port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    return new Promise((resolve, reject) => {
        const attempt = () => {
            const socket = net.connect({ host, port });
            socket.setTimeout(500);

            socket.once("connect", () => {
                socket.destroy();
                resolve();
            });

            const retry = () => {
                socket.destroy();
                if (Date.now() >= deadline) {
                    reject(
                        new Error(
                            `Proxy ${host}:${port} not ready within ${timeoutMs} ms`,
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

function socks5Connect(proxyHost, proxyPort, destHost, destPort, timeoutMs) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: proxyHost, port: proxyPort });
        let stage = "greeting";
        const buffer = [];

        const fail = (message) => {
            socket.destroy();
            reject(new Error(message));
        };

        const timer = setTimeout(
            () => fail("SOCKS5 handshake timed out"),
            timeoutMs,
        );

        socket.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });

        socket.once("connect", () => {
            socket.write(Buffer.from([0x05, 0x01, 0x00]));
        });

        socket.on("data", (chunk) => {
            buffer.push(chunk);
            const data = Buffer.concat(buffer);

            if (stage === "greeting") {
                if (data.length < 2) return;
                if (data[0] !== 0x05 || data[1] !== 0x00) {
                    fail(
                        `SOCKS5 auth negotiation failed (method 0x${data[1].toString(16)})`,
                    );
                    return;
                }

                buffer.length = 0;
                stage = "connect";

                const hostBytes = Buffer.from(destHost, "utf8");
                const request = Buffer.concat([
                    Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.length]),
                    hostBytes,
                    Buffer.from([(destPort >> 8) & 0xff, destPort & 0xff]),
                ]);
                socket.write(request);
                return;
            }

            if (stage === "connect") {
                if (data.length < 2) return;
                if (data[0] !== 0x05) {
                    fail("Invalid SOCKS5 reply version");
                    return;
                }
                if (data[1] !== 0x00) {
                    fail(
                        `SOCKS5 CONNECT rejected (reply 0x${data[1].toString(16)})`,
                    );
                    return;
                }

                clearTimeout(timer);
                socket.removeAllListeners("data");
                socket.removeAllListeners("error");
                resolve(socket);
            }
        });
    });
}

function httpsGetViaSocket(socket, host, requestPath, timeoutMs) {
    return new Promise((resolve, reject) => {
        const secure = tls.connect({ socket, servername: host }, () => {
            secure.write(
                [
                    `GET ${requestPath} HTTP/1.1`,
                    `Host: ${host}`,
                    "User-Agent: ytm-tunnel-harness",
                    "Accept: application/json",
                    "Connection: close",
                    "",
                    "",
                ].join("\r\n"),
            );
        });

        const chunks = [];
        const timer = setTimeout(() => {
            secure.destroy();
            reject(new Error("HTTPS request timed out"));
        }, timeoutMs);

        secure.on("data", (chunk) => chunks.push(chunk));
        secure.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        secure.on("end", () => {
            clearTimeout(timer);
            const raw = Buffer.concat(chunks).toString("utf8");
            const separator = raw.indexOf("\r\n\r\n");
            const headerBlock =
                separator === -1 ? raw : raw.slice(0, separator);
            const body = separator === -1 ? "" : raw.slice(separator + 4);
            const statusLine = headerBlock.split("\r\n")[0] || "";
            const statusCode = Number(statusLine.split(" ")[1]) || 0;
            resolve({ statusCode, body });
        });
    });
}

async function main() {
    const args = parseArgs(process.argv);

    if (args.help) {
        printHelp();
        return 0;
    }

    const configPath = path.resolve(args.config);
    if (!fs.existsSync(configPath)) {
        throw new Error(`Config not found: ${configPath}`);
    }

    const { host: proxyHost, port: proxyPort } = readSocksInbound(configPath);
    const singBox = resolveSingBox(args.singBox);

    process.stdout.write(`sing-box: ${singBox}\n`);
    process.stdout.write(`config:   ${configPath}\n`);
    process.stdout.write(`proxy:    socks5://${proxyHost}:${proxyPort}\n\n`);

    const child = spawn(singBox, ["run", "-c", configPath], {
        stdio: ["ignore", "pipe", "pipe"],
    });
    const singBoxLog = [];
    child.stdout.on("data", (chunk) => singBoxLog.push(chunk.toString()));
    child.stderr.on("data", (chunk) => singBoxLog.push(chunk.toString()));

    let exitedEarly = false;
    child.once("exit", (code) => {
        exitedEarly = true;
        if (!child.killedByHarness) {
            process.stderr.write(
                `sing-box exited early (code ${code})\n${singBoxLog.join("")}\n`,
            );
        }
    });

    const cleanup = () => {
        if (!args.keepRunning && !exitedEarly) {
            child.killedByHarness = true;
            child.kill();
        }
    };

    try {
        await waitForPort(proxyHost, proxyPort, args.startupTimeoutMs);
        process.stdout.write(
            "proxy is ready, probing exit IP through tunnel...\n",
        );

        const tunnel = await socks5Connect(
            proxyHost,
            proxyPort,
            args.checkHost,
            443,
            args.requestTimeoutMs,
        );
        const response = await httpsGetViaSocket(
            tunnel,
            args.checkHost,
            args.checkPath,
            args.requestTimeoutMs,
        );

        if (response.statusCode !== 200) {
            throw new Error(
                `Unexpected status ${response.statusCode} from ${args.checkHost}`,
            );
        }

        let info;
        try {
            info = JSON.parse(response.body);
        } catch {
            info = { raw: response.body.trim() };
        }

        process.stdout.write("\n--- tunnel exit ---\n");
        process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);

        const throughMullvad = info.mullvad_exit_ip === true;
        process.stdout.write(
            `\nresult: ${throughMullvad ? "PASS (traffic exits via Mullvad)" : "WARN (exit not confirmed as Mullvad)"}\n`,
        );

        return throughMullvad ? 0 : 2;
    } finally {
        cleanup();
    }
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        process.stderr.write(`\nharness failed: ${error.message}\n`);
        process.exit(1);
    });
