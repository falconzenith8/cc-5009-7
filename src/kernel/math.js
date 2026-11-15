// Deterministic math used by the terrain-fusion kernel and texture generator.
// Everything here is pure: no DOM, no WebGL, no clocks.

export const TAU = Math.PI * 2;
export const EPS = 1e-9;

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function saturate(value) {
  return clamp(value, 0, 1);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function smoothstep(edge0, edge1, x) {
  const d = edge1 - edge0;
  if (Math.abs(d) < EPS) return x < edge0 ? 0 : 1;
  const t = saturate((x - edge0) / d);
  return t * t * (3 - 2 * t);
}

export function smootherstep(edge0, edge1, x) {
  const d = edge1 - edge0;
  if (Math.abs(d) < EPS) return x < edge0 ? 0 : 1;
  const t = saturate((x - edge0) / d);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// 32-bit integer hash -> [0, 1). Integer inputs only; deterministic across engines.
export function hash2i(ix, iy, seed) {
  let h = Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function wrapIndex(v, period) {
  if (period <= 0) return v;
  return ((v % period) + period) % period;
}

// Value noise. periodX/periodY = 0 means non-periodic (world-space use);
// positive integer periods make the field tile exactly after that many cells.
export function valueNoise2(x, y, periodX, periodY, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const x0 = wrapIndex(ix, periodX);
  const y0 = wrapIndex(iy, periodY);
  const x1 = wrapIndex(ix + 1, periodX);
  const y1 = wrapIndex(iy + 1, periodY);
  const a = hash2i(x0, y0, seed);
  const b = hash2i(x1, y0, seed);
  const c = hash2i(x0, y1, seed);
  const d = hash2i(x1, y1, seed);
  const top = a + (b - a) * fx;
  const bottom = c + (d - c) * fx;
  return top + (bottom - top) * fy;
}

// Fractal value noise returning roughly [0, 1].
// `periodic` requires `frequency` to be a positive integer when sampling u,v in [0,1).
export function fbm(x, y, options = {}) {
  const {
    octaves = 4,
    frequency = 1,
    gain = 0.5,
    lacunarity = 2,
    seed = 0,
    periodic = false,
  } = options;
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = frequency;
  for (let o = 0; o < octaves; o++) {
    const px = periodic ? Math.max(1, Math.round(freq)) : 0;
    const py = periodic ? Math.max(1, Math.round(freq)) : 0;
    sum += amp * valueNoise2(x * freq, y * freq, px, py, seed + o * 101);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

// Ridged variant in [0, 1]; useful for rock cracks and erosion veins.
export function ridgedFbm(x, y, options = {}) {
  const {
    octaves = 4,
    frequency = 1,
    gain = 0.5,
    lacunarity = 2,
    seed = 0,
    periodic = false,
  } = options;
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = frequency;
  for (let o = 0; o < octaves; o++) {
    const px = periodic ? Math.max(1, Math.round(freq)) : 0;
    const py = periodic ? Math.max(1, Math.round(freq)) : 0;
    const n = valueNoise2(x * freq, y * freq, px, py, seed + o * 131);
    sum += amp * (1 - Math.abs(n * 2 - 1));
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

// Exact sRGB transfer helpers (IEC 61966-2-1), used for linear-space color blending.
export function srgbToLinearChannel(c) {
  c = saturate(c);
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgbChannel(c) {
  c = saturate(c);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function srgbToLinear(rgb) {
  return [
    srgbToLinearChannel(rgb[0]),
    srgbToLinearChannel(rgb[1]),
    srgbToLinearChannel(rgb[2]),
  ];
}

export function linearToSrgb(rgb) {
  return [
    linearToSrgbChannel(rgb[0]),
    linearToSrgbChannel(rgb[1]),
    linearToSrgbChannel(rgb[2]),
  ];
}

export function normalize3(v, fallback = [0, 1, 0]) {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(len) || len < 1e-8) return fallback.slice();
  return [v[0] / len, v[1] / len, v[2] / len];
}

export function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function quantizeByte(value) {
  return Math.round(saturate(value) * 255);
}
