#!/usr/bin/env node

// CLI wrapper around the shared WireGuard -> sing-box converter.
// The pure conversion logic lives in ../wg-convert.js so the Electron
// main process can reuse it for first-run onboarding.

const fs = require("fs");
const path = require("path");
const { parseWireGuardConfig, toSingBoxConfig } = require("../wg-convert");

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

function usage() {
    const text = [
        "Usage:",
        "  node ./scripts/convert-wg-to-singbox.js --input <wireguard.conf> [--output ./sing-box/config.json] [--listen-host 127.0.0.1] [--listen-port 1080] [--mtu 1280]",
        "",
        "Example:",
        "  node ./scripts/convert-wg-to-singbox.js --input C:/Users/me/Downloads/jp-tyo-wg.conf --output ./sing-box/config.json",
        "",
        "Note: the app can also do this conversion for you on first launch",
        "(it asks for a WireGuard .conf file when no tunnel config exists).",
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
