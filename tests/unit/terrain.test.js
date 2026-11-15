import { test } from "node:test";
import assert from "node:assert/strict";

import * as T from "../../src/kernel/terrain.js";
import * as M from "../../src/kernel/materials.js";
import * as TX from "../../src/kernel/textures.js";

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const srgbToLinearChannel = (c) =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

test("weights always sum to 1 for a large sample of the terrain", () => {
  const N = 32;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const s = T.evaluateSample((i + 0.5) / N, (j + 0.5) / N, {}, T.DEFAULT_MATERIAL_RULES);
      const sum = s.weights.rock + s.weights.soil + s.weights.vegetation;
      assert.ok(close(sum, 1, 1e-9), `sum ${sum}`);
      assert.ok(
        Object.values(s.weights).every((w) => Number.isFinite(w) && w >= 0 && w <= 1)
      );
      assert.equal(s.fallback, false);
      assert.equal(s.normalized, true);
    }
  }
});

test("all-zero weights resolve to the documented rock fallback exactly once", () => {
  const norm = T.normalizeWeights({ rock: 0, soil: 0, vegetation: 0 });
  assert.equal(norm.fallback, true);
  assert.equal(norm.normalized, false);
  assert.equal(norm.sum, 0);
  assert.deepEqual(norm.weights, { rock: 1, soil: 0, vegetation: 0 });

  // Non-finite / negative / missing input must take the same path.
  for (const bad of [
    { rock: NaN, soil: 0, vegetation: 0 },
    { rock: -3, soil: -1, vegetation: 0 },
    {},
    null,
    { rock: Infinity, soil: Infinity, vegetation: Infinity },
    { rock: 0, soil: 0, vegetation: 1e-12 },
  ]) {
    const n = T.normalizeWeights(bad);
    assert.equal(n.fallback, true, JSON.stringify(bad));
    assert.equal(n.weights.rock, 1);
    assert.equal(n.weights.soil, 0);
    assert.equal(n.weights.vegetation, 0);
  }
});

test("fallback color is a defined, non-black rock color", () => {
  const fb = T.fallbackSampleColor();
  assert.equal(fb.fallback, true);
  assert.deepEqual(fb.weights, { rock: 1, soil: 0, vegetation: 0 });
  const [r, g, b] = fb.linear;
  assert.ok(r > 0.05 && g > 0.05 && b > 0.05);
  assert.ok(r < 1 && g < 1 && b < 1);
  assert.ok(fb.roughness > 0.5 && fb.roughness < 1);
  assert.ok(Number.isFinite(fb.normal[2]));
});

test("zero-weight patch zeroes the raw weights and engages the fallback", () => {
  const rules = {
    ...T.DEFAULT_MATERIAL_RULES,
    zeroWeightPatch: { enabled: true, u: 0.34, v: 0.52, radius: 0.11 },
  };
  const centre = T.evaluateSample(0.34, 0.52, {}, rules);
  assert.equal(centre.raw.rock, 0);
  assert.equal(centre.raw.soil, 0);
  assert.equal(centre.raw.vegetation, 0);
  assert.equal(centre.zeroMask, 0);
  assert.equal(centre.fallback, true);
  assert.deepEqual(centre.weights, { rock: 1, soil: 0, vegetation: 0 });
  // The same sample with the patch disabled is a normal, defined blend.
  const normal = T.evaluateSample(0.34, 0.52, {}, T.DEFAULT_MATERIAL_RULES);
  assert.equal(normal.fallback, false);

  // Outside the patch radius the analytic weights are untouched.
  const outside = T.evaluateSample(0.9, 0.9, {}, rules);
  assert.equal(outside.zeroMask, 1);
  assert.equal(outside.fallback, false);
});

test("manual weights change the normalized distribution but never break normalization", () => {
  const u = 0.5;
  const v = 0.5;
  const base = T.evaluateSample(u, v, {}, T.DEFAULT_MATERIAL_RULES);
  const boosted = T.evaluateSample(u, v, {}, {
    ...T.DEFAULT_MATERIAL_RULES,
    manual: { rock: 0, soil: 0, vegetation: 1 },
  });
  assert.ok(boosted.weights.vegetation > base.weights.vegetation);
  const sum = boosted.weights.rock + boosted.weights.soil + boosted.weights.vegetation;
  assert.ok(close(sum, 1, 1e-9));
  assert.equal(boosted.fallback, false);
  assert.ok(boosted.raw.vegetation - base.raw.vegetation > 3.0);
});

