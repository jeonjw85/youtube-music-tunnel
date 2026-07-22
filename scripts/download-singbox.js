#!/usr/bin/env node

// Downloads the official sing-box Windows release into vendor/sing-box/ so
// `npm run build:win` can bundle it into the installer (electron-builder
// extraResources). Zero dependencies: uses global fetch + built-in tar.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, execSync } = require("child_process");

const GITHUB_API_LATEST =
    "https://api.github.com/repos/SagerNet/sing-box/releases/latest";
const USER_AGENT = "ytm-tunnel-desktop-build-script";

function parseArgs(argv) {
    const args = { version: "", force: false, help: false };

    for (let i = 2; i < argv.length; i += 1) {
        const token = argv[i];

        if (token === "--help" || token === "-h") {
            args.help = true;
        } else if (token === "--force") {
            args.force = true;
        } else if (token.startsWith("--version=")) {
            args.version = token.slice("--version=".length);
        } else if (token === "--version") {
            args.version = argv[i + 1] || "";
            i += 1;
        }
    }

    return args;
}

function usage() {
    console.log(
        [
            "Usage:",
            "  node ./scripts/download-singbox.js [--version <x.y.z>] [--force]",
            "",
            "Downloads sing-box (windows-amd64) into vendor/sing-box/sing-box.exe.",
            "Defaults to the latest GitHub release; skips if already downloaded",
            "unless --force is given.",
        ].join("\n"),
    );
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

async function resolveLatestVersion() {
    const response = await fetch(GITHUB_API_LATEST, {
        headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/vnd.github+json",
        },
    });

    if (!response.ok) {
        throw new Error(
            `GitHub API returned ${response.status} for the latest sing-box release. ` +
                "Retry later, or pin a version with --version <x.y.z>.",
        );
    }

    const data = await response.json();
    const tag = String(data.tag_name || "").replace(/^v/, "");

    if (!tag) {
        throw new Error("GitHub API response did not include a release tag.");
    }

    return tag;
}

function extractZip(zipPath, destDir) {
    // Windows 10 1803+ ships tar.exe, which handles zip archives.
    try {
        execFileSync("tar", ["-xf", zipPath, "-C", destDir], {
            stdio: ["ignore", "ignore", "pipe"],
        });
        return;
    } catch {
        // Fall through to PowerShell.
    }

    execSync(
        `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force"`,
        { stdio: ["ignore", "ignore", "inherit"] },
    );
}

async function main() {
    const args = parseArgs(process.argv);

    if (args.help) {
        usage();
        return;
    }

    if (typeof fetch !== "function") {
        throw new Error(
            "This script needs Node.js 18+ (global fetch). Upgrade Node and retry.",
        );
    }

    const vendorDir = path.join(__dirname, "..", "vendor", "sing-box");
    const targetExe = path.join(vendorDir, "sing-box.exe");

    if (fs.existsSync(targetExe) && !args.force) {
        console.log(`sing-box already vendored: ${targetExe}`);
        console.log("Use --force to re-download.");
        return;
    }

    const version = args.version || (await resolveLatestVersion());
    const zipName = `sing-box-${version}-windows-amd64.zip`;
    const zipUrl = `https://github.com/SagerNet/sing-box/releases/download/v${version}/${zipName}`;

    console.log(`sing-box version: ${version}`);
    console.log(`Downloading: ${zipUrl}`);

    const response = await fetch(zipUrl, {
        redirect: "follow",
        headers: { "User-Agent": USER_AGENT },
    });

    if (!response.ok) {
        throw new Error(
            `Download failed with HTTP ${response.status}: ${zipUrl}\n` +
                "Check the version number, or download manually from " +
                "https://github.com/SagerNet/sing-box/releases and place sing-box.exe into vendor/sing-box/.",
        );
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytm-singbox-"));
    const zipPath = path.join(tmpDir, zipName);
    const extractDir = path.join(tmpDir, "extracted");

    try {
        fs.writeFileSync(zipPath, buffer);
        console.log(
            `Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB, extracting…`,
        );

        fs.mkdirSync(extractDir, { recursive: true });
        extractZip(zipPath, extractDir);

        const exePath = findFileRecursive(extractDir, "sing-box.exe");
        if (!exePath) {
            throw new Error(
                "sing-box.exe not found in the downloaded archive. " +
                    "The release layout may have changed; download manually from " +
                    "https://github.com/SagerNet/sing-box/releases and place sing-box.exe into vendor/sing-box/.",
            );
        }

        fs.mkdirSync(vendorDir, { recursive: true });
        fs.copyFileSync(exePath, targetExe);

        console.log(`Vendored: ${targetExe}`);
    } finally {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // Best-effort cleanup.
        }
    }
}

main().catch((error) => {
    console.error(`download-singbox failed: ${error.message}`);
    process.exit(1);
});
