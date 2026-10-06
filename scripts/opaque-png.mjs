// Drops the alpha channel of 8-bit RGBA PNGs, in place: App Store Connect refuses an app icon
// that has one, even when every pixel is opaque (ITMS-90717). The icons from `pnpm icons` are
// RGBA with nothing transparent; this makes them RGB on the way into the Xcode project
// (ios.yml). Other PNGs are left alone. No dependencies: Node's zlib only.
//
//   node scripts/opaque-png.mjs <file.png>...

import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync, crc32 } from "node:zlib";

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function opaque(file) {
  const png = readFileSync(file);
  let offset = 8;
  let header;
  const data = [];
  const rest = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") header = Buffer.from(body);
    else if (type === "IDAT") data.push(body);
    else if (type !== "IEND") rest.push(chunk(type, body));
    offset += 12 + length;
  }
  const [width, height, depth, color, , , interlace] = [
    header.readUInt32BE(0),
    header.readUInt32BE(4),
    header[8],
    header[9],
    header[10],
    header[11],
    header[12],
  ];
  if (color !== 6 || depth !== 8 || interlace !== 0) return console.log(`${file}: left as it is`);

  const raw = inflateSync(Buffer.concat(data));
  const stride = width * 4;
  const out = Buffer.alloc(height * (width * 3 + 1));
  let previous = Buffer.alloc(stride);
  let lowest = 255;
  for (let y = 0, at = 0; y < height; y++) {
    const filter = raw[at++];
    const line = Buffer.from(raw.subarray(at, at + stride));
    at += stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? line[x - 4] : 0;
      const up = previous[x];
      const corner = x >= 4 ? previous[x - 4] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)];
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      line[x] = value & 255;
    }
    const row = y * (width * 3 + 1);
    out[row] = 0;
    for (let x = 0; x < width; x++) {
      line.copy(out, row + 1 + x * 3, x * 4, x * 4 + 3);
      lowest = Math.min(lowest, line[x * 4 + 3]);
    }
    previous = line;
  }
  // Nearly opaque is fine (the drawing's anti-aliased edge); a cut-out shape is not.
  if (lowest < 250) throw new Error(`${file} has transparent pixels (alpha ${lowest}); flatten it by hand.`);
  header[9] = 2;
  const signature = png.subarray(0, 8);
  writeFileSync(
    file,
    Buffer.concat([
      signature,
      chunk("IHDR", header),
      ...rest,
      chunk("IDAT", deflateSync(out, { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
  console.log(`${file}: RGB, ${width}×${height}`);
}

for (const file of process.argv.slice(2)) opaque(file);
