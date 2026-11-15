// Joint migration of legacy (asset v1) material textures and fusion configs to
// the explicitly declared v2 material pack format.
//
// The converter works on real texture bytes plus the legacy config object; it
// never fabricates success from defaults:
//   * a missing texture channel is reconstructed with a declared default and
//     every such repair is recorded in `report.channelsFilled`,
//   * legacy defaults that differ from v2 (notably the divergent GPU shader
//     coefficients) are converted, not silently reinterpreted, and recorded in
//     `report.defaultsConverted`,
//   * semantic preservation is measured from actual fusion weights and
//     boundary texels (see measureSemanticPreservation),
//   * `ok: true` requires the output to be a fully declared v2 pack whose
//     shading path matches its channel declarations. A metadata-only bump with
//     legacy channel interpretation is rejected (see assertPackIsV2).
//
// Pure ES module: usable from Node (CLI/tests) and the browser UI.

import {
  PACK_ASSET_VERSION,
  LEGACY_PACK_ASSET_VERSION,
  FUSION_CONTRACT_V2,
  LEGACY_GPU_FUSION_CONTRACT_V1,
  WEIGHT_EPSILON,
  NORMALIZE_PARTITION_OF_UNITY,
  COLOR_SPACE_SRGB,
  COLOR_SPACE_LINEAR,
  CHANNEL_ALBEDO,
  CHANNEL_ROUGHNESS,
  CHANNEL_TANGENT_NORMAL,
  CHANNEL_HEIGHT,
  CHANNEL_FUSION_WEIGHT,
  createMaterialPackV2,
  DEFAULT_MATERIAL_PACK_V2,
} from "./materialPack.js";
import {
  normalizeWeights,
  evaluateRawWeights,
  sampleHeightField,
  sampleHeightNormal,
  normalizeMaterialRules,
  normalizeHeightParams,
} from "./terrain.js";
import { srgbToLinear } from "./math.js";

export const MIGRATION_REPAIR = Object.freeze({
  ROUGHNESS_FILLED: "roughness-channel-filled",
  NORMAL_FILLED: "normal-channel-filled",
  HEIGHT_FILLED: "height-channel-filled",
  WEIGHT_CHANNEL_FILLED: "weight-channel-filled",
  ALBEDO_CHANNEL_FILLED: "albedo-channel-filled",
});

export const MIGRATION_STATUS = Object.freeze({
  MIGRATED: "migrated",
  MIGRATED_WITH_REPAIRS: "migrated-with-repairs",
  ALREADY_V2: "already-v2",
  REJECTED: "rejected",
});

// Legacy v1 defaults that differ from v2. Each entry documents the old value
// and what the joint converter maps it to, so old projects keep loading.
export const LEGACY_DEFAULTS_V1 = Object.freeze({
  // v1 textures stored roughness in albedo-map alpha but nothing declared it;
  // v1 normal-map alpha (height) was likewise undeclared.
  textureChannels: {
    albedoRoughness: ["albedo:sRGB", "albedo:sRGB", "albedo:sRGB", "roughness:linear"],
    normal: ["tangentNormal.x:linear", "tangentNormal.y:linear", "tangentNormal.z:linear", "height:linear"],
  },
  // Default roughness used when a legacy albedo texture has no alpha channel at
  // all (e.g. an imported RGB-only PNG).
  missingRoughness: 1.0,
  // Flat tangent normal (128,128,255) and mid height used when the normal map
  // is absent.
  missingNormalTexel: [128, 128, 255, 128],
  // The v1 shader's raw-weight constants diverged from the CPU kernel. v2
  // makes the CPU contract canonical and records the replacement.
  fusionContract: LEGACY_GPU_FUSION_CONTRACT_V1,
  targetFusionContract: FUSION_CONTRACT_V2,
});

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// ---------------------------------------------------------------------------
// Texture channel migration
// ---------------------------------------------------------------------------

