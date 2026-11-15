// Terrain-fusion kernel.
//
// Single source of truth for:
//   * procedural height fields (slopes, gullies, plateaus, cliff, chunk edge)
//   * per-sample material weights from slope, altitude and manual painting
//   * weight normalization, including the documented all-zero fallback
//   * color / roughness / normal composition
//   * chunked mesh generation and memory accounting
//
// Pure ES module: no DOM, no WebGL, no clock. Shared by the browser app, the
// UI controls (schema-driven) and the Node test suite.

import {
  clamp,
  saturate,
  smoothstep,
  smootherstep,
  fbm,
  ridgedFbm,
  srgbToLinear,
  dot3,
  cross3,
  normalize3,
} from "./math.js";
import { MATERIAL_IDS, MATERIAL_BY_ID, FALLBACK_MATERIAL_ID } from "./materials.js";

export const WEIGHTS_PER_VERTEX = 4; // rock, soil, vegetation, vertex flag
export const SKIRT_FLAG = 2;
export const FALLBACK_FLAG = 1;

export const DEFAULT_HEIGHT_PARAMS = {
  seed: 1337,
  worldSize: 512,
  maxHeight: 120,
  relief: 1.0,
  ridgeScale: 4,
  gullyScale: 9,
  gullyDepth: 17,
  plateauAmount: 0.45,
  plateauEdge: 0.22,
  detailAmount: 0.1,
  detailScale: 14,
  warp: 0.22,
  cliffStrength: 0.5,
  valleyStrength: 0.5,
  chunkEdgeStrength: 0.0,
  clampHeight: true,
};

export const DEFAULT_MATERIAL_RULES = {
  slopeStart: 0.42,
  slopeEnd: 0.82,
  lowAltitude: 0.12,
  highAltitude: 0.55,
  altitudeBlend: 0.22,
  manual: { rock: 0, soil: 0, vegetation: 0 },
  vegetationSlopeLimit: 0.6,
  zeroWeightPatch: { enabled: false, u: 0.34, v: 0.52, radius: 0.11 },
};

export const DEFAULT_MAPPING = {
  // 0 = triplanar (world space), 1 = planar XZ (stretch on walls),
  // 2 = mesh UV (grid-relative, slides with subdivision). Triplanar is default.
  mode: 0,
  metersPerTile: 6.5,
  sharpness: 5.0,
  normalStrength: 1.0,
  anisotropy: 8,
};

export const DEFAULT_RENDER = {
  exposure: 1.0,
  sunAzimuth: 138,
  sunElevation: 42,
  sunIntensity: 1.05,
  ambient: 0.4,
  fogDensity: 0.00042,
  sunColor: [1.0, 0.94, 0.84],
  skyColor: [0.4, 0.55, 0.8],
};

export const DEFAULT_VIEW = {
  targetX: 0,
  targetZ: 20,
  distance: 860,
  yaw: 0.62,
  pitch: 0.56,
  fov: 50,
};

export const DEFAULT_QUALITY = {
  lod: 192,
  chunks: 1,
  textureSize: 512,
  debugMode: "final",
  showWireframe: false,
  showChunkBounds: false,
};

export const DEBUG_MODES = [
  { id: "final", label: "最终光照结果 Final lit" },
  { id: "weights", label: "权重 RGB Weights" },
  { id: "rock", label: "岩石权重 Rock" },
  { id: "soil", label: "土壤权重 Soil" },
  { id: "vegetation", label: "植被权重 Vegetation" },
  { id: "fallback", label: "零权重回退 Zero-weight fallback" },
  { id: "normal", label: "法线 Normals" },
  { id: "slope", label: "坡度 Slope" },
  { id: "altitude", label: "海拔 Altitude" },
  { id: "chunks", label: "分块边界 Chunk bounds" },
];

// ---------------------------------------------------------------------------
// Height field
// ---------------------------------------------------------------------------