test("color is composed in linear light, not from encoded bytes", () => {
  const linear = T.composeAlbedoLinear({ rock: 1, soil: 0, vegetation: 0 });
  const expected = M.MATERIAL_BY_ID.rock.albedo.map(srgbToLinearChannel);
  linear.forEach((c, i) => assert.ok(Math.abs(c - expected[i]) < 1e-9));

  // A 50/50 mix must be the linear average, which differs from the sRGB average.
  const mix = T.composeAlbedoLinear({ rock: 0.5, soil: 0.5, vegetation: 0 });
  const soilLinear = M.MATERIAL_BY_ID.soil.albedo.map(srgbToLinearChannel);
  const linearAverage = 0.5 * expected[0] + 0.5 * soilLinear[0];
  const sRgbAverageA = 0.5 * M.MATERIAL_BY_ID.rock.albedo[0] + 0.5 * M.MATERIAL_BY_ID.soil.albedo[0];
  assert.ok(Math.abs(mix[0] - linearAverage) < 1e-9);
  assert.ok(Math.abs(mix[0] - sRgbAverageA) > 1e-3, "linear and sRGB averages must differ");
});

test("roughness blends linearly in perceptual space", () => {
  const r = T.composeRoughness({ rock: 1, soil: 0, vegetation: 0 });
  assert.ok(close(r, M.MATERIAL_BY_ID.rock.roughness));
  const half = T.composeRoughness({ rock: 0.5, soil: 0.5, vegetation: 0 });
  assert.ok(close(half, 0.5 * M.MATERIAL_BY_ID.rock.roughness + 0.5 * M.MATERIAL_BY_ID.soil.roughness));
});

test("normal composition yields unit-length normals on the surface hemisphere", () => {
  const geom = [0.0, 1.0, 0.0];
  const details = {
    rock: [0.4, 0.8, 0.2],
    soil: [-0.3, 0.9, 0.1],
    vegetation: [0.1, 0.7, -0.5],
  };
  for (const w of [
    { rock: 1, soil: 0, vegetation: 0 },
    { rock: 0, soil: 1, vegetation: 0 },
    { rock: 0.33, soil: 0.33, vegetation: 0.34 },
    { rock: 0.6, soil: 0.4, vegetation: 0 },
  ]) {
    const n = T.composeNormalWorld(w, geom, details);
    const len = Math.hypot(n[0], n[1], n[2]);
    assert.ok(Math.abs(len - 1) < 1e-6, `length ${len}`);
    assert.ok(n[1] > 0, "normal must stay above the surface");
  }

  // Reversed detail normals still must not produce an inverted result.
  const flipped = T.composeNormalWorld(
    { rock: 0.5, soil: 0.5, vegetation: 0 },
    geom,
    { rock: [0, -1, 0], soil: [0, -1, 0], vegetation: [0, -1, 0] }
  );
  assert.ok(flipped[1] >= 0, "hemisphere clamp must keep the normal valid");
  assert.ok(Math.abs(Math.hypot(...flipped) - 1) < 1e-6);
});

test("normal composition orients detail, it does not average encoded colors", () => {
  // If encoded bytes were averaged as world normals, a flat (0,1,0) byte value
  // (128,128,255) would dominate and the result would point almost straight up.
  // A reoriented/whiteout blend instead tilts along the detail normal.
  const geom = [0, 1, 0];
  const tilt = T.composeNormalWorld({ rock: 1, soil: 0, vegetation: 0 }, geom, {
    rock: [0.6, 0.8, 0],
    soil: [0, 1, 0],
    vegetation: [0, 1, 0],
  });
  assert.ok(Math.hypot(tilt[0], tilt[2]) > 0.2, "detail normal must tilt the surface normal");

  // On a steep wall the composed normal must still be a valid direction.
  const wall = T.composeNormalWorld(
    { rock: 0.7, soil: 0.2, vegetation: 0.1 },
    [1, 0.1, 0],
    { rock: [0.2, 0.9, 0.3], soil: [0, 1, 0], vegetation: [-0.2, 0.8, 0.1] }
  );
  assert.ok(Math.abs(Math.hypot(...wall) - 1) < 1e-6);
  assert.ok(Number.isFinite(wall[0]) && Number.isFinite(wall[1]) && Number.isFinite(wall[2]));
});

