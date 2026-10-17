const assert = require("node:assert/strict");
const test = require("node:test");
const { parseWireGuardConfig, convertWireGuardText } = require("../wg-convert");

for (const [section, target] of [
    ["__proto__", Object.prototype],
    ["constructor", Object],
    ["toString", Object.prototype.toString],
]) {
    test(`ignores the ${section} section without modifying shared objects`, (t) => {
        const key = "ytmParserPollutionProbe";
        t.after(() => delete target[key]);

        parseWireGuardConfig(`[${section}]\n${key} = unexpected\n`);

        assert.equal(Object.hasOwn(target, key), false);
    });
}

test("ignores unsupported sections and resumes parsing recognized sections", () => {
    const parsed = parseWireGuardConfig([
        "[Other]",
        "PrivateKey = ignored",
        "[Interface]",
        "PrivateKey = interface-key",
        "Address = 10.0.0.2/32",
        "[Peer]",
        "PublicKey = peer-key",
        "Endpoint = 192.0.2.1:51820",
    ].join("\n"));

    assert.equal(Object.hasOwn(parsed, "Other"), false);
    assert.equal(parsed.Interface.PrivateKey, "interface-key");
    assert.equal(parsed.Peer.PublicKey, "peer-key");
});

test("missing required keys are not supplied by inherited object properties", (t) => {
    Object.prototype.PrivateKey = "inherited-key";
    t.after(() => delete Object.prototype.PrivateKey);

    assert.throws(() => convertWireGuardText([
        "[Interface]",
        "Address = 10.0.0.2/32",
        "[Peer]",
        "PublicKey = peer-key",
        "Endpoint = 192.0.2.1:51820",
    ].join("\n")), /Missing Interface PrivateKey/);
});

test("converts normal WireGuard settings including comments and optional peer fields", () => {
    const config = convertWireGuardText([
        "[Interface]",
        "PrivateKey = private-key # comment",
        "Address = 10.0.0.2/32, fd00::2/128",
        "[Peer]",
        "PublicKey = public-key",
        "PresharedKey = preshared-key",
        "Endpoint = [2001:db8::1]:51820",
        "AllowedIPs = 0.0.0.0/0, ::/0",
        "Reserved = 1, 2, 3 ; comment",
    ].join("\n"));

    assert.equal(config.endpoints[0].private_key, "private-key");
    assert.deepEqual(config.endpoints[0].address, ["10.0.0.2/32"]);
    assert.deepEqual(config.endpoints[0].peers[0], {
        address: "2001:db8::1",
        port: 51820,
        public_key: "public-key",
        allowed_ips: ["0.0.0.0/0", "::/0"],
        persistent_keepalive_interval: 25,
        reserved: [1, 2, 3],
        pre_shared_key: "preshared-key",
    });
});