export function normalizeHeightParams(input = {}) {
  const p = { ...DEFAULT_HEIGHT_PARAMS, ...input };
  return {
    seed: Math.floor(Number.isFinite(p.seed) ? p.seed : DEFAULT_HEIGHT_PARAMS.seed),
    worldSize: clamp(Number(p.worldSize) || DEFAULT_HEIGHT_PARAMS.worldSize, 64, 4096),
    maxHeight: clamp(Number(p.maxHeight) || DEFAULT_HEIGHT_PARAMS.maxHeight, 1, 1200),
    relief: clamp(Number.isFinite(p.relief) ? p.relief : 1, 0, 1),
    ridgeScale: clamp(Number(p.ridgeScale) || 4, 1, 12),
    gullyScale: clamp(Number(p.gullyScale) || 9, 1, 24),
    gullyDepth: clamp(Number(p.gullyDepth) || 0, 0, 80),
    plateauAmount: clamp(Number(p.plateauAmount) || 0, 0, 1),
    plateauEdge: clamp(Number(p.plateauEdge) || 0.22, 0.02, 0.7),
    detailAmount: clamp(Number(p.detailAmount) || 0, 0, 0.4),
    detailScale: clamp(Number(p.detailScale) || 14, 2, 40),
    warp: clamp(Number.isFinite(p.warp) ? p.warp : 0.22, 0, 0.6),
    cliffStrength: clamp(Number(p.cliffStrength) || 0, 0, 1),
    valleyStrength: clamp(Number(p.valleyStrength) || 0, 0, 1),
    chunkEdgeStrength: clamp(Number(p.chunkEdgeStrength) || 0, 0, 1),
    clampHeight: p.clampHeight !== false,
  };
}

// Shared by the main height function and the terrain-fusion validation tools.
// Produces a 0..1.1 "mass" field with domain-warped ridges, erosion channels
// and optional terraced benches.
function baseRelief(px, pz, p) {
  const seed = p.seed;

  // Domain warp: breaks the blobby look of raw fBm and makes ridge lines
  // flow like real drainage divides.
  const wx = fbm(px + 0.17, pz - 0.23, { octaves: 4, frequency: 3, seed: seed + 11 }) - 0.5;
  const wz = fbm(px - 0.41, pz + 0.33, { octaves: 4, frequency: 3, seed: seed + 27 }) - 0.5;
  const qx = px + wx * p.warp;
  const qz = pz + wz * p.warp;

  const ridge = ridgedFbm(qx, qz, {
    octaves: 5,
    frequency: Math.round(p.ridgeScale),
    gain: 0.42,
    seed,
  });
  const hills = fbm(qx + 0.5, qz + 0.5, {
    octaves: 4,
    frequency: Math.max(1, Math.round(p.ridgeScale * 0.55)),
    gain: 0.45,
    seed: seed + 5,
  });
  const mass = smoothstep(0.18, 0.95, ridge);
  let h = Math.pow(mass, 1.2) * 0.78 + hills * 0.22;

  // Erosion network: narrow channels along ridged-noise lines. Strength scales
  // with valleyStrength and the channel depth UI control.
  const plane = 1 - ridgedFbm(qx - 0.3, qz + 0.2, {
    octaves: 3,
    frequency: Math.round(p.gullyScale),
    gain: 0.45,
    seed: seed + 61,
  });
  const channel = Math.pow(saturate(plane), 4);
  h -= channel * (p.gullyDepth / p.maxHeight) * 1.8 * p.valleyStrength;

  // Benches with smooth risers.
  if (p.plateauAmount > 0) {
    const steps = 5;
    const cell = h * steps;
    const frac = cell - Math.floor(cell);
    const riser = smoothstep(1 - p.plateauEdge, 1, frac);
    const terraced = (Math.floor(cell) + riser) / steps;
    const mix = p.plateauAmount * smoothstep(0.2, 0.55, h);
    h = h * (1 - mix) + terraced * mix;
  }

  // Fine relief.
  if (p.detailAmount > 0) {
    const detail = fbm(px, pz, {
      octaves: 3,
      frequency: Math.round(p.detailScale),
      gain: 0.4,
      seed: seed + 211,
    }) - 0.5;
    h += detail * p.detailAmount * 0.35;
  }

  // Designed cliff escarpment (a near-vertical band around u = 0.72) so the
  // steep mapping case is always present and testable.
  if (p.cliffStrength > 0) {
    const cliffX = smoothstep(0.66, 0.7, px) * smoothstep(0.78, 0.74, px);
    h += p.cliffStrength * cliffX * 0.55;
  }

  return h;
}

