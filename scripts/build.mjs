// Copies /shared into both targets and (re)generates the extension icons.
// Usage: node scripts/build.mjs
import { cpSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const target of ['extension/shared', 'docs/shared']) {
  cpSync(join(root, 'shared'), join(root, target), { recursive: true });
  console.log('synced shared →', target);
}

// ---- icons: red rounded square with a white "+" (pure Node PNG encoder) ----
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function icon(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const r = size * 0.22, arm = size * 0.3, th = size * 0.085, c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.max(r - x, x - (size - 1 - r), 0), dy = Math.max(r - y, y - (size - 1 - r), 0);
      const inside = dx * dx + dy * dy <= r * r;
      const plus = (Math.abs(x - c) <= th && Math.abs(y - c) <= arm) || (Math.abs(y - c) <= th && Math.abs(x - c) <= arm);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const [R, G, B] = plus ? [255, 255, 255] : [229, 72, 77];
      raw[o] = R; raw[o + 1] = G; raw[o + 2] = B; raw[o + 3] = inside ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const iconDir = join(root, 'extension/icons');
if (!existsSync(iconDir)) mkdirSync(iconDir, { recursive: true });
for (const s of [16, 48, 128]) writeFileSync(join(iconDir, `icon${s}.png`), icon(s));
console.log('icons generated');