// Migrates one legacy RGBA8 texture (or a partial RGB/RGBA map). `presentMask`
// is an array of booleans per channel describing what the source actually
// contains; missing channels are filled with declared, documented defaults and
// the repair is recorded. Returns v2 channel declarations plus the migrated
// byte array and per-channel evidence (boundary texels).
export function migrateTextureChannels(materialId, textureKind, sourceBytes, options = {}) {
  const size = options.size;
  if (!Number.isInteger(size) || size < 1) throw new Error("migrateTextureChannels requires an integer size");
  const channels = sourceBytes && sourceBytes.length === size * size * 4;
  if (!channels && sourceBytes) {
    throw new Error(`legacy ${materialId}/${textureKind} byte length does not match size ${size}`);
  }
  const present = options.presentMask || [true, true, true, true];
  if (!Array.isArray(present) || present.length !== 4) {
    throw new Error("presentMask must list four channels (RGBA)");
  }
  const out = new Uint8Array(size * size * 4);
  const channelsFilled = [];
  const boundaryEvidence = { source: {}, migrated: {} };

  const recordBoundary = (channelIndex, name) => {
    // First and last texel of the top row are boundary pixels; they must stay
    // bit-identical for every channel the source actually provided.
    const first = channelIndex;
    const last = (size - 1) * 4 + channelIndex;
    if (present[channelIndex] && sourceBytes) {
      boundaryEvidence.source[name] = [sourceBytes[first], sourceBytes[last]];
      boundaryEvidence.migrated[name] = [out[first], out[last]];
    }
  };

  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    for (let c = 0; c < 4; c++) {
      if (present[c] && sourceBytes) {
        out[o + c] = sourceBytes[o + c];
      }
    }
  }

  if (textureKind === "albedoRoughness") {
    // RGB albedo (sRGB), A roughness (linear).
    for (let c = 0; c < 3; c++) {
      if (!present[c]) {
        channelsFilled.push({ channel: "RGBA"[c], repair: MIGRATION_REPAIR.ALBEDO_CHANNEL_FILLED });
        const fallback = options.fallbackAlbedoSrgb || DEFAULT_MATERIAL_PACK_V2.materials[materialId].albedoSrgb;
        const byte = Math.round(Math.min(1, Math.max(0, fallback[c])) * 255);
        for (let i = 0; i < size * size; i++) out[i * 4 + c] = byte;
      }
    }
    if (!present[3]) {
      channelsFilled.push({ channel: "A", repair: MIGRATION_REPAIR.ROUGHNESS_FILLED });
      const rough = isFiniteNumber(options.missingRoughness) ? options.missingRoughness : LEGACY_DEFAULTS_V1.missingRoughness;
      const byte = Math.round(Math.min(1, Math.max(0, rough)) * 255);
      for (let i = 0; i < size * size; i++) out[i * 4 + 3] = byte;
    }
    ["R", "G", "B", "A"].forEach((name, c) => recordBoundary(c, name));
    return {
      bytes: out,
      declaration: {
        kind: "albedoRoughness",
        internalFormat: "SRGB8_ALPHA8",
        colorSpace: { rgb: COLOR_SPACE_SRGB, alpha: COLOR_SPACE_LINEAR },
        channels: [
          { name: "R", semantic: CHANNEL_ALBEDO, colorSpace: COLOR_SPACE_SRGB },
          { name: "G", semantic: CHANNEL_ALBEDO, colorSpace: COLOR_SPACE_SRGB },
          { name: "B", semantic: CHANNEL_ALBEDO, colorSpace: COLOR_SPACE_SRGB },
          { name: "A", semantic: CHANNEL_ROUGHNESS, colorSpace: COLOR_SPACE_LINEAR },
        ],
      },
      channelsFilled,
      boundaryEvidence,
    };
  }

  if (textureKind === "normal") {
    for (let c = 0; c < 3; c++) {
      if (!present[c]) {
        channelsFilled.push({ channel: "RGBA"[c], repair: MIGRATION_REPAIR.NORMAL_FILLED });
        const byte = LEGACY_DEFAULTS_V1.missingNormalTexel[c];
        for (let i = 0; i < size * size; i++) out[i * 4 + c] = byte;
      }
    }
    if (!present[3]) {
      channelsFilled.push({ channel: "A", repair: MIGRATION_REPAIR.HEIGHT_FILLED });
      const byte = LEGACY_DEFAULTS_V1.missingNormalTexel[3];
      for (let i = 0; i < size * size; i++) out[i * 4 + 3] = byte;
    }
    ["R", "G", "B", "A"].forEach((name, c) => recordBoundary(c, name));
    return {
      bytes: out,
      declaration: {
        kind: "normal",
        internalFormat: "RGBA8",
        colorSpace: { rgb: COLOR_SPACE_LINEAR, alpha: COLOR_SPACE_LINEAR },
        channels: [
          { name: "R", semantic: CHANNEL_TANGENT_NORMAL, colorSpace: COLOR_SPACE_LINEAR, axis: "x" },
          { name: "G", semantic: CHANNEL_TANGENT_NORMAL, colorSpace: COLOR_SPACE_LINEAR, axis: "y" },
          { name: "B", semantic: CHANNEL_TANGENT_NORMAL, colorSpace: COLOR_SPACE_LINEAR, axis: "z" },
          { name: "A", semantic: CHANNEL_HEIGHT, colorSpace: COLOR_SPACE_LINEAR },
        ],
      },
      channelsFilled,
      boundaryEvidence,
    };
  }

  // Generic weight map (legacy painted weight textures). Every declared channel
  // is a linear fusion weight; absent channels become explicit zero weights.
  for (let c = 0; c < 4; c++) {
    if (!present[c]) {
      channelsFilled.push({ channel: "RGBA"[c], repair: MIGRATION_REPAIR.WEIGHT_CHANNEL_FILLED });
      for (let i = 0; i < size * size; i++) out[i * 4 + c] = 0;
    }
  }
  ["R", "G", "B", "A"].forEach((name, c) => recordBoundary(c, name));
  return {
    bytes: out,
    declaration: {
      kind: "weightMap",
      internalFormat: "RGBA8",
      colorSpace: { rgb: COLOR_SPACE_LINEAR, alpha: COLOR_SPACE_LINEAR },
      channels: [0, 1, 2, 3].map((c) => ({
        name: "RGBA"[c],
        semantic: CHANNEL_FUSION_WEIGHT,
        colorSpace: COLOR_SPACE_LINEAR,
        materialSlot: c,
      })),
    },
    channelsFilled,
    boundaryEvidence,
  };
}

