// ===== Grimoire — QR code generator =====
// Byte mode (UTF-8), error correction level M, versions 1-40, automatic mask choice.
// Follows the algorithm of Project Nayuki's "QR Code generator" library (MIT), trimmed to what is needed here.

// For level M: error correction codewords per block and number of blocks, by version (index 0 unused)
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
  26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCK_COUNTS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const FORMAT_BITS_M = 0;

const bit = (value, i) => ((value >>> i) & 1) !== 0;

function dataModules(version) {
  let total = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2;
    total -= (25 * alignments - 10) * alignments - 55;
    if (version >= 7) total -= 36;
  }
  return total;
}

const dataCodewords = (version) => Math.floor(dataModules(version) / 8) - ECC_PER_BLOCK[version] * BLOCK_COUNTS[version];

// --- Reed-Solomon over GF(2^8), polynomial 0x11D ---
function multiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function divisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = multiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = multiply(root, 0x02);
  }
  return result;
}

function remainder(data, div) {
  const result = div.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    div.forEach((coefficient, i) => { result[i] ^= multiply(coefficient, factor); });
  }
  return result;
}

// --- data encoding ---
function codewords(text) {
  const byte = [...new TextEncoder().encode(text)];
  let version = 1;
  for (; version <= 40; version++) {
    const countBits = version <= 9 ? 8 : 16;
    if (byte.length < 2 ** countBits && 4 + countBits + byte.length * 8 <= dataCodewords(version) * 8) break;
  }
  if (version > 40) throw new Error("Text too long for a QR code.");

  const bits = [];
  const appendBits = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  appendBits(0b0100, 4);
  appendBits(byte.length, version <= 9 ? 8 : 16);
  byte.forEach((b) => appendBits(b, 8));
  const capacity = dataCodewords(version) * 8;
  appendBits(0, Math.min(4, capacity - bits.length));
  appendBits(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) appendBits(pad, 8);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));

  // blocks with error correction, then interleaved
  const blockCount = BLOCK_COUNTS[version];
  const blockEcc = ECC_PER_BLOCK[version];
  const totalCodewords = Math.floor(dataModules(version) / 8);
  const shortBlocks = blockCount - (totalCodewords % blockCount);
  const shortLength = Math.floor(totalCodewords / blockCount);
  const div = divisor(blockEcc);
  const blocks = [];
  for (let i = 0, k = 0; i < blockCount; i++) {
    const part = data.slice(k, k + shortLength - blockEcc + (i < shortBlocks ? 0 : 1));
    k += part.length;
    const ecc = remainder(part, div);
    if (i < shortBlocks) part.push(0);
    blocks.push(part.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLength - blockEcc || j >= shortBlocks) result.push(block[i]);
    });
  }
  return { version, data: result };
}

// --- matrix ---
class Matrix {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }

  setFixed(x, y, dark) {
    this.modules[y][x] = dark;
    this.reserved[y][x] = true;
  }

  drawPatterns() {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.setFixed(6, i, i % 2 === 0);
      this.setFixed(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          const x = cx + dx, y = cy + dy;
          if (x >= 0 && x < n && y >= 0 && y < n) this.setFixed(x, y, distance !== 2 && distance !== 4);
        }
      }
    }
    const positions = this.alignmentPositions();
    const count = positions.length;
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < count; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === count - 1) || (i === count - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) this.setFixed(positions[i] + dx, positions[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
    this.drawFormat(0);
    this.drawVersion();
  }

  alignmentPositions() {
    if (this.version === 1) return [];
    const count = Math.floor(this.version / 7) + 2;
    const step = this.version === 32 ? 26 : Math.ceil((this.version * 4 + 4) / (count * 2 - 2)) * 2;
    const result = [6];
    for (let position = this.size - 7; result.length < count; position -= step) result.splice(1, 0, position);
    return result;
  }

  drawFormat(mask) {
    const data = (FORMAT_BITS_M << 3) | mask;
    let r = data;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const bits = ((data << 10) | r) ^ 0x5412;
    const n = this.size;
    for (let i = 0; i <= 5; i++) this.setFixed(8, i, bit(bits, i));
    this.setFixed(8, 7, bit(bits, 6));
    this.setFixed(8, 8, bit(bits, 7));
    this.setFixed(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFixed(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.setFixed(n - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.setFixed(8, n - 15 + i, bit(bits, i));
    this.setFixed(8, n - 8, true);
  }

  drawVersion() {
    if (this.version < 7) return;
    let r = this.version;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const bits = (this.version << 12) | r;
    for (let i = 0; i < 18; i++) {
      const a = this.size - 11 + (i % 3), b = Math.floor(i / 3);
      this.setFixed(a, b, bit(bits, i));
      this.setFixed(b, a, bit(bits, i));
    }
  }

  drawData(data) {
    const n = this.size;
    let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < n; vertical++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const y = ((right + 1) & 2) === 0 ? n - 1 - vertical : vertical;
          if (!this.reserved[y][x] && i < data.length * 8) {
            this.modules[y][x] = bit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  mask(number) {
    const formulas = [
      (x, y) => (x + y) % 2 === 0,
      (x, y) => y % 2 === 0,
      (x) => x % 3 === 0,
      (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
      (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
      (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
    ];
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.reserved[y][x] && formulas[number](x, y)) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  // Standard penalties: long runs, 2x2 blocks, fake finder patterns, light/dark imbalance
  penalty() {
    const n = this.size;
    const m = this.modules;
    let points = 0;
    const lines = [];
    for (let i = 0; i < n; i++) {
      lines.push(m[i]);
      lines.push(m.map((row) => row[i]));
    }
    const pattern = [true, false, true, true, true, false, true];
    for (const line of lines) {
      let length = 1;
      for (let i = 1; i <= n; i++) {
        if (i < n && line[i] === line[i - 1]) length++;
        else {
          if (length >= 5) points += length - 2;
          length = 1;
        }
      }
      for (let i = 0; i + 7 <= n; i++) {
        if (!pattern.every((value, k) => line[i + k] === value)) continue;
        const lightBefore = i >= 4 && [1, 2, 3, 4].every((k) => !line[i - k]);
        const lightAfter = i + 11 <= n && [7, 8, 9, 10].every((k) => !line[i + k]);
        if (lightBefore || lightAfter) points += 40;
      }
    }
    let darkCount = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (m[y][x]) darkCount++;
        if (x + 1 < n && y + 1 < n && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) points += 3;
      }
    }
    const total = n * n;
    points += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
    return points;
  }
}

/** QR code matrix: array of rows of booleans (true = dark module). */
export function qrMatrix(text) {
  const { version, data } = codewords(text);
  const matrix = new Matrix(version);
  matrix.drawPatterns();
  matrix.drawData(data);
  let best = 0;
  let minimum = Infinity;
  for (let number = 0; number < 8; number++) {
    matrix.mask(number);
    matrix.drawFormat(number);
    const points = matrix.penalty();
    if (points < minimum) {
      minimum = points;
      best = number;
    }
    matrix.mask(number); // the mask is an XOR: applying it again removes it
  }
  matrix.mask(best);
  matrix.drawFormat(best);
  return matrix.modules;
}

/** QR code as SVG, with the 4-module white quiet zone required by the standard. */
export function qrSvg(text, label = text) {
  const modules = qrMatrix(text);
  const size = modules.length + 8;
  const path = [];
  modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) path.push(`M${x + 4} ${y + 4}h1v1h-1z`); }));
  const safeText = String(label).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code: ${safeText}">
    <rect width="${size}" height="${size}" fill="#fff"/><path d="${path.join("")}" fill="#000"/></svg>`;
}
