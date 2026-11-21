/**
 * 最小 PNG 编码器（无依赖）。只用来生成测试用的占位二维码图片。
 * 支持 RGBA8、无隔行、filter 0。
 */

import { deflateSync } from "node:zlib";

const TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {(x:number,y:number)=>[number,number,number,number]} pixel
 */
export function encodePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
      offset += 4;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 画一张「看起来像二维码」的占位图：三个定位角 + 伪随机点阵。 */
export function placeholderQr(modules = 33, scale = 8, seed = 20261121) {
  let state = seed;
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_647;
    return state / 2_147_483_647;
  };

  const grid = Array.from({ length: modules }, () => new Array(modules).fill(false));
  const finder = (ox, oy) => {
    for (let y = 0; y < 7; y += 1) {
      for (let x = 0; x < 7; x += 1) {
        const edge = x === 0 || y === 0 || x === 6 || y === 6;
        const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        grid[oy + y][ox + x] = edge || core;
      }
    }
    for (let y = -1; y <= 7; y += 1) {
      for (let x = -1; x <= 7; x += 1) {
        const ty = oy + y;
        const tx = ox + x;
        if (ty < 0 || tx < 0 || ty >= modules || tx >= modules) continue;
        if (x === -1 || y === -1 || x === 7 || y === 7) grid[ty][tx] = false;
      }
    }
  };
  finder(0, 0);
  finder(modules - 7, 0);
  finder(0, modules - 7);

  for (let y = 0; y < modules; y += 1) {
    for (let x = 0; x < modules; x += 1) {
      if (grid[y][x]) continue;
      // 定位角周围留白
      const nearFinder =
        (x < 9 && y < 9) || (x > modules - 10 && y < 9) || (x < 9 && y > modules - 10);
      if (nearFinder) continue;
      grid[y][x] = next() > 0.52;
    }
  }

  const size = modules * scale;
  const quiet = scale * 2;
  const total = size + quiet * 2;

  return encodePng(total, total, (px, py) => {
    const x = px - quiet;
    const y = py - quiet;
    if (x < 0 || y < 0 || x >= size || y >= size) return [255, 255, 255, 255];
    const on = grid[Math.floor(y / scale)][Math.floor(x / scale)];
    return on ? [17, 22, 34, 255] : [255, 255, 255, 255];
  });
}