// ---------------------------------------------------------------------------
// Config migration
// ---------------------------------------------------------------------------

// Converts the legacy fusion config (rules + the v1 shader contract) into the
// v2 contract reference. The user-facing rule parameters (slope/altitude
// bands, manual weights, zero-weight patch) carry over unchanged; what changes
// is that the divergent v1 shader constants are replaced by the declared v2
// contract, and every replaced default is reported.
export function migrateFusionConfig(legacyConfig = {}) {
  const defaultsConverted = [];
  const oldContract = legacyConfig.fusionContract || LEGACY_DEFAULTS_V1.fusionContract;
  if (oldContract.contractId !== FUSION_CONTRACT_V2.contractId) {
    defaultsConverted.push({
      path: "fusionContract",
      from: oldContract.contractId,
      to: FUSION_CONTRACT_V2.contractId,
      detail: "v1 GPU shader coefficients diverged from the CPU kernel; v2 uses one declared contract for both.",
    });
  }
  const rules = legacyConfig.rules || {};
  // Legacy projects may omit the zero-weight patch; v1's implicit behavior was
  // "patch disabled". Record the default we materialize instead of pretending
  // the field always existed.
  if (rules.zeroWeightPatch === undefined) {
    defaultsConverted.push({ path: "rules.zeroWeightPatch", from: undefined, to: "{enabled:false,...}", detail: "legacy implicit disabled patch made explicit" });
  }
  if (rules.manual === undefined) {
    defaultsConverted.push({ path: "rules.manual", from: undefined, to: "{rock:0,soil:0,vegetation:0}", detail: "legacy implicit zero manual weights made explicit" });
  }
  return {
    contractId: FUSION_CONTRACT_V2.contractId,
    normalization: NORMALIZE_PARTITION_OF_UNITY,
    weightEpsilon: WEIGHT_EPSILON,
    rules,
    defaultsConverted,
  };
}

