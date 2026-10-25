// Writes assets/claude.ico: the pixel Claude at 16, 32, 48 and 256 px.

const fs = require('fs');
const path = require('path');

const ART = [
  '................',
  '................',
  '................',
  '...##########...',
  '...##########...',
  '...##k####k##...',
  '...##k####k##...',
  '.##############.',
  '.##############.',
  '...##########...',
  '...##########...',
  '....#.#..#.#....',
  '....#.#..#.#....',
  '................',
  '................',
  '................',
];
const COLORS = { '#': [0x57, 0x77, 0xd9, 0xff], k: [0x1a, 0x1a, 0x1a, 0xff] }; // BGRA

function bitmap(size) {
  const scale = size / 16;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = COLORS[ART[Math.floor(y / scale)][Math.floor(x / scale)]];
      // ICO bitmaps are stored bottom-up.
      if (c) pixels.set(c, ((size - 1 - y) * size + x) * 4);
    }
  }
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // colour + mask height
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size); // all zero: alpha channel decides
  return Buffer.concat([header, pixels, mask]);
}

const sizes = [16, 32, 48, 256];
const images = sizes.map(bitmap);
const dir = Buffer.alloc(6 + 16 * sizes.length);
dir.writeUInt16LE(1, 2);
dir.writeUInt16LE(sizes.length, 4);
let offset = dir.length;
sizes.forEach((size, i) => {
  const e = 6 + i * 16;
  dir.writeUInt8(size % 256, e);
  dir.writeUInt8(size % 256, e + 1);
  dir.writeUInt16LE(1, e + 4);
  dir.writeUInt16LE(32, e + 6);
  dir.writeUInt32LE(images[i].length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += images[i].length;
});

const out = path.resolve(__dirname, '..', 'assets', 'claude.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([dir, ...images]));
console.log(out);
