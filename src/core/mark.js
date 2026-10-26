export const MARK_GRID = 96;
const MARK_SEED = 0x584c4e53;
const MARK_SEED_LOCKED = 0x584c4b44;
const SAMPLES_PER_CELL = 3;
export const MARK_THRESHOLD = 6;

function makePattern(seed, n) {
  const p = new Int8Array(n);
  let a = seed >>> 0;
  for (let i = 0; i < n; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    p[i] = ((t ^ (t >>> 14)) >>> 0) & 1 ? 1 : -1;
  }
  return p;
}
const patterns = new Map();
const patternFor = (G, locked = false) => {
  const id = `${G}|${locked}`;
  if (!patterns.has(id)) patterns.set(id, makePattern(locked ? MARK_SEED_LOCKED : MARK_SEED, G * G));
  return patterns.get(id);
};

const bump = (f) => Math.sin(Math.PI * f);

export function applyPresenceMark(img, opts = {}) {
  const { width: W, height: H, data } = img;
  const G = opts.grid ?? MARK_GRID;
  const PATTERN = patternFor(G, !!opts.locked);
  const minAmp = opts.minAmp ?? 1.5;
  const maxAmp = opts.maxAmp ?? 4;
  const texGain = opts.texGain ?? 0.25;
  const knee = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    knee[v] = !opts.lsbSafe ? v : v > 249 ? 249 + (v - 249) * 0.5 : v < 6 ? 3 + v * 0.5 : v;
  }

  const cx = new Int32Array(W);
  const wx = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const u = ((x + 0.5) / W) * G;
    cx[x] = Math.min(G - 1, u | 0);
    wx[x] = bump(u - cx[x]);
  }
  const cy = new Int32Array(H);
  const wy = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    const v = ((y + 0.5) / H) * G;
    cy[y] = Math.min(G - 1, v | 0);
    wy[y] = bump(v - cy[y]);
  }

  const n = G * G;
  const s1 = new Float64Array(n);
  const s2 = new Float64Array(n);
  const cnt = new Float64Array(n);
  for (let y = 0; y < H; y++) {
    const row = cy[y] * G;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const k = row + cx[x];
      s1[k] += l;
      s2[k] += l * l;
      cnt[k]++;
    }
  }
  const amp = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const m = s1[k] / cnt[k];
    const sd = Math.sqrt(Math.max(0, s2[k] / cnt[k] - m * m));
    amp[k] = PATTERN[k] * Math.min(maxAmp, minAmp + texGain * sd);
  }

  for (let y = 0; y < H; y++) {
    const row = cy[y] * G;
    const wyy = wy[y];
    for (let x = 0; x < W; x++) {
      const d = amp[row + cx[x]] * wyy * wx[x];
      const i = (y * W + x) * 4;
      data[i] = knee[data[i]] + d;
      data[i + 1] = knee[data[i + 1]] + d;
      data[i + 2] = knee[data[i + 2]] + d;
    }
  }
  return img;
}

function areaWeights(N, R) {
  const s = N / R;
  const off = new Int32Array(R + 1);
  const idx = [];
  const wt = [];
  const wsum = new Float64Array(R);
  for (let o = 0; o < R; o++) {
    const a = o * s;
    const b = a + s;
    for (let i = Math.floor(a); i < Math.ceil(b) && i < N; i++) {
      const w = Math.min(i + 1, b) - Math.max(i, a);
      if (w <= 0) continue;
      idx.push(i);
      wt.push(w);
      wsum[o] += w;
    }
    off[o + 1] = idx.length;
  }
  return { off, idx: Int32Array.from(idx), wt: Float64Array.from(wt), wsum };
}

function lumaToCanonical(img, R) {
  const { width: W, height: H, data } = img;
  const out = new Float32Array(R * R);
  const tmp = new Float32Array(H * R);
  const hx = areaWeights(W, R);
  const luma = new Float64Array(W);
  for (let y = 0; y < H; y++) {
    for (let x = 0, i = y * W * 4; x < W; x++, i += 4) {
      luma[x] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    for (let ox = 0; ox < R; ox++) {
      let acc = 0;
      for (let j = hx.off[ox]; j < hx.off[ox + 1]; j++) acc += hx.wt[j] * luma[hx.idx[j]];
      tmp[y * R + ox] = acc / hx.wsum[ox];
    }
  }
  const vy = areaWeights(H, R);
  const acc = new Float64Array(R);
  for (let oy = 0; oy < R; oy++) {
    acc.fill(0);
    for (let j = vy.off[oy]; j < vy.off[oy + 1]; j++) {
      const w = vy.wt[j];
      const row = vy.idx[j] * R;
      for (let ox = 0; ox < R; ox++) acc[ox] += w * tmp[row + ox];
    }
    for (let ox = 0; ox < R; ox++) out[oy * R + ox] = acc[ox] / vy.wsum[oy];
  }
  return out;
}

function boxBlur(src, R, r) {
  const tmp = new Float32Array(R * R);
  const out = new Float32Array(R * R);
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += src[y * R + Math.min(R - 1, Math.max(0, x + d))];
      tmp[y * R + x] = s * norm;
    }
  }
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += tmp[Math.min(R - 1, Math.max(0, y + d)) * R + x];
      out[y * R + x] = s * norm;
    }
  }
  return out;
}

export function detectPresenceMark(img, opts = {}) {
  const G = opts.grid ?? MARK_GRID;
  const OPEN = patternFor(G, false);
  const LOCKED = patternFor(G, true);
  const S = opts.samples ?? SAMPLES_PER_CELL;
  const R = G * S;
  if (img.width < G * 2 || img.height < G * 2) return { z: 0, zLocked: 0, marked: false, locked: false };
  const L = lumaToCanonical(img, R);
  const low = boxBlur(L, R, opts.blur ?? 1);

  const tpl = new Float32Array(S);
  for (let s = 0; s < S; s++) tpl[s] = bump((s + 0.5) / S);

  const n = G * G;
  const c = new Float32Array(n);
  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      let acc = 0;
      for (let sy = 0; sy < S; sy++) {
        const row = (gy * S + sy) * R + gx * S;
        for (let sx = 0; sx < S; sx++) {
          acc += (L[row + sx] - low[row + sx]) * tpl[sy] * tpl[sx];
        }
      }
      c[gy * G + gx] = acc;
    }
  }
  const mags = Float32Array.from(c, Math.abs).sort();
  const clip = Math.max(1e-6, 3 * mags[n >> 1]);
  let num = 0;
  let numLocked = 0;
  let den = 0;
  for (let k = 0; k < n; k++) {
    const v = Math.max(-clip, Math.min(clip, c[k]));
    num += OPEN[k] * v;
    numLocked += LOCKED[k] * v;
    den += v * v;
  }
  const norm = den > 0 ? 1 / Math.sqrt(den) : 0;
  const z = num * norm;
  const zLocked = numLocked * norm;
  const best = Math.max(z, zLocked);
  return { z, zLocked, marked: best >= MARK_THRESHOLD, locked: best >= MARK_THRESHOLD && zLocked > z };
}