// ---------------------------------------------------------------------------
// Semantic preservation evidence
// ---------------------------------------------------------------------------

// Measures how well the migration preserves fusion semantics using the real
// kernel: samples include gentle ground, steep slopes (cliff band) and the
// zero-weight fallback. For each point we compare (a) raw weights under the
// legacy v1 contract vs (b) normalized v2 weights, plus boundary-texel
// identity for migrated textures.
//
// Returns explicit evidence; callers decide thresholds. Nothing here returns a
// default-filled success marker.
export function measureSemanticPreservation(options = {}) {
  const params = options.params || {};
  const rules = options.rules || {};
  const samplePoints = options.samplePoints || [
    { u: 0.5, v: 0.5, label: "mid-slope" },
    { u: 0.3, v: 0.7, label: "flat-valley" },
    { u: 0.74, v: 0.5, label: "cliff-band" },
    { u: 0.68, v: 0.45, label: "steep-face" },
    { u: 0.15, v: 0.85, label: "outer-slope" },
  ];
  const legacyCoef = LEGACY_GPU_FUSION_CONTRACT_V1.coefficients;
  const v2Coef = FUSION_CONTRACT_V2.coefficients;

  function rawWith(normal, height, p, r, coef, manualGain) {
    // Reuse the kernel's band/slope machinery, then apply either the legacy GPU
    // constants or the v2 constants so the comparison exercises both contracts.
    const raw = evaluateRawWeights(normal, height, p, r);
    const bands = raw.altitudeBands;
    const slopeTerm = raw.slopeTerm;
    const flatTerm = raw.flatTerm;
    const vegSlope = raw.vegetationSlopeMask;
    const rock =
      coef.baseRock + slopeTerm * coef.slopeRock + bands.high * coef.highRock + bands.mid * coef.midRock +
      r.manual.rock * manualGain;
    const soil =
      coef.baseSoil + flatTerm * (coef.soilFlat + bands.low * coef.lowSoil + bands.mid * coef.midSoil) * coef.soilGain +
      r.manual.soil * manualGain;
    const veg =
      coef.baseVeg + flatTerm * vegSlope * (bands.mid * coef.midVeg + bands.low * coef.lowVeg) * coef.vegGain +
      r.manual.vegetation * manualGain;
    return { rock, soil, vegetation: veg };
  }

  const p = normalizeHeightParams(params);
  const r = normalizeMaterialRules(rules);

  const points = samplePoints.map((pt) => {
    const normal = sampleHeightNormal(pt.u, pt.v, p);
    const height = sampleHeightField(pt.u, pt.v, p);
    const legacyRaw = rawWith(normal, height, p, r, legacyCoef, LEGACY_GPU_FUSION_CONTRACT_V1.manualGain);
    const v2Raw = rawWith(normal, height, p, r, v2Coef, FUSION_CONTRACT_V2.manualGain);
    const legacyNorm = normalizeWeights(legacyRaw);
    const v2Norm = normalizeWeights(v2Raw);
    const maxDelta = Math.max(
      Math.abs(legacyNorm.weights.rock - v2Norm.weights.rock),
      Math.abs(legacyNorm.weights.soil - v2Norm.weights.soil),
      Math.abs(legacyNorm.weights.vegetation - v2Norm.weights.vegetation)
    );
    return {
      label: pt.label,
      u: pt.u,
      v: pt.v,
      slope: rawSlope(normal),
      legacyWeights: legacyNorm.weights,
      v2Weights: v2Norm.weights,
      maxWeightDelta: maxDelta,
      fallback: v2Norm.fallback,
    };
  });

  const boundaryPixels = (options.textureEvidence || []).map((ev) => ({
    materialId: ev.materialId,
    textureKind: ev.textureKind,
    identical: boundaryIdentical(ev.boundaryEvidence),
    evidence: ev.boundaryEvidence,
  }));

  const steepPoints = points.filter((pt) => pt.slope > 0.25);
  const weightDeltaMean = points.reduce((s, pt) => s + pt.maxWeightDelta, 0) / Math.max(1, points.length);
  return {
    points,
    steepPointCount: steepPoints.length,
    steepLabels: steepPoints.map((pt) => pt.label),
    weightDeltaMean,
    weightDeltaMax: Math.max(...points.map((pt) => pt.maxWeightDelta)),
    boundaryPixels,
    allBoundariesIdentical: boundaryPixels.every((b) => b.identical),
  };
}

