function setPngTrick(pixels) {
  if (pixels.length >= 4) pixels[pixels.length - 1] = 254;
}

function normalizeLensRange(minLensPct, maxLensPct) {
  const min = Math.max(5, Math.min(100, Math.round(minLensPct ?? 15)));
  const max = Math.max(min, Math.min(100, Math.round(maxLensPct ?? 45)));
  return [min, max];
}

function crc16(bytes, len) {
  let crc = 0xffff;
  for (let i = 0; i < len; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

const CRC32_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC32_TABLE[n] = c >>> 0;
}
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const MAGIC_0 = 0x58;
const MAGIC_1 = 0x4c;

const VERSION = 2;
const MODE_JPEG = 2;
const MODE_JPEG_LOCKED = 3;
const FLAG_NO_COPY = 0x80;
const modeByte = (locked, noCopy) => (locked ? MODE_JPEG_LOCKED : MODE_JPEG) | (noCopy ? FLAG_NO_COPY : 0);
const HEADER_BYTES = 20;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const LOCK_OVERHEAD = SALT_BYTES + IV_BYTES + TAG_BYTES;
const PBKDF2_ROUNDS = 600000;
const JPEG_QUALITIES = [0.95, 0.92, 0.88, 0.84, 0.78, 0.7, 0.6, 0.5, 0.4];

export function jpegCapacity(width, height) {
  return Math.max(0, Math.floor(((width * height - 1) * 3) / 8) - HEADER_BYTES);
}

function buildHeader(mode, minLensPct, maxLensPct, width, height, length, fileCrc) {
  const h = new Uint8Array(HEADER_BYTES);
  h.set([MAGIC_0, MAGIC_1, VERSION, mode, minLensPct, maxLensPct]);
  h[6] = width >> 8;
  h[7] = width & 0xff;
  h[8] = height >> 8;
  h[9] = height & 0xff;
  h[10] = length >>> 24;
  h[11] = (length >>> 16) & 0xff;
  h[12] = (length >>> 8) & 0xff;
  h[13] = length & 0xff;
  h[14] = fileCrc >>> 24;
  h[15] = (fileCrc >>> 16) & 0xff;
  h[16] = (fileCrc >>> 8) & 0xff;
  h[17] = fileCrc & 0xff;
  const crc = crc16(h, 18);
  h[18] = crc >> 8;
  h[19] = crc & 0xff;
  return h;
}

function writeBits(out, cover, bit, bytes) {
  let px = (bit / 3) | 0;
  let ch = bit % 3;
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i];
    for (let b = 7; b >= 0; b--) {
      const o = px * 4 + ch;
      out[o] = (cover[o] & 0xfe) | ((v >> b) & 1);
      if (++ch === 3) {
        ch = 0;
        px++;
      }
    }
  }
}

function readBits(pixels, bit, length) {
  const bytes = new Uint8Array(length);
  let px = (bit / 3) | 0;
  let ch = bit % 3;
  for (let i = 0; i < length; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) {
      v = (v << 1) | (pixels[px * 4 + ch] & 1);
      if (++ch === 3) {
        ch = 0;
        px++;
      }
    }
    bytes[i] = v;
  }
  return bytes;
}

export function embedJpegPayload(coverData, bytes, options = {}) {
  const { width, height } = coverData;
  if (bytes.length > jpegCapacity(width, height)) throw new RangeError('payload too large');
  const [minLensPct, maxLensPct] = normalizeLensRange(options.minLensPct, options.maxLensPct);
  const out = new ImageData(width, height);
  const o = out.data;
  o.set(coverData.data);
  for (let i = 3; i < o.length; i += 4) o[i] = 255;
  const mode = modeByte(options.locked, options.noCopy);
  const header = buildHeader(mode, minLensPct, maxLensPct, width, height, bytes.length, crc32(bytes));
  writeBits(o, coverData.data, 0, header);
  writeBits(o, coverData.data, HEADER_BYTES * 8, bytes);
  setPngTrick(o);
  return out;
}

function readHeader(stegoData) {
  const { width, height, data } = stegoData;
  if (width * height * 3 < (HEADER_BYTES + 1) * 8) return null;
  const h = readBits(data, 0, HEADER_BYTES);
  if (h[0] !== MAGIC_0 || h[1] !== MAGIC_1 || h[2] !== VERSION) return null;
  const kind = h[3] & ~FLAG_NO_COPY;
  if (kind !== MODE_JPEG && kind !== MODE_JPEG_LOCKED) return null;
  if (((h[18] << 8) | h[19]) !== crc16(h, 18)) return null;
  if (((h[6] << 8) | h[7]) !== width || ((h[8] << 8) | h[9]) !== height) return null;
  const minLensPct = h[4];
  const maxLensPct = h[5];
  if (minLensPct < 5 || maxLensPct < minLensPct || maxLensPct > 100) return null;
  const length = ((h[10] << 24) | (h[11] << 16) | (h[12] << 8) | h[13]) >>> 0;
  if (length === 0 || length > jpegCapacity(width, height)) return null;
  const fileCrc = ((h[14] << 24) | (h[15] << 16) | (h[16] << 8) | h[17]) >>> 0;
  return { minLensPct, maxLensPct, length, fileCrc, locked: kind === MODE_JPEG_LOCKED, noCopy: !!(h[3] & FLAG_NO_COPY) };
}

