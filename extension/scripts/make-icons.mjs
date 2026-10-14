#!/usr/bin/env node
// Renders the clare ring glyph to icons/{16,32,48,128}.png — no dependencies.
// The ring: a 3/4 accent arc (12 o'clock → 9 o'clock, clockwise) and a 1/4 lighter arc.
//   node extension/scripts/make-icons.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

const OUT = join(dirname(new URL(import.meta.url).pathname), "..", "icons");
const ACCENT = [0x2f, 0x6f, 0x5e];
const LIGHT = [0x9c, 0xc5, 0xb8];

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function render(size) {
  const SS = 8; // supersampling per axis
  const c = size / 2;
  const thick = Math.max(2.2, size * 0.2);
  const rOut = size / 2 - Math.max(0.6, size * 0.04);
  const rIn = rOut - thick;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0;
      let acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS - c;
          const py = y + (sy + 0.5) / SS - c;
          const r = Math.hypot(px, py);
          if (r < rIn || r > rOut) continue;
          // angle from 12 o'clock, clockwise, 0..360
          const ang = (Math.atan2(px, -py) * 180) / Math.PI;
          const deg = (ang + 360) % 360;
          const col = deg < 270 ? ACCENT : LIGHT;
          a++;
          acc = acc.map((v, i) => v + col[i]);
        }
      }
      const i = (y * size + x) * 4;
      if (a) {
        buf[i] = Math.round(acc[0] / a);
        buf[i + 1] = Math.round(acc[1] / a);
        buf[i + 2] = Math.round(acc[2] / a);
        buf[i + 3] = Math.round((255 * a) / (SS * SS));
      }
    }
  }
  return png(size, buf);
}

mkdirSync(OUT, { recursive: true });
for (const s of [16, 32, 48, 128]) {
  writeFileSync(join(OUT, `${s}.png`), render(s));
  console.log(`icons/${s}.png`);
}
