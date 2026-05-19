#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
    const args = {
        input: "",
        output: "./sing-box/config.json",
        listenHost: "127.0.0.1",
        listenPort: 1080,
        mtu: 1280,
        help: false,
    };

    for (let i = 2; i < argv.length; i += 1) {
        const token = argv[i];

        if (token === "--help" || token === "-h") {
            args.help = true;
            continue;
        }

        if (token.startsWith("--input=")) {
            args.input = token.slice("--input=".length);
            continue;
        }

        if (token === "--input") {
            args.input = argv[i + 1] || "";
            i += 1;
            continue;
        }

        if (token.startsWith("--output=")) {
            args.output = token.slice("--output=".length);
            continue;
        }

        if (token === "--output") {
            args.output = argv[i + 1] || args.output;
            i += 1;
            continue;
        }

        if (token.startsWith("--listen-host=")) {
            args.listenHost = token.slice("--listen-host=".length);
            continue;
        }

        if (token === "--listen-host") {
            args.listenHost = argv[i + 1] || args.listenHost;
            i += 1;
            continue;
        }

        if (token.startsWith("--listen-port=")) {
            args.listenPort = Number(token.slice("--listen-port=".length));
            continue;
        }

        if (token === "--listen-port") {
            args.listenPort = Number(argv[i + 1] || args.listenPort);
            i += 1;
            continue;
        }

        if (token.startsWith("--mtu=")) {
            args.mtu = Number(token.slice("--mtu=".length));
            continue;
        }

        if (token === "--mtu") {
            args.mtu = Number(argv[i + 1] || args.mtu);
            i += 1;
            continue;
        }
    }

    return args;
}

function stripComment(line) {
    const hash = line.indexOf("#");
    const semi = line.indexOf(";");
    let cut = line.length;

    if (hash >= 0) {
        cut = Math.min(cut, hash);
    }

    if (semi >= 0) {
        cut = Math.min(cut, semi);
    }

    return line.slice(0, cut).trim();
}

function parseWireGuardConfig(text) {
    const result = {
        Interface: {},
        Peer: {},
    };

    let section = "";
    const lines = text.split(/\r?\n/);

    for (const rawLine of lines) {
        const line = stripComment(rawLine);
        if (!line) {
            continue;
        }

        if (line.startsWith("[") && line.endsWith("]")) {
            section = line.slice(1, -1).trim();
            continue;
        }

        const eq = line.indexOf("=");
        if (eq < 0 || !section) {
            continue;
        }

        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();

        if (!result[section]) {
            result[section] = {};
        }

        result[section][key] = value;
    }

    return result;
}

function parseEndpoint(endpointValue) {
    // Supports host:port and [ipv6]:port.
    const endpoint = endpointValue.trim();

    if (endpoint.startsWith("[")) {
        const close = endpoint.lastIndexOf("]");
        if (close < 0) {
            throw new Error("Invalid Endpoint format: missing closing bracket");
        }

        const host = endpoint.slice(1, close);
        const suffix = endpoint.slice(close + 1);
        if (!suffix.startsWith(":")) {
            throw new Error("Invalid Endpoint format: missing port");
        }

        const port = Number(suffix.slice(1));
        if (!Number.isInteger(port) || port <= 0) {
            throw new Error("Invalid Endpoint format: invalid port");
        }

        return { host, port };
    }

    const idx = endpoint.lastIndexOf(":");
    if (idx < 0) {
        throw new Error("Invalid Endpoint format: expected host:port");
    }

    const host = endpoint.slice(0, idx).trim();
    const port = Number(endpoint.slice(idx + 1).trim());

    if (!host) {
        throw new Error("Invalid Endpoint format: empty host");
    }

    if (!Number.isInteger(port) || port <= 0) {
        throw new Error("Invalid Endpoint format: invalid port");
    }

    return { host, port };
}

function parseFirstIpv4Cidr(addressValue) {
    const items = addressValue
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

    for (const item of items) {
        if (item.includes(".") && item.includes("/")) {
            return item;
        }
    }

    throw new Error("Interface Address does not contain an IPv4 CIDR value");
}