function boundaryIdentical(evidence) {
  if (!evidence || !evidence.source || Object.keys(evidence.source).length === 0) return true;
  return Object.keys(evidence.source).every((name) => {
    const a = evidence.source[name];
    const b = evidence.migrated[name];
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  });
}

function rawSlope(normal) {
  return Math.min(1, Math.max(0, 1 - normal[1]));
}

// ---------------------------------------------------------------------------
// Whole-asset joint conversion
// ---------------------------------------------------------------------------

// Strict structural check: a v2 pack must declare asset version 2 AND carry
// channel declarations consistent with the shading path. A file that merely
// bumped its version field while keeping undeclared/legacy channels is rejected
// here, which is what prevents "metadata-only" fake migrations.
export function assertPackIsV2(pack) {
  const problems = [];
  if (!pack || typeof pack !== "object") problems.push("pack is not an object");
  if (pack?.assetVersion !== PACK_ASSET_VERSION) problems.push(`assetVersion is ${pack?.assetVersion}, expected ${PACK_ASSET_VERSION}`);
  if (pack?.contract?.contractId !== FUSION_CONTRACT_V2.contractId) problems.push("fusion contract is not the declared v2 contract");
  if (pack?.contract?.normalization !== NORMALIZE_PARTITION_OF_UNITY) problems.push("weight normalization rule is undeclared");
  for (const id of ["rock", "soil", "vegetation"]) {
    const m = pack?.materials?.[id];
    if (!m?.textures?.albedoRoughness?.channels || !m?.textures?.normal?.channels) {
      problems.push(`material ${id} lacks declared texture channels`);
      continue;
    }
    const alb = m.textures.albedoRoughness;
    if (alb.internalFormat !== "SRGB8_ALPHA8") problems.push(`${id} albedo must be SRGB8_ALPHA8 per declaration`);
    if (alb.channels[3].semantic !== CHANNEL_ROUGHNESS || alb.channels[3].colorSpace !== COLOR_SPACE_LINEAR) {
      problems.push(`${id} alpha must be declared linear roughness`);
    }
    const nrm = m.textures.normal;
    if (nrm.internalFormat !== "RGBA8") problems.push(`${id} normal map must be linear RGBA8`);
    if (nrm.channels.slice(0, 3).some((c) => c.semantic !== CHANNEL_TANGENT_NORMAL)) {
      problems.push(`${id} normal RGB must be declared tangent normals`);
    }
  }
  if (!pack?.weightBuffer?.layout?.some((c) => c.semantic === "vertexFlag")) {
    problems.push("weight buffer layout must declare the vertex-flag channel");
  }
  if (problems.length) {
    const err = new Error(`not a valid v2 material pack: ${problems.join("; ")}`);
    err.problems = problems;
    throw err;
  }
  return true;
}

