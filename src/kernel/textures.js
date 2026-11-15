// Procedural material texture generation.
//
// Two 512^2 RGBA8 textures per material:
//   * albedo+roughness: RGB = sRGB albedo, A = linear roughness
//   * normal:           RGB = tangent-space normal (encoded 0..1), A = height
//
// All noise fields are periodic on [0,1), so the textures tile seamlessly with
// GL_REPEAT. Normal maps are built from a height field with wrapped central
// differences, so their decoded normals are unit-length everywhere (edge rows
// included). Nothing here samples a canvas or DOM.

import { fbm, ridgedFbm, valueNoise2, clamp, saturate, normalize3 } from "./math.js";
import { MATERIAL_BY_ID, MATERIALS, MATERIAL_LINEAR } from "./materials.js";

export const DEFAULT_TEXTURE_SIZE = 512;
export const TEXTURE_SIZE_OPTIONS = [256, 512, 1024];

function materialHeight(id, u, v, seed) {
  switch (id) {
    case "rock": {
      const base = fbm(u, v, { octaves: 5, frequency: 8, periodic: true, seed });
      const shattered = ridgedFbm(u + 0.31, v - 0.17, {
        octaves: 5,
        frequency: 16,
        periodic: true,
        seed: seed + 17,
      });
      // Sharp crack lines from narrow ridged noise ridges.
      const cracks = Math.pow(ridgedFbm(u, v, {
        octaves: 4,
        frequency: 24,
        periodic: true,
        seed: seed + 41,
      }), 10);
      return base * 0.55 + shattered * 0.35 - cracks * 0.55;
    }
    case "soil": {
      const base = fbm(u, v, { octaves: 5, frequency: 6, periodic: true, seed });
      const grains = fbm(u + 0.5, v + 0.25, {
        octaves: 3,
        frequency: 40,
        periodic: true,
        seed: seed + 23,
      });
      const clumps = fbm(u, v, { octaves: 4, frequency: 14, periodic: true, seed: seed + 61 });
      return base * 0.5 + grains * 0.16 + clumps * 0.34;
    }
    case "vegetation": {
      const clumps = fbm(u, v, { octaves: 4, frequency: 7, periodic: true, seed });
      // Anisotropic blades: high X frequency, moderate Y frequency, tileable.
      const blades = fbm(u, v, { octaves: 3, frequency: 28, periodic: true, seed: seed + 19 });
      const fine = valueNoise2(u * 96, v * 24, 96, 24, seed + 77);
      return clumps * 0.55 + blades * 0.3 + fine * 0.15;
    }
    default:
      return fbm(u, v, { octaves: 4, frequency: 8, periodic: true, seed });
  }
}

function shadeAlbedo(id, u, v, h, seed) {
  const base = MATERIAL_BY_ID[id].albedo;
  let r = base[0];
  let g = base[1];
  let b = base[2];
  if (id === "rock") {
    const strata = fbm(u * 0.5, v, { octaves: 3, frequency: 5, periodic: true, seed: seed + 5 });
    const tone = 0.74 + h * 0.55 + strata * 0.18;
    r *= tone;
    g *= tone * (0.98 + strata * 0.06);
    b *= tone * (0.96 + strata * 0.05);
    // Darker fissures where the height field is low.
    const fissure = saturate((0.32 - h) * 2.6);
    r *= 1 - fissure * 0.55;
    g *= 1 - fissure * 0.55;
    b *= 1 - fissure * 0.52;
    // Sparse lichen flecks.
    const fleck = saturate((valueNoise2(u * 64, v * 64, 64, 64, seed + 33) - 0.82) * 6);
    r += fleck * 0.05;
    g += fleck * 0.075;
    b += fleck * 0.04;
  } else if (id === "soil") {
    const tone = 0.72 + h * 0.62;
    r *= tone;
    g *= tone * 0.97;
    b *= tone * 0.92;
    const pebble = saturate((valueNoise2(u * 48, v * 48, 48, 48, seed + 67) - 0.72) * 3.4);
    r += pebble * 0.13;
    g += pebble * 0.1;
    b += pebble * 0.07;
    const damp = saturate((fbm(u, v, { octaves: 3, frequency: 9, periodic: true, seed: seed + 89 }) - 0.55) * 2.4);
    r *= 1 - damp * 0.22;
    g *= 1 - damp * 0.18;
    b *= 1 - damp * 0.12;
  } else if (id === "vegetation") {
    const tone = 0.6 + h * 0.85;
    const dry = fbm(u + 0.2, v - 0.3, { octaves: 3, frequency: 11, periodic: true, seed: seed + 43 });
    r = base[0] * tone * (0.8 + dry * 0.55) * 1.15;
    g = base[1] * tone * (0.85 + dry * 0.3);
    b = base[2] * tone * (0.7 + dry * 0.2);
    // Darker mossy pockets.
    const pocket = saturate((0.4 - h) * 2.2);
    r *= 1 - pocket * 0.3;
    g *= 1 - pocket * 0.22;
    b *= 1 - pocket * 0.18;
  }
  return [saturate(r), saturate(g), saturate(b)];
}