test("chunk borders are watertight: shared vertices are bit-identical", () => {
  const build = T.buildTerrainMeshes({ segments: 48, chunks: 2 });
  assert.equal(build.meshes.length, 4);
  const m00 = build.meshes[0]; // (chunkX=0, chunkZ=0)
  const m10 = build.meshes[1]; // (chunkX=1, chunkZ=0)
  const width = m00.segments + 1;
  for (let iz = 0; iz <= 48; iz++) {
    const a = iz * width + 48;
    const b = iz * width + 0;
    assert.equal(m00.positions[a * 3], m10.positions[b * 3]);
    assert.equal(m00.positions[a * 3 + 1], m10.positions[b * 3 + 1]);
    assert.equal(m00.positions[a * 3 + 2], m10.positions[b * 3 + 2]);
    assert.equal(m00.normals[a * 3], m10.normals[b * 3]);
    assert.equal(m00.normals[a * 3 + 1], m10.normals[b * 3 + 1]);
    assert.equal(m00.weights[a * 4], m10.weights[b * 4]);
    assert.equal(m00.weights[a * 4 + 1], m10.weights[b * 4 + 1]);
    assert.equal(m00.weights[a * 4 + 2], m10.weights[b * 4 + 2]);
  }
});

test("mesh index buffers are in range and triangle counts are exact", () => {
  const build = T.buildTerrainMeshes({ segments: 32, chunks: 1 });
  for (const m of build.meshes) {
    let maxIndex = 0;
    for (let i = 0; i < m.indices.length; i++) maxIndex = Math.max(maxIndex, m.indices[i]);
    assert.ok(maxIndex < m.vertexCount, `index ${maxIndex} < ${m.vertexCount}`);
    assert.equal(m.indices.length, m.triangleCount * 3);
    assert.equal(m.surfaceTriangleCount + m.skirtTriangleCount, m.triangleCount);
    assert.ok(m.indices.every((v) => Number.isInteger(v) && v >= 0 && v < m.vertexCount));
    // The last vertex flag only ever encodes surface / fallback / skirt.
    let skirtVerts = 0;
    for (let v = 0; v < m.vertexCount; v++) {
      const flag = m.weights[v * 4 + 3];
      assert.ok(flag === 0 || flag === 1 || flag === 2, `flag ${flag}`);
      if (flag === T.SKIRT_FLAG) skirtVerts++;
    }
    assert.equal(skirtVerts, m.vertexCount - m.skirtStart);
  }
});

test("mesh memory accounting sums the real typed-array byte lengths", () => {
  for (const [segments, chunks] of [[32, 1], [64, 2], [96, 3]]) {
    const build = T.buildTerrainMeshes({ segments, chunks });
    const mem = T.meshMemory(build);
    let positions = 0, normals = 0, uvs = 0, weights = 0, indices = 0, lines = 0;
    for (const m of build.meshes) {
      positions += m.positions.byteLength;
      normals += m.normals.byteLength;
      uvs += m.uvs.byteLength;
      weights += m.weights.byteLength;
      indices += m.indices.byteLength;
      lines += m.lineIndices.byteLength;
    }
    assert.equal(mem.positionBytes, positions);
    assert.equal(mem.cpuBytes, positions + normals + uvs + weights + indices + lines);
    assert.equal(mem.gpuBytes, positions + normals + weights + indices + lines);
    assert.equal(mem.vertexCount, build.vertexCount);
    assert.ok(mem.cpuBytes > 0 && mem.gpuBytes > 0);
    assert.ok(mem.cpuBytes > mem.gpuBytes, "CPU keeps UVs, GPU does not upload them");
  }
  const small = T.meshMemory(T.buildTerrainMeshes({ segments: 32, chunks: 1 }));
  const large = T.meshMemory(T.buildTerrainMeshes({ segments: 64, chunks: 1 }));
  assert.ok(large.cpuBytes > small.cpuBytes * 3, "subdivision must change memory");
  const chunked = T.meshMemory(T.buildTerrainMeshes({ segments: 32, chunks: 3 }));
  assert.ok(chunked.cpuBytes > small.cpuBytes, "chunking adds skirt vertices");
});

