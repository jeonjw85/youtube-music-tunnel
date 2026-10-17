const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { once } = require("node:events");

async function createTunnelFixture(t) {
    const root = path.join(__dirname, "..");
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ytm-tunnel-test-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));

    const configPath = path.join(temp, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({
        inbounds: [{ type: "socks", listen: "127.0.0.1", listen_port: port }],
    }));
    const moduleObject = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, "singbox.js"), "utf8"), {
        require(id) {
            if (id === "electron") return { app: { isPackaged: false } };
            if (id === "./wg-convert") return require("../wg-convert");
            return require(id);
        },
        module: moduleObject,
        __dirname: temp,
        process,
        URL,
        setTimeout,
        clearTimeout,
    }, { filename: "singbox.js" });
    const tunnel = moduleObject.exports;
    t.after(() => tunnel.stopTunnel());

    return {
        temp,
        tunnel,
        options: {
            configPath,
            proxyUrl: `socks5://127.0.0.1:${port}`,
            timeoutMs: 25,
        },
    };
}

test("rejects a missing tunnel executable and allows another startup attempt", async (t) => {
    const { temp, tunnel, options } = await createTunnelFixture(t);
    const exePath = path.join(temp, "missing-sing-box");

    await assert.rejects(tunnel.startTunnel({ ...options, exePath }), /ENOENT/);
    await assert.rejects(tunnel.startTunnel({ ...options, exePath }), /ENOENT/);
});

test("rejects a tunnel executable without execute permission", {
    skip: process.platform === "win32",
}, async (t) => {
    const { temp, tunnel, options } = await createTunnelFixture(t);
    const exePath = path.join(temp, "non-executable-sing-box");
    fs.writeFileSync(exePath, "not executable", { mode: 0o600 });

    await assert.rejects(tunnel.startTunnel({ ...options, exePath }), /EACCES/);
});