// Main entry point. `legacyAsset` shape:
//   {
//     assetVersion: 1 | undefined,
//     materials: [{ id, albedo, roughness, normalScale, ... }],
//     textures: { [materialId]: { albedoRoughness: { bytes, size, presentMask },
//                                 normal:         { bytes, size, presentMask } } },
//     config: { rules, fusionContract? }
//   }
export function migrateMaterialAsset(legacyAsset = {}) {
  const report = {
    status: MIGRATION_STATUS.MIGRATED,
    sourceVersion: legacyAsset.assetVersion ?? LEGACY_PACK_ASSET_VERSION,
    targetVersion: PACK_ASSET_VERSION,
    channelsFilled: [],
    defaultsConverted: [],
    textureEvidence: [],
    warnings: [],
    ok: false,
  };

  if (legacyAsset.assetVersion === PACK_ASSET_VERSION) {
    assertPackIsV2(legacyAsset.pack || legacyAsset);
    report.status = MIGRATION_STATUS.ALREADY_V2;
    report.ok = true;
    return { ok: true, pack: legacyAsset.pack || legacyAsset, report };
  }

  let materialRecords = legacyAsset.materials;
  if (!materialRecords) {
    // Only used when the legacy asset omits material records; every use is
    // reported so a default can never masquerade as migrated authoring.
    materialRecords = DEFAULT_MATERIAL_PACK_V2.materialOrder.map((id) => {
      report.warnings.push(`material ${id} record missing; using built-in v1 palette values`);
      const m = DEFAULT_MATERIAL_PACK_V2.materials[id];
      return { id, label: m.label, swatch: m.swatch, albedo: [...m.albedoSrgb], roughness: m.roughness, normalScale: m.normalScale, metallic: m.metallic, detailScale: m.detailScale };
    });
  }

  const pack = createMaterialPackV2(materialRecords);

  // Joint texture migration: channel repairs are collected per material. An
  // entirely absent legacy map is treated as four missing channels (all filled
  // from declared defaults), never as an implicitly complete texture.
  const migratedTextures = {};
  for (const id of pack.materialOrder) {
    migratedTextures[id] = {};
    const legacyTex = legacyAsset.textures?.[id] || {};
    for (const kind of ["albedoRoughness", "normal"]) {
      const src = legacyTex[kind];
      const absent = !src || !src.bytes;
      const migrated = migrateTextureChannels(id, kind, src?.bytes, {
        size: src?.size || legacyAsset.textureSize || 64,
        presentMask: absent ? [false, false, false, false] : src.presentMask,
        missingRoughness: materialRecords.find((m) => m.id === id)?.roughness,
      });
      if (absent) {
        report.warnings.push(`legacy ${id}/${kind} texture missing; all four channels filled from declared v2 defaults`);
      }
      migratedTextures[id][kind] = migrated;
      for (const repair of migrated.channelsFilled) {
        report.channelsFilled.push({ materialId: id, textureKind: kind, ...repair });
      }
      report.textureEvidence.push({ materialId: id, textureKind: kind, boundaryEvidence: migrated.boundaryEvidence });
    }
  }

  const configMigration = migrateFusionConfig(legacyAsset.config);
  report.defaultsConverted = configMigration.defaultsConverted;

  report.semanticPreservation = measureSemanticPreservation({
    params: legacyAsset.config?.params,
    rules: legacyAsset.config?.rules,
    textureEvidence: report.textureEvidence,
  });

  // The output pack must pass the strict v2 check; otherwise the migration is
  // a failure even if bytes were produced.
  try {
    assertPackIsV2(pack);
  } catch (e) {
    report.status = MIGRATION_STATUS.REJECTED;
    report.warnings.push(e.message);
    report.ok = false;
    return { ok: false, pack: null, report, error: e };
  }

  report.status = report.channelsFilled.length || report.defaultsConverted.length
    ? MIGRATION_STATUS.MIGRATED_WITH_REPAIRS
    : MIGRATION_STATUS.MIGRATED;
  report.ok = true;
  return {
    ok: true,
    pack,
    textures: migratedTextures,
    config: { contractId: configMigration.contractId, rules: configMigration.rules },
    report,
  };
}

// Linear albedo helper kept for CLI/UI evidence output.
export function linearAlbedoOf(pack, materialId) {
  return srgbToLinear(pack.materials[materialId].albedoSrgb);
}
