// 간단한 마이크 아이콘 PNG를 생성한다(외부 도구 없이).
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

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
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel((x + 0.5) / size, (y + 0.5) / size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// 마이크 모양 판정 (0~1 좌표)
function mic(x, y) {
  const capsule = (() => {
    const cx = 0.5, w = 0.14, top = 0.16, bot = 0.56;
    if (y < top + w) return Math.hypot(x - cx, y - (top + w)) <= w;
    if (y > bot - w) return Math.hypot(x - cx, y - (bot - w)) <= w;
    return Math.abs(x - cx) <= w;
  })();
  const d = Math.hypot(x - 0.5, y - 0.44);
  const arc = y > 0.44 && d >= 0.22 && d <= 0.29;
  const stem = Math.abs(x - 0.5) <= 0.035 && y >= 0.72 && y <= 0.84;
  const base = Math.abs(x - 0.5) <= 0.16 && y >= 0.81 && y <= 0.87;
  return capsule || arc || stem || base;
}
function ss(fn, size) {
  // 4x4 슈퍼샘플링으로 가장자리를 부드럽게
  return (x, y) => {
    let hit = 0;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) hit += fn(x + (i - 1.5) / (4 * size), y + (j - 1.5) / (4 * size)) ? 1 : 0;
    return hit / 16;
  };
}
const out = path.join(__dirname, '..', 'src', 'assets');
for (const [name, size, color] of [['tray.png', 32, [59, 91, 219]], ['trayTemplate.png', 16, [0, 0, 0]], ['trayTemplate@2x.png', 32, [0, 0, 0]]]) {
  const f = ss(mic, size);
  fs.writeFileSync(path.join(out, name), png(size, (x, y) => [...color, Math.round(f(x, y) * 255)]));
}
// 앱 아이콘: 둥근 사각형 배경 + 흰 마이크
const S = 512, fm = ss(mic, S);
const rr = (x, y) => { const r = 0.22, m = 0.06; const qx = Math.max(Math.abs(x - 0.5) - (0.5 - m - r), 0), qy = Math.max(Math.abs(y - 0.5) - (0.5 - m - r), 0); return Math.hypot(qx, qy) <= r; };
const fb = ss(rr, S);
fs.writeFileSync(path.join(out, 'icon.png'), png(S, (x, y) => {
  const a = fb(x, y), m = fm((x - 0.5) / 0.78 + 0.5, (y - 0.5) / 0.78 + 0.5);
  const bg = [59, 91, 219];
  return [Math.round(bg[0] + (255 - bg[0]) * m), Math.round(bg[1] + (255 - bg[1]) * m), Math.round(bg[2] + (255 - bg[2]) * m), Math.round(a * 255)];
}));
console.log('icons written');