function parseReserved(reservedValue) {
    if (!reservedValue) {
        return [0, 0, 0];
    }

    const nums = reservedValue
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 255);

    if (nums.length !== 3) {
        return [0, 0, 0];
    }

    return nums;
}

function parseAllowedIps(allowedIpsValue) {
    if (!allowedIpsValue) {
        return ["0.0.0.0/0", "::/0"];
    }

    const items = allowedIpsValue
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

    if (items.length === 0) {
        return ["0.0.0.0/0", "::/0"];
    }

    return items;
}

function toSingBoxConfig(parsed, opts) {
    const iface = parsed.Interface || {};
    const peer = parsed.Peer || {};

    if (!iface.PrivateKey) {
        throw new Error("Missing Interface PrivateKey in WireGuard config");
    }

    if (!iface.Address) {
        throw new Error("Missing Interface Address in WireGuard config");
    }

    if (!peer.PublicKey) {
        throw new Error("Missing Peer PublicKey in WireGuard config");
    }

    if (!peer.Endpoint) {
        throw new Error("Missing Peer Endpoint in WireGuard config");
    }

    const endpoint = parseEndpoint(peer.Endpoint);
    const localAddress = parseFirstIpv4Cidr(iface.Address);
    const reserved = parseReserved(peer.Reserved || iface.Reserved);
    const allowedIps = parseAllowedIps(peer.AllowedIPs);

    const peerEntry = {
        address: endpoint.host,
        port: endpoint.port,
        public_key: peer.PublicKey,
        allowed_ips: allowedIps,
        reserved,
    };

    if (peer.PresharedKey) {
        peerEntry.pre_shared_key = peer.PresharedKey;
    }

    return {
        log: {
            level: "info",
            timestamp: true,
        },
        inbounds: [
            {
                type: "socks",
                tag: "socks-in",
                listen: opts.listenHost,
                listen_port: opts.listenPort,
            },
        ],
        endpoints: [
            {
                type: "wireguard",
                tag: "mullvad-wg",
                address: [localAddress],
                private_key: iface.PrivateKey,
                mtu: opts.mtu,
                peers: [peerEntry],
            },
        ],
        outbounds: [
            {
                type: "direct",
                tag: "direct",
            },
        ],
        route: {
            auto_detect_interface: true,
            final: "mullvad-wg",
        },
    };
}

function usage() {
    const text = [
        "Usage:",
        "  node ./scripts/convert-wg-to-singbox.js --input <wireguard.conf> [--output ./sing-box/config.json] [--listen-host 127.0.0.1] [--listen-port 1080] [--mtu 1280]",
        "",
        "Example:",
        "  node ./scripts/convert-wg-to-singbox.js --input C:/Users/me/Downloads/jp-tyo-wg.conf --output ./sing-box/config.json",
    ].join("\n");

    console.log(text);
}

function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
}

function main() {
    const args = parseArgs(process.argv);

    if (args.help || !args.input) {
        usage();
        process.exit(args.help ? 0 : 1);
    }

    if (!Number.isInteger(args.listenPort) || args.listenPort <= 0) {
        throw new Error("--listen-port must be a positive integer");
    }

    if (!Number.isInteger(args.mtu) || args.mtu <= 0) {
        throw new Error("--mtu must be a positive integer");
    }

    const inputPath = path.resolve(process.cwd(), args.input);
    const outputPath = path.resolve(process.cwd(), args.output);

    const inputText = fs.readFileSync(inputPath, "utf8");
    const parsed = parseWireGuardConfig(inputText);
    const config = toSingBoxConfig(parsed, args);

    ensureDir(outputPath);
    fs.writeFileSync(
        outputPath,
        JSON.stringify(config, null, 2) + "\n",
        "utf8",
    );

    console.log(`Converted WireGuard config: ${inputPath}`);
    console.log(`Generated sing-box config: ${outputPath}`);
    console.log(
        `SOCKS5 endpoint: socks5://${args.listenHost}:${args.listenPort}`,
    );
}

try {
    main();
} catch (error) {
    console.error(`Conversion failed: ${error.message}`);
    process.exit(1);
}