// Height in meters at normalized world position (u,v in [0,1] across worldSize).
export function sampleHeightField(u, v, rawParams = {}) {
  const p = normalizeHeightParams(rawParams);
  const px = clamp(u, 0, 1);
  const pz = clamp(v, 0, 1);
  let h = baseRelief(px, pz, p);

  // Wide valley floor (keeps the lower half walkable and shows soil/vegetation).
  if (p.valleyStrength > 0) {
    const valley = 1 - smoothstep(0.0, 0.2, Math.abs(pz - 0.66));
    h -= p.valleyStrength * valley * 0.16;
  }

  // Ridges along the outer chunk edges (optional, used by the chunk-edge test).
  if (p.chunkEdgeStrength > 0) {
    const ex = Math.min(px, 1 - px);
    const ez = Math.min(pz, 1 - pz);
    const edge = 1 - smoothstep(0.0, 0.03, Math.min(ex, ez));
    h += p.chunkEdgeStrength * edge * 0.12;
  }

  let meters = h * p.maxHeight * p.relief;
  if (p.clampHeight) meters = clamp(meters, 0, p.maxHeight * 1.2);
  return meters;
}

// Normal in world space from central differences, in meters.
export function sampleHeightNormal(u, v, params = {}, epsilon = 1 / 512) {
  const p = normalizeHeightParams(params);
  const e = epsilon;
  const hL = sampleHeightField(u - e, v, p);
  const hR = sampleHeightField(u + e, v, p);
  const hD = sampleHeightField(u, v - e, p);
  const hU = sampleHeightField(u, v + e, p);
  const dx = (hR - hL) / (2 * e * p.worldSize);
  const dz = (hU - hD) / (2 * e * p.worldSize);
  return normalize3([-dx, 1, -dz]);
}

// Camera orbit target height. In this app the terrain is authored so that its
// mid-slope band sits around 35-45% of maxHeight; aiming a little above that
// keeps the whole hillside in frame for the default view.
export function terrainFocusHeight(params) {
  const p = normalizeHeightParams(params);
  return p.maxHeight * 0.34;
}

// Keeps the orbit camera above the surface. Returns the adjusted eye position
// and whether a correction happened (surfaced in the HUD).
export function liftCameraAboveTerrain(eye, params, clearance = 18) {
  const p = normalizeHeightParams(params);
  const u = eye[0] / p.worldSize + 0.5;
  const v = eye[2] / p.worldSize + 0.5;
  const inside = u >= 0 && u <= 1 && v >= 0 && v <= 1;
  const ground = inside ? sampleHeightField(u, v, p) : 0;
  const minY = ground + clearance;
  if (eye[1] < minY) return { eye: [eye[0], minY, eye[2]], corrected: true };
  return { eye, corrected: false };
}

export function slopeFromNormal(normal) {
  return saturate(1 - normal[1]);
}

// ---------------------------------------------------------------------------
// Material weights
// ---------------------------------------------------------------------------

export function normalizeMaterialRules(input = {}) {
  const base = DEFAULT_MATERIAL_RULES;
  const source = input || {};
  const manualIn = source.manual || {};
  const manual = {};
  for (const id of MATERIAL_IDS) {
    manual[id] = clamp(Number.isFinite(manualIn[id]) ? manualIn[id] : 0, 0, 1);
  }
  const patchIn = source.zeroWeightPatch || {};
  return {
    slopeStart: clamp(Number(source.slopeStart ?? base.slopeStart), 0, 0.97),
    slopeEnd: clamp(Number(source.slopeEnd ?? base.slopeEnd), 0.02, 1),
    lowAltitude: clamp(Number(source.lowAltitude ?? base.lowAltitude), 0, 0.95),
    highAltitude: clamp(Number(source.highAltitude ?? base.highAltitude), 0, 1),
    altitudeBlend: clamp(Number(source.altitudeBlend ?? base.altitudeBlend), 0.01, 0.9),
    manual,
    vegetationSlopeLimit: clamp(Number(source.vegetationSlopeLimit ?? base.vegetationSlopeLimit), 0, 1),
    zeroWeightPatch: {
      enabled: !!patchIn.enabled,
      u: clamp(Number.isFinite(patchIn.u) ? patchIn.u : 0.34, 0, 1),
      v: clamp(Number.isFinite(patchIn.v) ? patchIn.v : 0.52, 0, 1),
      radius: clamp(Number.isFinite(patchIn.radius) ? patchIn.radius : 0.11, 0.01, 0.5),
    },
  };
}

