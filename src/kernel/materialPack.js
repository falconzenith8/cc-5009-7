// Explicit terrain material asset packs (asset version 2).
//
// A v2 pack declares, in data rather than in convention:
//   * the color space of every texture channel (sRGB vs linear),
//   * the semantic meaning of every texture channel (albedo / roughness /
//     tangent-normal / height / fusion weight),
//   * the exact fusion contract (raw-weight coefficients, normalization rule,
//     zero-sum fallback) shared byte-for-byte by the CPU kernel and GLSL,
//   * the per-vertex weight buffer layout and its vertex-flag channel.
//
// Loading a texture through anything other than its declared channel map is an
// error, so an asset cannot be "upgraded" by flipping a version field while the
// shading still interprets its channels the legacy way.

import { srgbToLinear } from "./math.js";

export const PACK_ASSET_VERSION = 2;
export const LEGACY_PACK_ASSET_VERSION = 1;

// Color-space identifiers used in channel declarations.
export const COLOR_SPACE_SRGB = "sRGB";
export const COLOR_SPACE_LINEAR = "linear";

// Texture channel semantic identifiers.
export const CHANNEL_ALBEDO = "albedo";
export const CHANNEL_ROUGHNESS = "roughness";
export const CHANNEL_TANGENT_NORMAL = "tangentNormal";
export const CHANNEL_HEIGHT = "height";
export const CHANNEL_FUSION_WEIGHT = "fusionWeight";
export const CHANNEL_UNUSED = "unused";

// Weight normalization contract identifiers.
export const NORMALIZE_PARTITION_OF_UNITY = "partition-of-unity";
export const WEIGHT_EPSILON = 1e-8;

export const MATERIAL_IDS_V2 = ["rock", "soil", "vegetation"];

// The single fusion contract. evaluateRawWeights (terrain.js) and the GLSL
// emitted by glslFusionContract (shaders.js) both consume these coefficients,
// which is what keeps the CPU probe and the GPU pixels in agreement.
export const FUSION_CONTRACT_V2 = Object.freeze({
  contractId: "terrain-fusion-v2-partition-of-unity",
  manualGain: 3.2,
  vegetationSlopeTransition: 0.18,
  weightEpsilon: WEIGHT_EPSILON,
  normalization: NORMALIZE_PARTITION_OF_UNITY,
  // Zero-sum resolution: every material gets 0 except the fallback material.
  fallback: { materialId: "rock", weight: 1.0, label: "neutral basalt" },
  // Raw-weight terms, in the exact order the kernel/shader evaluate them.
  //   rock = baseRock + slopeTerm * slopeRock + nHigh * highRock
  //        + nMid * midRock + manual.rock * manualGain
  //   soil = baseSoil + flatTerm * (soilFlat + nLow * lowSoil + nMid * midSoil)
  //        * soilGain + manual.soil * manualGain
  //   veg  = baseVeg + flatTerm * vegSlope * (nMid * midVeg + nLow * lowVeg)
  //        * vegGain + manual.vegetation * manualGain
  coefficients: Object.freeze({
    baseRock: 0.05,
    slopeRock: 1.35,
    highRock: 0.75,
    midRock: 0.0,
    baseSoil: 0.1,
    soilFlat: 0.45,
    lowSoil: 1.15,
    midSoil: 0.55,
    soilGain: 1.05,
    baseVeg: 0.12,
    midVeg: 1.25,
    lowVeg: 0.7,
    vegGain: 1.5,
  }),
});

// Legacy GPU-only coefficients found in the v1 fragment shader. They never
// matched the CPU kernel; preserved here as migration evidence so the v1 -> v2
// joint converter can record which contract a legacy asset was actually
// rendered with. Do not use for shading in v2.
export const LEGACY_GPU_FUSION_CONTRACT_V1 = Object.freeze({
  contractId: "legacy-gpu-shader-v1-divergent",
  manualGain: 3.2,
  vegetationSlopeTransition: 0.18,
  weightEpsilon: 1e-8,
  normalization: NORMALIZE_PARTITION_OF_UNITY,
  fallback: { materialId: "rock", weight: 1.0 },
  coefficients: Object.freeze({
    baseRock: 0.06,
    slopeRock: 1.25,
    highRock: 0.95,
    midRock: 0.1,
    baseSoil: 0.05,
    soilFlat: 0.3,
    lowSoil: 1.05,
    midSoil: 0.5,
    soilGain: 1.1,
    baseVeg: 0.04,
    midVeg: 0.95,
    lowVeg: 0.55,
    vegGain: 1.2,
  }),
});

function albedoTextureChannels() {
  return [
    { name: "R", semantic: CHANNEL_ALBEDO, colorSpace: COLOR_SPACE_SRGB },
    { name: "G", semantic: CHANNEL_ALBEDO, colorSpace: COLOR_SPACE_SRGB },
    { name: "B", semantic: CHANNEL_ALBEDO, colorSpace: COLOR_SPACE_SRGB },
    { name: "A", semantic: CHANNEL_ROUGHNESS, colorSpace: COLOR_SPACE_LINEAR },
  ];
}

