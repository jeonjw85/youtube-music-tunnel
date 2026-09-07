// afterPack: replace Electron's stale ad-hoc signature so Gatekeeper shows
// "unidentified developer" (Settings → Open Anyway) instead of "damaged".

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function adhocSign(target) {
    execFileSync("codesign", ["--force", "--sign", "-", target], {
        stdio: "inherit",
    });
}

exports.default = async function macAdhocSign(context) {
    if (context.electronPlatformName !== "darwin") {
        return;
    }

    const appPath = path.join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
    );
    if (!fs.existsSync(appPath)) {
        throw new Error(`mac ad-hoc sign: missing ${appPath}`);
    }

    const extraBin = path.join(
        appPath,
        "Contents",
        "Resources",
        "sing-box",
        "sing-box",
    );
    if (fs.existsSync(extraBin)) {
        adhocSign(extraBin);
    }

    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
        stdio: "inherit",
    });
    execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
        stdio: "inherit",
    });
};