// Raw (pre-normalization) weights and derived diagnostics.
//
//   slopeTerm    = smoothstep(slopeStart, slopeEnd, slope)
//   flatTerm     = 1 - slopeTerm
//   nLow/nMid/nHigh = normalized altitude bands
//   manual       = additive override, 0..1 x 3.2
//
// The zero-weight patch multiplies every raw term (manual included) by a
// smooth mask, producing an exactly-zero core where the fallback must engage.
export function evaluateRawWeights(normal, heightMeters, params, rules) {
  const r = normalizeMaterialRules(rules);
  const maxHeight = normalizeHeightParams(params).maxHeight;
  const slope = slopeFromNormal(normal);
  const alt = saturate(heightMeters / Math.max(1, maxHeight));

  const slopeTerm = smoothstep(r.slopeStart, r.slopeEnd, slope);
  const flatTerm = 1 - slopeTerm;

  const aLow = 1 - smoothstep(r.lowAltitude, r.lowAltitude + r.altitudeBlend, alt);
  const aHigh = smoothstep(r.highAltitude - r.altitudeBlend, r.highAltitude, alt);
  const aMid = Math.max(0, 1 - aLow - aHigh);
  const bandSum = aLow + aMid + aHigh;
  const nLow = bandSum > 1e-8 ? aLow / bandSum : 0;
  const nMid = bandSum > 1e-8 ? aMid / bandSum : 0;
  const nHigh = bandSum > 1e-8 ? aHigh / bandSum : 0;

  const vegSlope = 1 - smoothstep(r.vegetationSlopeLimit, r.vegetationSlopeLimit + 0.18, slope);

  // Analytic base weights. Slope drives rock hard; altitude bands modulate soil
  // (valley floors) and bare rock (summits); vegetation only on gentler ground.
  let rock = 0.05 + slopeTerm * 1.35 + nHigh * 0.75;
  let soil = 0.10 + flatTerm * (0.45 + nLow * 1.15 + nMid * 0.55) * 1.05;
  let vegetation = 0.12 + flatTerm * vegSlope * (nMid * 1.25 + nLow * 0.7) * 1.5;

  rock += r.manual.rock * 3.2;
  soil += r.manual.soil * 3.2;
  vegetation += r.manual.vegetation * 3.2;

  return {
    rock,
    soil,
    vegetation,
    slope,
    altitude: alt,
    slopeTerm,
    flatTerm,
    altitudeBands: { low: nLow, mid: nMid, high: nHigh },
    vegetationSlopeMask: vegSlope,
    manual: { ...r.manual },
    patch: { ...r.zeroWeightPatch },
  };
}

// Normalize weights to sum 1. If the sum is non-finite or <= epsilon, return
// the documented fallback distribution (rock = 1) plus a flag.
// This is the ONLY place zero-sum is resolved, so every consumer agrees.
export function normalizeWeights(rawWeights, fallbackId = FALLBACK_MATERIAL_ID) {
  const values = {};
  let sum = 0;
  for (const id of MATERIAL_IDS) {
    const v = Number(rawWeights?.[id]);
    const sanitized = Number.isFinite(v) && v > 0 ? v : 0;
    values[id] = sanitized;
    sum += sanitized;
  }
  if (!(sum > 1e-8) || !Number.isFinite(sum)) {
    const w = {};
    for (const id of MATERIAL_IDS) w[id] = 0;
    w[fallbackId] = 1;
    return { weights: w, sum: 0, normalized: false, fallback: true };
  }
  const w = {};
  for (const id of MATERIAL_IDS) w[id] = values[id] / sum;
  return { weights: w, sum, normalized: true, fallback: false };
}

// Full per-sample evaluation. `u`,`v` normalized [0,1] world coordinates.
export function evaluateSample(u, v, params, rules) {
  const r = normalizeMaterialRules(rules);
  const p = normalizeHeightParams(params);
  const height = sampleHeightField(u, v, p);
  const normal = sampleHeightNormal(u, v, p);
  const raw = evaluateRawWeights(normal, height, p, r);

  const patch = r.zeroWeightPatch;
  let zeroMask = 1;
  if (patch.enabled) {
    const d = Math.hypot(u - patch.u, v - patch.v);
    zeroMask = smoothstep(patch.radius * 0.45, patch.radius, d);
  }
  raw.rock *= zeroMask;
  raw.soil *= zeroMask;
  raw.vegetation *= zeroMask;
  raw.zeroMask = zeroMask;

  const norm = normalizeWeights({
    rock: raw.rock,
    soil: raw.soil,
    vegetation: raw.vegetation,
  });
  return { u, v, height, normal, raw, zeroMask, ...norm };
}