test("texture memory accounting includes the whole mip chain", () => {
  const expected512 =
    (512 * 512 + 256 * 256 + 128 * 128 + 64 * 64 + 32 * 32 + 16 * 16 + 8 * 8 + 4 * 4 + 2 * 2 + 1) * 4;
  assert.equal(TX.mipChainBytes(512), expected512);
  const expected256 =
    (256 * 256 + 128 * 128 + 64 * 64 + 32 * 32 + 16 * 16 + 8 * 8 + 4 * 4 + 2 * 2 + 1) * 4;
  assert.equal(TX.mipChainBytes(256), expected256);
  // Both maps (albedo+roughness and normal) per material.
  assert.equal(TX.materialTextureBytes(512), 2 * expected512);
});

test("terrain textures tile without a hard seam", () => {
  const size = 128;
  for (const id of ["rock", "soil", "vegetation"]) {
    const g = TX.generateMaterialTextures(id, size, 1337);
    // The wrapped field is continuous at u=0 vs u=1; the last column is one
    // texel before the wrap, so its difference from column 0 should be on the
    // order of an ordinary adjacent-column difference, not a discontinuity.
    let seamDiff = 0;
    let neighbourDiff = 0;
    for (let y = 0; y < size; y++) {
      const row = y * size * 4;
      seamDiff += Math.abs(g.albedoRough[row] - g.albedoRough[row + (size - 1) * 4]);
      neighbourDiff += Math.abs(g.albedoRough[row] - g.albedoRough[row + 4]);
    }
    seamDiff /= size;
    neighbourDiff /= size;
    assert.ok(
      seamDiff <= neighbourDiff * 3 + 10,
      `${id} seam ${seamDiff.toFixed(1)} vs neighbour ${neighbourDiff.toFixed(1)}`
    );
  }
});

test("generated normal maps decode to valid upward tangent normals", () => {
  for (const id of ["rock", "soil", "vegetation"]) {
    const g = TX.generateMaterialTextures(id, 64, 1337);
    let maxLengthError = 0;
    for (let i = 0; i < 64 * 64; i++) {
      const r = g.normalMap[i * 4] / 255 * 2 - 1;
      const gg = g.normalMap[i * 4 + 1] / 255 * 2 - 1;
      const b = g.normalMap[i * 4 + 2] / 255 * 2 - 1;
      const rawLen = Math.hypot(r, gg, b);
      maxLengthError = Math.max(maxLengthError, Math.abs(rawLen - 1));
      assert.ok(b > 0, `${id} texel ${i} encoded z must be positive`);
      const n = TX.decodeNormalTexel(g.normalMap[i * 4], g.normalMap[i * 4 + 1], g.normalMap[i * 4 + 2]);
      assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-6);
      assert.ok(n[2] > 0);
    }
    // Byte quantization accounts for the tiny length error; nothing is inverted.
    assert.ok(maxLengthError < 0.02, `${id} max length error ${maxLengthError}`);
    assert.ok(g.stats.minNormalZ > 0.05, `${id} min z ${g.stats.minNormalZ}`);
    assert.ok(g.stats.meanNormalLength > 0.999);
  }
});

test("height field is deterministic for a given seed", () => {
  const a = T.sampleHeightField(0.37, 0.71, { seed: 42 });
  const b = T.sampleHeightField(0.37, 0.71, { seed: 42 });
  const c = T.sampleHeightField(0.37, 0.71, { seed: 43 });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("height field produces real relief, not a flat plane", () => {
  const N = 48;
  const heights = [];
  const slopes = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u = (i + 0.5) / N;
      const v = (j + 0.5) / N;
      heights.push(T.sampleHeightField(u, v, {}));
      slopes.push(T.slopeFromNormal(T.sampleHeightNormal(u, v, {})));
    }
  }
  const sorted = [...heights].sort((a, b) => a - b);
  const range = sorted[sorted.length - 1] - sorted[0];
  assert.ok(range > 40, `height range ${range} too small`);
  const steep = slopes.filter((s) => s > 0.25).length / slopes.length;
  assert.ok(steep > 0.15, `steep fraction ${steep} too small`);
  assert.ok(slopes.some((s) => s < 0.05), "expected some flat ground");
  // Heights stay within the documented clamp.
  assert.ok(sorted[0] >= 0);
  assert.ok(sorted[sorted.length - 1] <= 120 * 1.2 + 1e-6);
});

