#!/usr/bin/env node

// Downloads the official sing-box release for the current platform and
// architecture into vendor/sing-box/ so `npm run build` can bundle it into
// the package (electron-builder extraResources). Zero dependencies: uses
// global fetch + built-in tar.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, execSync } = require("child_process");

const GITHUB_API_LATEST =
    "https://api.github.com/repos/SagerNet/sing-box/releases/latest";
const USER_AGENT = "ytm-tunnel-desktop-build-script";

const PLATFORMS = { win32: "windows", darwin: "darwin", linux: "linux" };
const ARCHES = { x64: "amd64", arm64: "arm64" };

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
            "Downloads sing-box for the current platform and architecture into",
            "vendor/sing-box/. Defaults to the latest GitHub release; skips if",
            "already downloaded unless --force is given.",
        ].join("\n"),
    );
}

/** Map Node's platform/arch to sing-box release naming. Throws elsewhere. */
function resolveTarget() {
    const platform = PLATFORMS[process.platform];
    const arch = ARCHES[process.arch];

    if (!platform) {
        throw new Error(
            `Unsupported platform: ${process.platform}. sing-box releases cover windows, darwin, and linux.`,
        );
    }

    if (!arch) {
        throw new Error(
            `Unsupported architecture: ${process.arch}. sing-box releases cover amd64 and arm64.`,
        );
    }

    return {
        platform,
        arch,
        exeName: platform === "windows" ? "sing-box.exe" : "sing-box",
        archiveExt: platform === "windows" ? "zip" : "tar.gz",
    };
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

function extractArchive(archivePath, destDir, isZip) {
    // tar handles both zip and tar.gz on every supported platform
    // (Windows 10 1803+ ships tar.exe).
    try {
        execFileSync("tar", [isZip ? "-xf" : "-xzf", archivePath, "-C", destDir], {
            stdio: ["ignore", "ignore", "pipe"],
        });
        return;
    } catch (error) {
        if (!isZip || process.platform !== "win32") {
            throw error;
        }
        // Fall through to PowerShell for zip on Windows.
    }

    execSync(
        `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force"`,
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

    const { platform, arch, exeName, archiveExt } = resolveTarget();
    const vendorDir = path.join(__dirname, "..", "vendor", "sing-box");
    const targetBin = path.join(vendorDir, exeName);

    if (fs.existsSync(targetBin) && !args.force) {
        console.log(`sing-box already vendored: ${targetBin}`);
        console.log("Use --force to re-download.");
        return;
    }

    const version = args.version || (await resolveLatestVersion());
    const archiveName = `sing-box-${version}-${platform}-${arch}.${archiveExt}`;
    const archiveUrl = `https://github.com/SagerNet/sing-box/releases/download/v${version}/${archiveName}`;

    console.log(`sing-box version: ${version}`);
    console.log(`target: ${platform}-${arch}`);
    console.log(`Downloading: ${archiveUrl}`);

    const response = await fetch(archiveUrl, {
        redirect: "follow",
        headers: { "User-Agent": USER_AGENT },
    });

    if (!response.ok) {
        throw new Error(
            `Download failed with HTTP ${response.status}: ${archiveUrl}\n` +
                "Check the version number, or download manually from " +
                `https://github.com/SagerNet/sing-box/releases and place ${exeName} into vendor/sing-box/.`,
        );
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytm-singbox-"));
    const archivePath = path.join(tmpDir, archiveName);
    const extractDir = path.join(tmpDir, "extracted");

    try {
        fs.writeFileSync(archivePath, buffer);
        console.log(
            `Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB, extracting…`,
        );

        fs.mkdirSync(extractDir, { recursive: true });
        extractArchive(archivePath, extractDir, archiveExt === "zip");

        const binPath = findFileRecursive(extractDir, exeName);
        if (!binPath) {
            throw new Error(
                `${exeName} not found in the downloaded archive. ` +
                    "The release layout may have changed; download manually from " +
                    `https://github.com/SagerNet/sing-box/releases and place ${exeName} into vendor/sing-box/.`,
            );
        }

        fs.mkdirSync(vendorDir, { recursive: true });
        fs.copyFileSync(binPath, targetBin);

        if (process.platform !== "win32") {
            fs.chmodSync(targetBin, 0o755);
        }

        console.log(`Vendored: ${targetBin}`);
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
