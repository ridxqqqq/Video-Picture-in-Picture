// 生成扩展图标(纯 Node,无第三方依赖,手写 PNG 编码器)
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function sdRoundRect(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2 - r, hy = (y1 - y0) / 2 - r;
  const qx = Math.abs(px - cx) - hx;
  const qy = Math.abs(py - cy) - hy;
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}
function inTri(px, py, a, b, c) {
  const s1 = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
  const s2 = (c[0] - b[0]) * (py - b[1]) - (c[1] - b[1]) * (px - b[0]);
  const s3 = (a[0] - c[0]) * (py - c[1]) - (a[1] - c[1]) * (px - c[0]);
  const hasNeg = s1 < 0 || s2 < 0 || s3 < 0;
  const hasPos = s1 > 0 || s2 > 0 || s3 > 0;
  return !(hasNeg && hasPos);
}

const TRI = [[0.29, 0.27], [0.29, 0.49], [0.53, 0.38]];
const MINI_TRI = [[0.655, 0.595], [0.655, 0.765], [0.805, 0.68]];

function sample(fx, fy) {
  const sdBg = sdRoundRect(fx, fy, 0.02, 0.02, 0.98, 0.98, 0.22);
  if (sdBg > 0.02) return [0, 0, 0, 0];
  const t = Math.min(1, Math.max(0, (fx + fy) / 2));
  const grad = (a, b) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const base = grad([99, 102, 241], [168, 85, 247]); // indigo -> purple
  let col = base;
  const alpha = 255 * Math.min(1, Math.max(0, -sdBg / 0.02 + 1) * (sdBg > -0.02 ? 1 : 1)) || 255;
  // 背景边缘羽化
  let a = sdBg >= -0.02 ? 255 * (1 - (sdBg + 0.02) / 0.02) : 255;

  const white = [255, 255, 255];
  const sdS = sdRoundRect(fx, fy, 0.07, 0.13, 0.80, 0.63, 0.07);
  if (sdS <= 0.024 && sdS >= -0.024) col = white;         // 屏幕描边
  if (inTri(fx, fy, TRI[0], TRI[1], TRI[2])) col = white; // 播放三角

  const sdW = sdRoundRect(fx, fy, 0.52, 0.48, 0.94, 0.89, 0.07);
  if (sdW <= 0) {
    col = white; // 画中画小窗
    if (inTri(fx, fy, MINI_TRI[0], MINI_TRI[1], MINI_TRI[2])) col = grad([79, 70, 229], [124, 58, 237]);
  }
  return [col[0], col[1], col[2], Math.max(0, Math.min(255, a))];
}

function drawIcon(S) {
  const img = Buffer.alloc(S * S * 4);
  const SS = 4;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = (x + (sx + 0.5) / SS) / S;
          const fy = (y + (sy + 0.5) / SS) / S;
          const [cr, cg, cb, ca] = sample(fx, fy);
          r += cr; g += cg; b += cb; a += ca;
        }
      }
      const n = SS * SS, i = (y * S + x) * 4;
      img[i] = Math.round(r / n);
      img[i + 1] = Math.round(g / n);
      img[i + 2] = Math.round(b / n);
      img[i + 3] = Math.round(a / n);
    }
  }
  return img;
}

const outDir = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const png = encodePNG(size, size, drawIcon(size));
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), png);
  console.log(`icon${size}.png ${png.length} bytes`);
}
console.log('icons done');