function normalTextureChannels() {
  return [
    { name: "R", semantic: CHANNEL_TANGENT_NORMAL, colorSpace: COLOR_SPACE_LINEAR, axis: "x" },
    { name: "G", semantic: CHANNEL_TANGENT_NORMAL, colorSpace: COLOR_SPACE_LINEAR, axis: "y" },
    { name: "B", semantic: CHANNEL_TANGENT_NORMAL, colorSpace: COLOR_SPACE_LINEAR, axis: "z" },
    { name: "A", semantic: CHANNEL_HEIGHT, colorSpace: COLOR_SPACE_LINEAR },
  ];
}

function materialEntries(materialRecords) {
  return MATERIAL_IDS_V2.map((id) => {
    const record = materialRecords.find((m) => m.id === id);
    if (!record) throw new Error(`material pack is missing material ${id}`);
    return [id, record];
  });
}

// Builds the canonical v2 pack from authored material records. The records
// carry sRGB albedo values (converted to linear only through the declared sRGB
// transfer) and linear scalar parameters.
export function createMaterialPackV2(materialRecords, options = {}) {
  const entries = materialEntries(materialRecords);
  const materials = Object.fromEntries(
    entries.map(([id, m]) => [
      id,
      {
        id,
        label: m.label,
        swatch: m.swatch,
        albedoSrgb: [...m.albedo],
        albedoLinear: srgbToLinear(m.albedo),
        roughness: m.roughness,
        normalScale: m.normalScale,
        metallic: m.metallic,
        detailScale: m.detailScale,
        textures: {
          albedoRoughness: {
            kind: "albedoRoughness",
            internalFormat: "SRGB8_ALPHA8",
            // RGB is hardware-decoded sRGB -> linear on sampling; alpha stays
            // linear and holds perceptual roughness.
            colorSpace: { rgb: COLOR_SPACE_SRGB, alpha: COLOR_SPACE_LINEAR },
            channels: albedoTextureChannels(),
          },
          normal: {
            kind: "normal",
            internalFormat: "RGBA8",
            colorSpace: { rgb: COLOR_SPACE_LINEAR, alpha: COLOR_SPACE_LINEAR },
            channels: normalTextureChannels(),
          },
        },
      },
    ])
  );
  const pack = {
    assetVersion: PACK_ASSET_VERSION,
    packId: options.packId || "terrain-material-pack-default",
    contract: FUSION_CONTRACT_V2,
    weightBuffer: {
      // Per-vertex vec4: three fusion weights plus a discrete vertex flag.
      layout: [
        { index: 0, semantic: CHANNEL_FUSION_WEIGHT, materialId: "rock" },
        { index: 1, semantic: CHANNEL_FUSION_WEIGHT, materialId: "soil" },
        { index: 2, semantic: CHANNEL_FUSION_WEIGHT, materialId: "vegetation" },
        {
          index: 3,
          semantic: "vertexFlag",
          colorSpace: COLOR_SPACE_LINEAR,
          enum: { 0: "surface", 1: "zeroWeightFallback", 2: "skirt" },
        },
      ],
      floatsPerVertex: 4,
      normalization: NORMALIZE_PARTITION_OF_UNITY,
      weightEpsilon: WEIGHT_EPSILON,
    },
    materials,
    materialOrder: MATERIAL_IDS_V2,
  };
  return Object.freeze(pack);
}

// Returns the declared channel declaration for a texture kind + channel name.
// Consumers must resolve semantics through this helper instead of hard-coding
// byte indices, so a channel remap in the asset is impossible to ignore.
export function resolveChannel(pack, materialId, textureKind, channelName) {
  const texture = pack.materials[materialId]?.textures[textureKind];
  if (!texture) throw new Error(`unknown texture ${materialId}/${textureKind}`);
  const channel = texture.channels.find((c) => c.name === channelName);
  if (!channel || channel.semantic === CHANNEL_UNUSED) {
    throw new Error(`channel ${channelName} of ${materialId}/${textureKind} is not declared`);
  }
  return channel;
}

export function fallbackMaterialId(pack = DEFAULT_MATERIAL_PACK_V2) {
  return pack.contract.fallback.materialId;
}

// Authored material records (sRGB albedo, linear scalars) shared by the
// procedural texture generator and the reference rasterizer.
const DEFAULT_MATERIAL_RECORDS = [
  {
    id: "rock",
    label: "岩石 Rock",
    swatch: "#7d7469",
    albedo: [0.48, 0.45, 0.41],
    roughness: 0.84,
    normalScale: 1.15,
    metallic: 0.0,
    detailScale: 1.0,
  },
  {
    id: "soil",
    label: "土壤 Soil",
    swatch: "#7a5636",
    albedo: [0.44, 0.31, 0.20],
    roughness: 0.96,
    normalScale: 0.7,
    metallic: 0.0,
    detailScale: 1.35,
  },
  {
    id: "vegetation",
    label: "植被 Vegetation",
    swatch: "#5c7134",
    albedo: [0.29, 0.4, 0.17],
    roughness: 0.9,
    normalScale: 1.6,
    metallic: 0.0,
    detailScale: 0.78,
  },
];

export const DEFAULT_MATERIAL_PACK_V2 = createMaterialPackV2(DEFAULT_MATERIAL_RECORDS);
