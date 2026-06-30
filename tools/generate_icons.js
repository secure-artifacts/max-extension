// Generates icons/icon16.png, icon48.png, icon128.png (a clock on a blue tile).
// No dependencies; builds PNGs from raw RGBA using Node's zlib.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.join(__dirname, "..", "icons");
fs.mkdirSync(OUT, { recursive: true });

// CRC32
const crcTable = (function () {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const tileR = size * 0.5; // full tile radius (rounded square via radius)
  const corner = size * 0.22;
  const faceR = size * 0.34;
  const ringW = Math.max(1, size * 0.045);
  const handW = Math.max(1, size * 0.05);

  const blue = [79, 124, 255];
  const blueDark = [43, 58, 120];
  const white = [245, 248, 255];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;

      // rounded-square tile mask
      const qx = Math.max(Math.abs(px - c) - (size / 2 - corner), 0);
      const qy = Math.max(Math.abs(py - c) - (size / 2 - corner), 0);
      const cornerDist = Math.hypot(qx, qy);
      const inTile =
        Math.abs(px - c) <= size / 2 &&
        Math.abs(py - c) <= size / 2 &&
        cornerDist <= corner + 0.5;

      if (!inTile) {
        rgba[i + 3] = 0;
        continue;
      }

      // background gradient tile
      const g = (py / size) * 0.6 + (px / size) * 0.4;
      let col = mix(blue, blueDark, g);
      let alpha = 255;

      const dFace = Math.hypot(px - c, py - c);

      // clock face (white disc)
      if (dFace <= faceR) {
        col = white;
      }
      // ring around face
      if (Math.abs(dFace - faceR) <= ringW) {
        col = white;
      }

      // hands (drawn on white face, in blue)
      if (dFace <= faceR - ringW * 0.5) {
        const hourEnd = [c, c - faceR * 0.5];
        const minEnd = [c + faceR * 0.66, c + faceR * 0.05];
        const dHour = distToSeg(px, py, c, c, hourEnd[0], hourEnd[1]);
        const dMin = distToSeg(px, py, c, c, minEnd[0], minEnd[1]);
        if (dHour <= handW || dMin <= handW * 0.85) {
          col = blueDark;
        }
        if (dFace <= handW * 1.3) {
          col = blueDark; // center pin
        }
      }

      rgba[i] = col[0];
      rgba[i + 1] = col[1];
      rgba[i + 2] = col[2];
      rgba[i + 3] = alpha;
    }
  }
  return encodePng(size, size, rgba);
}

[16, 48, 128].forEach(function (size) {
  const png = drawIcon(size);
  const file = path.join(OUT, "icon" + size + ".png");
  fs.writeFileSync(file, png);
  console.log("wrote", file, png.length, "bytes");
});