export function extractJpegPayload(stegoData) {
  const header = readHeader(stegoData);
  if (!header) return null;
  const bytes = readBits(stegoData.data, HEADER_BYTES * 8, header.length);
  return crc32(bytes) === header.fileCrc ? bytes : null;
}

const keyCache = new Map();
const sessionSalts = new Map();
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function deriveKey(password, salt) {
  const id = `${hex(salt)}|${password}`;
  if (!keyCache.has(id)) {
    const job = crypto.subtle
      .importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
      .then((base) =>
        crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt, iterations: PBKDF2_ROUNDS, hash: 'SHA-256' },
          base,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        )
      );
    job.catch(() => keyCache.delete(id));
    keyCache.set(id, job);
  }
  return keyCache.get(id);
}

async function lockPayload(bytes, password) {
  if (!sessionSalts.has(password)) sessionSalts.set(password, crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
  const salt = sessionSalts.get(password);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(SALT_BYTES + IV_BYTES + sealed.length);
  out.set(salt, 0);
  out.set(iv, SALT_BYTES);
  out.set(sealed, SALT_BYTES + IV_BYTES);
  return out;
}

async function unlockPayload(payload, password) {
  if (payload.length <= LOCK_OVERHEAD) return null;
  const salt = payload.subarray(0, SALT_BYTES);
  const iv = payload.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES);
  try {
    const key = await deriveKey(password, salt.slice());
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, payload.subarray(SALT_BYTES + IV_BYTES)));
  } catch {
    return null;
  }
}

async function compressJpeg(secretData, maxBytes) {
  const canvas = new OffscreenCanvas(secretData.width, secretData.height);
  canvas.getContext('2d').putImageData(secretData, 0, 0);
  for (const quality of JPEG_QUALITIES) {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    if (blob.size <= maxBytes) return { bytes: new Uint8Array(await blob.arrayBuffer()), quality };
  }
  return null;
}

async function decompressJpeg(bytes, width, height) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  return ctx.getImageData(0, 0, width, height);
}

export async function encodeStegoImage(coverData, secretData, options = {}) {
  const password = options.password || '';
  const room = jpegCapacity(coverData.width, coverData.height) - (password ? LOCK_OVERHEAD : 0);
  const jpeg = await compressJpeg(secretData, room);
  if (!jpeg) throw new RangeError('secret image does not fit');
  const payload = password ? await lockPayload(jpeg.bytes, password) : jpeg.bytes;
  const image = embedJpegPayload(coverData, payload, { ...options, locked: !!password });
  return { image, quality: jpeg.quality, bytes: payload.length };
}

export function detectStegoHeader(stegoData) {
  return readHeader(stegoData);
}

export async function decodeStegoImage(stegoData, options = {}) {
  const none = { secretImageData: null, mode: 'none', detectedMinLensPct: null, detectedMaxLensPct: null };
  const header = readHeader(stegoData);
  let bytes = header && extractJpegPayload(stegoData);
  if (!bytes) return none;
  if (header.locked) {
    const locked = {
      secretImageData: null,
      mode: 'locked',
      wrongPassword: false,
      detectedMinLensPct: header.minLensPct,
      detectedMaxLensPct: header.maxLensPct,
      noCopy: header.noCopy,
    };
    if (!options.password) return locked;
    bytes = await unlockPayload(bytes, options.password);
    if (!bytes) return { ...locked, wrongPassword: true };
  }
  try {
    return {
      secretImageData: await decompressJpeg(bytes, stegoData.width, stegoData.height),
      mode: 'jpeg',
      detectedMinLensPct: header.minLensPct,
      detectedMaxLensPct: header.maxLensPct,
      noCopy: header.noCopy,
    };
  } catch {
    return none;
  }
}

export function setLensRange(stegoData, coverData, minLensPct, maxLensPct, noCopy) {
  const header = readHeader(stegoData);
  if (!header) throw new Error('no X-Lens header');
  const [min, max] = normalizeLensRange(minLensPct, maxLensPct);
  const { width, height, data } = stegoData;
  const mode = modeByte(header.locked, noCopy ?? header.noCopy);
  writeBits(data, coverData.data, 0, buildHeader(mode, min, max, width, height, header.length, header.fileCrc));
  return stegoData;
}
