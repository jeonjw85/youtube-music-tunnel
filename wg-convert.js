// Shared WireGuard -> sing-box conversion logic.
// Used by the CLI (scripts/convert-wg-to-singbox.js) and by the Electron
// main process (singbox.js) for first-run config onboarding.

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
    const listenHost = (opts && opts.listenHost) || "127.0.0.1";
    const listenPort = (opts && opts.listenPort) || 1080;
    const mtu = (opts && opts.mtu) || 1280;

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
        persistent_keepalive_interval: 25,
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
                listen: listenHost,
                listen_port: listenPort,
            },
        ],
        endpoints: [
            {
                type: "wireguard",
                tag: "mullvad-wg",
                address: [localAddress],
                private_key: iface.PrivateKey,
                mtu,
                connect_timeout: "10s",
                peers: [peerEntry],
            },
        ],
        outbounds: [
            {
                type: "direct",
                tag: "direct",
            },
        ],
        dns: {
            servers: [
                {
                    type: "udp",
                    tag: "dns-remote",
                    server: "1.1.1.1",
                    detour: "mullvad-wg",
                },
            ],
            strategy: "ipv4_only",
        },
        route: {
            auto_detect_interface: true,
            final: "mullvad-wg",
        },
    };
}

/**
 * Convert a WireGuard .conf file's contents into a sing-box config object.
 * @param {string} text WireGuard config file contents
 * @param {{listenHost?: string, listenPort?: number, mtu?: number}} [opts]
 */
function convertWireGuardText(text, opts) {
    return toSingBoxConfig(parseWireGuardConfig(text), opts);
}

module.exports = {
    parseWireGuardConfig,
    toSingBoxConfig,
    convertWireGuardText,
};