// Builds one material's two RGBA8 maps. Returns typed arrays + statistics.
export function generateMaterialTextures(materialId, size = DEFAULT_TEXTURE_SIZE, seed = 1337) {
  const material = MATERIAL_BY_ID[materialId];
  if (!material) throw new Error(`unknown material: ${materialId}`);
  const n = Math.max(64, Math.min(2048, Math.floor(size)));
  const height = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const v = y / n;
    for (let x = 0; x < n; x++) {
      height[y * n + x] = materialHeight(materialId, x / n, v, seed + MATERIALS.findIndex((m) => m.id === materialId) * 977);
    }
  }
  // Normalize height range to [0,1] so material recipes can differ freely.
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < height.length; i++) {
    if (height[i] < min) min = height[i];
    if (height[i] > max) max = height[i];
  }
  const inv = max - min > 1e-6 ? 1 / (max - min) : 0;
  for (let i = 0; i < height.length; i++) height[i] = (height[i] - min) * inv;

  const albedoRough = new Uint8Array(n * n * 4);
  const normalMap = new Uint8Array(n * n * 4);
  const normalStrength = 2.4 * material.normalScale * (n / 512);
  let roughSum = 0;
  let normalLenSum = 0;
  let normalZMin = 1;

  for (let y = 0; y < n; y++) {
    const v = y / n;
    const yUp = (y - 1 + n) % n;
    const yDown = (y + 1) % n;
    for (let x = 0; x < n; x++) {
      const u = x / n;
      const i = y * n + x;
      const h = height[i];
      const hL = height[y * n + ((x - 1 + n) % n)];
      const hR = height[y * n + ((x + 1) % n)];
      const hD = height[yUp * n + x];
      const hU = height[yDown * n + x];
      const ux = hR - hL;
      const uy = hU - hD;

      const [ar, ag, ab] = shadeAlbedo(materialId, u, v, h, seed);
      const roughNoise = fbm(u + 0.11, v + 0.73, {
        octaves: 3,
        frequency: 18,
        periodic: true,
        seed: seed + 131,
      });
      const roughness = clamp(material.roughness + (roughNoise - 0.5) * 0.14, 0.05, 1);
      roughSum += roughness;
      albedoRough[i * 4] = Math.round(ar * 255);
      albedoRough[i * 4 + 1] = Math.round(ag * 255);
      albedoRough[i * 4 + 2] = Math.round(ab * 255);
      albedoRough[i * 4 + 3] = Math.round(roughness * 255);

      const nrm = normalize3([-ux * normalStrength, -uy * normalStrength, 1]);
      normalLenSum += Math.hypot(nrm[0], nrm[1], nrm[2]);
      if (nrm[2] < normalZMin) normalZMin = nrm[2];
      normalMap[i * 4] = Math.round((nrm[0] * 0.5 + 0.5) * 255);
      normalMap[i * 4 + 1] = Math.round((nrm[1] * 0.5 + 0.5) * 255);
      normalMap[i * 4 + 2] = Math.round((nrm[2] * 0.5 + 0.5) * 255);
      normalMap[i * 4 + 3] = Math.round(h * 255);
    }
  }

  return {
    materialId,
    size: n,
    albedoRough,
    normalMap,
    stats: {
      meanRoughness: roughSum / (n * n),
      meanNormalLength: normalLenSum / (n * n),
      minNormalZ: normalZMin,
      baseAlbedoLinear: MATERIAL_LINEAR[materialId].slice(),
    },
  };
}

// Bytes for one RGBA8 texture including its full mip chain.
export function mipChainBytes(size, bytesPerTexel = 4) {
  let total = 0;
  let s = Math.max(1, Math.floor(size));
  while (s >= 1) {
    total += s * s * bytesPerTexel;
    if (s === 1) break;
    s = Math.floor(s / 2);
  }
  return total;
}

// Actual resident texture bytes for a material (2 textures, mipmapped).
export function materialTextureBytes(size) {
  return 2 * mipChainBytes(size);
}

// Decode an encoded normal texel to a unit vector (used by tests / reference).
export function decodeNormalTexel(r, g, b) {
  return normalize3([(r / 255) * 2 - 1, (g / 255) * 2 - 1, (b / 255) * 2 - 1]);
}