test("state validation corrects invalid bands and reports feedback", () => {
  const v = T.validateState({ rules: { slopeStart: 0.9, slopeEnd: 0.1, lowAltitude: 0.8, highAltitude: 0.7 } });
  assert.ok(v.warnings.some((w) => w.code === "slope-band"));
  assert.ok(v.warnings.some((w) => w.code === "altitude-band"));
  assert.ok(v.rules.slopeEnd > v.rules.slopeStart);
  assert.ok(v.rules.highAltitude > v.rules.lowAltitude);
  // Every warning carries a human-readable message for the UI.
  assert.ok(v.warnings.every((w) => typeof w.message === "string" && w.message.length > 0));
});

test("state validation never emits booleans in the view transform", () => {
  const v = T.validateState({ view: { targetX: 1, targetZ: -18, distance: 620, yaw: 0.62, pitch: 0.5, fov: 55 } });
  for (const key of ["targetX", "targetZ", "distance", "yaw", "pitch", "fov"]) {
    assert.equal(typeof v.view[key], "number", key);
  }
  assert.equal(v.view.targetX, 1);
  const d = T.validateState({});
  assert.equal(typeof d.view.distance, "number");
  assert.ok(d.view.distance > 100);
  // Malformed strings must not leak through either.
  const bad = T.validateState({ view: { distance: "far", yaw: null, fov: {} } });
  assert.equal(typeof bad.view.distance, "number");
  assert.equal(typeof bad.view.yaw, "number");
  assert.equal(typeof bad.view.fov, "number");
});

test("state validation clamps out-of-range quality and mapping", () => {
  const v = T.validateState({
    quality: { lod: 100000, chunks: 99, textureSize: 777, debugMode: "bogus" },
    mapping: { mode: 9, metersPerTile: -4, sharpness: 999, normalStrength: -2 },
  });
  assert.ok(v.quality.lod <= 512);
  assert.ok(v.quality.chunks <= 4);
  assert.equal(v.quality.textureSize, 512);
  assert.equal(v.quality.debugMode, "final");
  assert.equal(v.mapping.mode, 0);
  assert.ok(v.mapping.metersPerTile >= 0.5);
  assert.ok(v.mapping.sharpness <= 24);
  assert.equal(v.mapping.normalStrength, 0);
});

test("terrain focus and camera lift keep the eye above the surface", () => {
  const p = { ...T.DEFAULT_HEIGHT_PARAMS };
  const focus = T.terrainFocusHeight(p);
  assert.ok(focus > 0 && focus < p.maxHeight);
  const lifted = T.liftCameraAboveTerrain([0, -100, 0], p, 20);
  assert.equal(lifted.corrected, true);
  assert.ok(lifted.eye[1] >= T.sampleHeightField(0.5, 0.5, p) + 19);
  const high = T.liftCameraAboveTerrain([0, 5000, 0], p, 20);
  assert.equal(high.corrected, false);
});

test("all fallback samples produce defined finite colors in every material mode", () => {
  const fb = T.fallbackSampleColor();
  for (const channel of fb.linear) {
    assert.ok(Number.isFinite(channel) && channel >= 0 && channel <= 1);
  }
  const stub = {
    rock: T.normalizeWeights({ rock: 0 }),
    soil: T.normalizeWeights({ soil: 0 }),
    vegetation: T.normalizeWeights({ vegetation: 0 }),
  };
  for (const id of ["rock", "soil", "vegetation"]) {
    const w = stub[id];
    assert.equal(w.fallback, true);
    const c = T.composeAlbedoLinear(w.weights);
    assert.ok(c.every((v) => Number.isFinite(v) && v >= 0 && v <= 1));
  }
});