// ---------------------------------------------------------------------------
// Composition: color, roughness, normal
// ---------------------------------------------------------------------------

// Color blend in LINEAR light. Values are never treated as encoded display
// bytes; callers encode only for UI previews.
export function composeAlbedoLinear(weights) {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const id of MATERIAL_IDS) {
    const w = weights?.[id] || 0;
    if (w <= 0) continue;
    const c = MATERIAL_BY_ID[id].albedo;
    const lin = srgbToLinear(c);
    r += lin[0] * w;
    g += lin[1] * w;
    b += lin[2] * w;
  }
  return [r, g, b];
}

// Roughness blends linearly in perceptual roughness space.
export function composeRoughness(weights) {
  let rough = 0;
  for (const id of MATERIAL_IDS) rough += (MATERIAL_BY_ID[id].roughness || 0) * (weights?.[id] || 0);
  return clamp(rough, 0.02, 1);
}

// Normal composition: whiteout (reoriented) blend. `detailNormals` are WORLD
// space unit normals per material. Each contribution is sheet-projected onto a
// tangent frame around the geometric normal, weighted, summed, renormalized,
// and flipped to the surface hemisphere when needed.
//
// Encoded tangent-space colors are decoded by the caller (see textures.js /
// the shader), never averaged as world normals.
export function composeNormalWorld(weights, geomNormal, detailNormals) {
  const base = normalize3(geomNormal);
  const up = Math.abs(base[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let t = normalize3(cross3(up, base));
  let bt = normalize3(cross3(base, t));
  let x = 0;
  let y = 0;
  let z = 0;
  for (const id of MATERIAL_IDS) {
    const w = weights?.[id] || 0;
    if (w <= 0) continue;
    const d = detailNormals && detailNormals[id] ? normalize3(detailNormals[id], [0, 0, 1]) : [0, 0, 1];
    const dx = dot3(d, t) * w;
    const dy = dot3(d, bt) * w;
    const dz = Math.max(dot3(d, base), 0.02);
    x += t[0] * dx + bt[0] * dy + base[0] * dz * w;
    y += t[1] * dx + bt[1] * dy + base[1] * dz * w;
    z += t[2] * dx + bt[2] * dy + base[2] * dz * w;
  }
  const blended = normalize3([x, y, z], base);
  if (dot3(blended, base) < 0) {
    blended[0] = -blended[0];
    blended[1] = -blended[1];
    blended[2] = -blended[2];
  }
  return blended;
}

// ---------------------------------------------------------------------------
// Mesh generation
// ---------------------------------------------------------------------------

// Builds one chunk. `range` = {u0,u1,v0,v1} normalized. Global vertex indices
// keep boundary vertices of adjacent chunks numerically identical, so chunk
// borders share exact positions/normals/weights and cannot crack.
//
// A vertical skirt is appended around the chunk perimeter down to a fixed base
// plane, flagged per-vertex so the shader shades it as flat dark rock. It is in
// the same buffer (separate index range) so the block reads solid at grazing
// angles without a second draw program.
export function buildTerrainChunk(options = {}) {
  const {
    segments = 192,
    chunks = 1,
    chunkX = 0,
    chunkZ = 0,
    params = DEFAULT_HEIGHT_PARAMS,
    rules = DEFAULT_MATERIAL_RULES,
  } = options;
  const p = normalizeHeightParams(params);
  const r = normalizeMaterialRules(rules);
  const seg = Math.max(2, Math.floor(segments));
  const c = Math.max(1, Math.floor(chunks));
  const u0 = chunkX / c;
  const u1 = (chunkX + 1) / c;
  const v0 = chunkZ / c;
  const v1 = (chunkZ + 1) / c;
  const nx = seg;
  const nz = seg;
  const width = nx + 1;
  const gridVerts = width * (nz + 1);
  // Skirt: a top ring duplicating perimeter positions at terrain height and a
  // bottom ring at the base plane. Both rings are flagged SKIRT_FLAG so the
  // wall quads interpolate only between skirt vertices (no textured bleed).
  const perimeter = 2 * (nx + nz);
  const vertCount = gridVerts + perimeter * 2;
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const weights = new Float32Array(vertCount * WEIGHTS_PER_VERTEX);
  const skirtDepth = Math.max(8, p.maxHeight * 0.26);
  let fallbackCount = 0;
  let sumError = 0;

  for (let iz = 0; iz <= nz; iz++) {
    const gz = chunkZ * seg + iz;
    const v = gz / (seg * c);
    for (let ix = 0; ix <= nx; ix++) {
      const gx = chunkX * seg + ix;
      const u = gx / (seg * c);
      const i = iz * width + ix;
      const height = sampleHeightField(u, v, p);
      positions[i * 3] = (u - 0.5) * p.worldSize;
      positions[i * 3 + 1] = height;
      positions[i * 3 + 2] = (v - 0.5) * p.worldSize;
      uvs[i * 2] = u;
      uvs[i * 2 + 1] = v;

      const normal = sampleHeightNormal(u, v, p);
      normals[i * 3] = normal[0];
      normals[i * 3 + 1] = normal[1];
      normals[i * 3 + 2] = normal[2];

      const raw = evaluateRawWeights(normal, height, p, r);
      const patch = r.zeroWeightPatch;
      let mask = 1;
      if (patch.enabled) {
        mask = smoothstep(patch.radius * 0.45, patch.radius, Math.hypot(u - patch.u, v - patch.v));
      }
      const norm = normalizeWeights({
        rock: raw.rock * mask,
        soil: raw.soil * mask,
        vegetation: raw.vegetation * mask,
      });
      weights[i * 4] = norm.weights.rock;
      weights[i * 4 + 1] = norm.weights.soil;
      weights[i * 4 + 2] = norm.weights.vegetation;
      weights[i * 4 + 3] = norm.fallback ? FALLBACK_FLAG : 0;
      if (norm.fallback) fallbackCount++;
      sumError = Math.max(sumError, Math.abs(norm.weights.rock + norm.weights.soil + norm.weights.vegetation - 1));
    }
  }

  // Skirt vertices
  const perimeterIndices = [];
  for (let ix = 0; ix < nx; ix++) perimeterIndices.push(ix); // top row (iz = 0)
  for (let iz = 0; iz < nz; iz++) perimeterIndices.push(iz * width + nx); // right col
  for (let ix = nx; ix > 0; ix--) perimeterIndices.push(nz * width + ix); // bottom row
  for (let iz = nz; iz > 0; iz--) perimeterIndices.push(iz * width); // left col
  const skirtStart = gridVerts;
  const perimeterCount = perimeterIndices.length;
  const centreX = ((u0 + u1) / 2 - 0.5) * p.worldSize;
  const centreZ = ((v0 + v1) / 2 - 0.5) * p.worldSize;
  for (let k = 0; k < perimeterCount; k++) {
    const src = perimeterIndices[k];
    const top = skirtStart + k;
    const bot = skirtStart + perimeterCount + k;
    const px = positions[src * 3];
    const pz = positions[src * 3 + 2];
    const ox = px - centreX;
    const oz = pz - centreZ;
    const len = Math.hypot(ox, oz) || 1;
    const nxv = ox / len;
    const nzv = oz / len;
    for (const [dst, y] of [[top, positions[src * 3 + 1]], [bot, -skirtDepth]]) {
      positions[dst * 3] = px;
      positions[dst * 3 + 1] = y;
      positions[dst * 3 + 2] = pz;
      normals[dst * 3] = nxv;
      normals[dst * 3 + 1] = 0;
      normals[dst * 3 + 2] = nzv;
      uvs[dst * 2] = uvs[src * 2];
      uvs[dst * 2 + 1] = uvs[src * 2 + 1];
      weights[dst * 4] = 1;
      weights[dst * 4 + 1] = 0;
      weights[dst * 4 + 2] = 0;
      // Vertex flag channel: 0 = normal surface, 1 = all-zero fallback,
      // 2 = skirt/base geometry. The shader uses this to shade the skirt flat.
      weights[dst * 4 + 3] = SKIRT_FLAG;
    }
  }

  const surfaceIndexCount = nx * nz * 6;
  const indices = new Uint32Array(surfaceIndexCount + perimeterCount * 6);
  let o = 0;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const a = iz * width + ix;
      const b = a + 1;
      const d = a + width;
      const e = d + 1;
      indices[o++] = a;
      indices[o++] = d;
      indices[o++] = b;
      indices[o++] = b;
      indices[o++] = d;
      indices[o++] = e;
    }
  }
  for (let k = 0; k < perimeterCount; k++) {
    const next = (k + 1) % perimeterCount;
    const topA = skirtStart + k;
    const topB = skirtStart + next;
    const botA = skirtStart + perimeterCount + k;
    const botB = skirtStart + perimeterCount + next;
    indices[o++] = topA;
    indices[o++] = botA;
    indices[o++] = topB;
    indices[o++] = topB;
    indices[o++] = botA;
    indices[o++] = botB;
  }

  // Grid line overlay (visualizes actual mesh subdivision).
  const lineIndices = new Uint32Array((nx + 1) * nz * 2 * 2 + (nz + 1) * nx * 2 * 2);
  o = 0;
  for (let iz = 0; iz <= nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const a = iz * width + ix;
      lineIndices[o++] = a;
      lineIndices[o++] = a + 1;
    }
  }
  for (let ix = 0; ix <= nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      const a = iz * width + ix;
      lineIndices[o++] = a;
      lineIndices[o++] = a + width;
    }
  }

  return {
    positions,
    normals,
    uvs,
    weights,
    indices,
    lineIndices,
    vertexCount: vertCount,
    triangleCount: nx * nz * 2 + perimeterCount * 2,
    surfaceTriangleCount: nx * nz * 2,
    skirtTriangleCount: perimeterCount * 2,
    skirtStart,
    fallbackCount,
    maxWeightSumError: sumError,
    range: { u0, u1, v0, v1 },
    segments: seg,
  };
}

