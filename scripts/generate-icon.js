#!/usr/bin/env node

// Generates the app icons (assets/icon.png, icon.ico, icon.icns) from code:
// a rounded blue gradient square with a white play triangle, matching the
// tray fallback art. No image libraries needed — PNG/ICO/ICNS are encoded
// here with Node builtins. Re-run any time to regenerate.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ASSETS_DIR = path.join(__dirname, "..", "assets");

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let c = 0xffffffff;
    for (const byte of buffer) {
        c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuffer = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(size, rgba) {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type: RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const raw = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y += 1) {
        const rowStart = y * (size * 4 + 1);
        raw[rowStart] = 0; // filter: none
        rgba.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
    }

    return Buffer.concat([
        signature,
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}

// ---------------------------------------------------------------------------
// Icon art: rounded square + play triangle, 4x supersampled for clean edges
// ---------------------------------------------------------------------------

function renderIcon(size) {
    const S = 4;
    const N = size * S;
    const radius = 0.22 * N;

    // Play triangle vertices in supersampled space.
    const ax = 0.4 * N;
    const ay = 0.28 * N;
    const bx = 0.4 * N;
    const by = 0.72 * N;
    const cx = 0.76 * N;
    const cy = 0.5 * N;

    const insideRoundedSquare = (x, y) => {
        const dx = Math.max(radius - x, x - (N - radius), 0);
        const dy = Math.max(radius - y, y - (N - radius), 0);
        return dx * dx + dy * dy <= radius * radius;
    };

    const side = (px, py, x1, y1, x2, y2) =>
        (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);

    const insideTriangle = (x, y) => {
        const d1 = side(x, y, ax, ay, bx, by);
        const d2 = side(x, y, bx, by, cx, cy);
        const d3 = side(x, y, cx, cy, ax, ay);
        const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
        const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
        return !(hasNeg && hasPos);
    };

    const buffer = Buffer.alloc(size * size * 4);

    for (let py = 0; py < size; py += 1) {
        for (let px = 0; px < size; px += 1) {
            let red = 0;
            let green = 0;
            let blue = 0;
            let hits = 0;

            for (let sy = 0; sy < S; sy += 1) {
                for (let sx = 0; sx < S; sx += 1) {
                    const x = px * S + sx + 0.5;
                    const y = py * S + sy + 0.5;

                    if (!insideRoundedSquare(x, y)) continue;

                    hits += 1;
                    if (insideTriangle(x, y)) {
                        red += 255;
                        green += 255;
                        blue += 255;
                    } else {
                        // Vertical gradient #3b82f6 -> #1d4ed8.
                        const t = y / N;
                        red += 0x3b + (0x1d - 0x3b) * t;
                        green += 0x82 + (0x4e - 0x82) * t;
                        blue += 0xf6 + (0xd8 - 0xf6) * t;
                    }
                }
            }

            const i = (py * size + px) * 4;
            if (hits > 0) {
                buffer[i] = Math.round(red / hits);
                buffer[i + 1] = Math.round(green / hits);
                buffer[i + 2] = Math.round(blue / hits);
            }
            buffer[i + 3] = Math.round((255 * hits) / (S * S));
        }
    }

    return buffer;
}

// ---------------------------------------------------------------------------
// ICO and ICNS containers
// ---------------------------------------------------------------------------

/** Build an ICO embedding PNG data (valid on Windows Vista and later). */
function buildIco(pngs) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2); // type: icon
    header.writeUInt16LE(pngs.length, 4);

    let offset = 6 + pngs.length * 16;
    const entries = [];

    for (const { size, buffer } of pngs) {
        const entry = Buffer.alloc(16);
        entry[0] = size >= 256 ? 0 : size;
        entry[1] = size >= 256 ? 0 : size;
        entry.writeUInt16LE(1, 4); // color planes
        entry.writeUInt16LE(32, 6); // bits per pixel
        entry.writeUInt32LE(buffer.length, 8);
        entry.writeUInt32LE(offset, 12);
        offset += buffer.length;
        entries.push(entry);
    }

    return Buffer.concat([header, ...entries, ...pngs.map((p) => p.buffer)]);
}

/** Build an ICNS file from PNG-backed entries (ic07/8/9). */
function buildIcns(entries) {
    const total = 8 + entries.reduce((sum, e) => sum + 8 + e.buffer.length, 0);
    const header = Buffer.alloc(8);
    header.write("icns", 0, "ascii");
    header.writeUInt32BE(total, 4);

    const parts = [header];
    for (const { type, buffer } of entries) {
        const entryHeader = Buffer.alloc(8);
        entryHeader.write(type, 0, "ascii");
        entryHeader.writeUInt32BE(8 + buffer.length, 4);
        parts.push(entryHeader, buffer);
    }

    return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });

    console.log("Rendering icons…");
    const sizes = [512, 256, 128, 64, 48, 32, 16];
    const pngs = {};
    for (const size of sizes) {
        pngs[size] = encodePng(size, renderIcon(size));
        console.log(`  ${size}x${size}  ${(pngs[size].length / 1024).toFixed(1)} KB`);
    }

    const pngPath = path.join(ASSETS_DIR, "icon.png");
    const icoPath = path.join(ASSETS_DIR, "icon.ico");
    const icnsPath = path.join(ASSETS_DIR, "icon.icns");

    fs.writeFileSync(pngPath, pngs[512]);
    fs.writeFileSync(
        icoPath,
        buildIco([256, 64, 48, 32, 16].map((size) => ({ size, buffer: pngs[size] }))),
    );
    fs.writeFileSync(
        icnsPath,
        buildIcns([
            { type: "ic07", buffer: pngs[128] },
            { type: "ic08", buffer: pngs[256] },
            { type: "ic09", buffer: pngs[512] },
        ]),
    );

    console.log(`Wrote ${pngPath}`);
    console.log(`Wrote ${icoPath}`);
    console.log(`Wrote ${icnsPath}`);
}

main();