// All chunks for a state. `chunks` = 1 renders a single mesh.
export function buildTerrainMeshes(options = {}) {
  const chunks = Math.max(1, Math.min(4, Math.floor(options.chunks || 1)));
  const meshes = [];
  for (let cz = 0; cz < chunks; cz++) {
    for (let cx = 0; cx < chunks; cx++) {
      meshes.push(buildTerrainChunk({ ...options, chunks, chunkX: cx, chunkZ: cz }));
    }
  }
  return {
    meshes,
    chunks,
    segments: Math.max(2, Math.floor(options.segments || 192)),
    vertexCount: meshes.reduce((n, m) => n + m.vertexCount, 0),
    triangleCount: meshes.reduce((n, m) => n + m.triangleCount, 0),
    fallbackCount: meshes.reduce((n, m) => n + m.fallbackCount, 0),
    maxWeightSumError: meshes.reduce((e, m) => Math.max(e, m.maxWeightSumError), 0),
  };
}

// Bytes for the arrays actually held in CPU memory.
export function meshMemory(build) {
  let positionBytes = 0;
  let normalBytes = 0;
  let uvBytes = 0;
  let weightBytes = 0;
  let indexBytes = 0;
  let lineBytes = 0;
  for (const m of build.meshes) {
    positionBytes += m.positions.byteLength;
    normalBytes += m.normals.byteLength;
    uvBytes += m.uvs.byteLength;
    weightBytes += m.weights.byteLength;
    indexBytes += m.indices.byteLength;
    lineBytes += m.lineIndices.byteLength;
  }
  const cpuBytes = positionBytes + normalBytes + uvBytes + weightBytes + indexBytes + lineBytes;
  const gpuBytes = positionBytes + normalBytes + weightBytes + indexBytes + lineBytes;
  return {
    vertexCount: build.vertexCount,
    triangleCount: build.triangleCount,
    chunks: build.chunks,
    positionBytes,
    normalBytes,
    uvBytes,
    weightBytes,
    indexBytes,
    lineBytes,
    cpuBytes,
    gpuBytes,
    bytesPerVertexCpu: build.vertexCount > 0 ? cpuBytes / build.vertexCount : 0,
  };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "–";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

// ---------------------------------------------------------------------------
// State validation / failure feedback
// ---------------------------------------------------------------------------

export function validateState(state = {}) {
  const warnings = [];
  const params = normalizeHeightParams(state.height || {});
  const rules = normalizeMaterialRules(state.rules || {});
  if (rules.slopeEnd <= rules.slopeStart + 0.01) {
    warnings.push({
      code: "slope-band",
      message: `坡度区间无效 (start ${rules.slopeStart} ≥ end ${rules.slopeEnd})，内核已将区间收窄到 0.01。`,
    });
    rules.slopeEnd = Math.min(1, rules.slopeStart + 0.02);
    if (rules.slopeEnd <= rules.slopeStart) rules.slopeStart = Math.max(0, rules.slopeEnd - 0.02);
  }
  if (rules.highAltitude <= rules.lowAltitude + 0.02) {
    warnings.push({
      code: "altitude-band",
      message: `海拔区间无效 (low ${rules.lowAltitude} ≥ high ${rules.highAltitude})，内核已下移低海拔阈值。`,
    });
    rules.highAltitude = Math.min(1, rules.lowAltitude + 0.05);
    if (rules.highAltitude <= rules.lowAltitude) rules.lowAltitude = Math.max(0, rules.highAltitude - 0.05);
  }
  const quality = {
    ...DEFAULT_QUALITY,
    ...(state.quality || {}),
  };
  quality.lod = Math.max(8, Math.min(512, Math.floor(quality.lod)));
  quality.chunks = Math.max(1, Math.min(4, Math.floor(quality.chunks)));
  const candidates = [256, 512, 1024];
  if (!candidates.includes(quality.textureSize)) quality.textureSize = 512;
  if (!DEBUG_MODES.some((d) => d.id === quality.debugMode)) quality.debugMode = "final";

  const mapping = { ...DEFAULT_MAPPING, ...(state.mapping || {}) };
  mapping.mode = [0, 1, 2].includes(mapping.mode) ? mapping.mode : 0;
  mapping.metersPerTile = clamp(Number(mapping.metersPerTile) || 6.5, 0.5, 64);
  mapping.sharpness = clamp(Number(mapping.sharpness) || 5, 0.5, 24);
  mapping.normalStrength = clamp(Number(mapping.normalStrength) || 0, 0, 3);
  mapping.anisotropy = clamp(Number(mapping.anisotropy) || 8, 1, 16);

  const view = { ...DEFAULT_VIEW, ...(state.view || {}) };
  for (const key of ["targetX", "targetZ", "distance", "yaw", "pitch", "fov"]) {
    const n = Number(view[key]);
    view[key] = Number.isFinite(n) ? n : DEFAULT_VIEW[key];
  }
  view.distance = clamp(view.distance, 20, 2000);
  view.pitch = clamp(view.pitch, 0.05, 1.45);
  view.fov = clamp(view.fov, 25, 90);

  const render = { ...DEFAULT_RENDER, ...(state.render || {}) };
  render.exposure = clamp(Number(render.exposure) || 1, 0.1, 4);
  render.sunAzimuth = clamp(Number(render.sunAzimuth) || 135, 0, 360);
  render.sunElevation = clamp(Number(render.sunElevation) ?? 38, 2, 88);
  render.sunIntensity = clamp(Number(render.sunIntensity) || 2.5, 0, 8);
  render.ambient = clamp(Number(render.ambient) || 0, 0, 1);
  render.fogDensity = clamp(Number(render.fogDensity) || 0, 0, 0.02);

  const textureBytesEstimate = 3 * 2 * mipBytes(quality.textureSize);
  if (quality.lod >= 384) {
    warnings.push({
      code: "mesh-memory",
      message: `高细分级 (${quality.lod}×${quality.lod}) 叠加 ${quality.chunks}×${quality.chunks} 分块，GPU 网格约 ${formatBytes(
        4 * quality.chunks * quality.chunks * (quality.lod + 1) * (quality.lod + 1) * 10
      )}。`,
    });
  }

  return {
    warnings,
    height: params,
    rules,
    mapping,
    view,
    render,
    quality,
    memoryEstimate: { textureBytes: textureBytesEstimate },
  };
}

function mipBytes(size, texels = 4) {
  let total = 0;
  for (let s = size; s >= 1; s = Math.floor(s / 2)) {
    total += s * s * texels;
    if (s === 1) break;
  }
  return total;
}

// Convenience for the zero-weight validation: deterministic fallback color.
export function fallbackSampleColor() {
  const norm = normalizeWeights({ rock: 0, soil: 0, vegetation: 0 });
  return {
    weights: norm.weights,
    linear: composeAlbedoLinear(norm.weights),
    roughness: composeRoughness(norm.weights),
    normal: normalize3([0, 1, 0]),
    fallback: norm.fallback,
  };
}
