// State schema, presets and validation wiring.
//
// Control descriptors are pure data generated HERE, in the kernel layer, so the
// UI is driven by the kernel rather than hard-coding sliders. Every control has
// an explicit range (min/max/step) matching normalize*'s clamping.

import {
  DEFAULT_HEIGHT_PARAMS,
  DEFAULT_MATERIAL_RULES,
  DEFAULT_MAPPING,
  DEFAULT_RENDER,
  DEFAULT_VIEW,
  DEFAULT_QUALITY,
  DEBUG_MODES,
  validateState,
} from "./terrain.js";

export const STATE_VERSION = 3;
export const STORAGE_KEY = "terrain-fusion-preview-state-v3";

export const CONTROL_GROUPS = [
  {
    id: "terrain",
    label: "地形高度场 Height field",
    note: "程序化山坡、沟谷、平台与悬崖；世界尺度与网格细分相互独立。",
    controls: [
      { path: "height.relief", type: "range", label: "整体起伏 Relief", min: 0, max: 1, step: 0.01, decimals: 2 },
      { path: "height.maxHeight", type: "range", label: "最大高度 m", min: 20, max: 500, step: 1, decimals: 0 },
      { path: "height.ridgeScale", type: "range", label: "山脊尺度 Ridge", min: 0.5, max: 6, step: 0.05, decimals: 2 },
      { path: "height.gullyScale", type: "range", label: "沟谷尺度 Gully", min: 0.5, max: 6, step: 0.05, decimals: 2 },
      { path: "height.gullyDepth", type: "range", label: "沟谷深度 m", min: 0, max: 80, step: 1, decimals: 0 },
      { path: "height.plateauAmount", type: "range", label: "平台比例 Plateau", min: 0, max: 1, step: 0.01, decimals: 2 },
      { path: "height.plateauEdge", type: "range", label: "平台边缘锐度", min: 0.02, max: 0.5, step: 0.01, decimals: 2 },
      { path: "height.cliffStrength", type: "range", label: "悬崖强度 Cliff", min: 0, max: 1, step: 0.01, decimals: 2 },
      { path: "height.valleyStrength", type: "range", label: "谷地强度 Valley", min: 0, max: 1, step: 0.01, decimals: 2 },
      { path: "height.detailAmount", type: "range", label: "细节振幅 Detail", min: 0, max: 0.4, step: 0.01, decimals: 2 },
      { path: "height.chunkEdgeStrength", type: "range", label: "分块边缘隆起", min: 0, max: 1, step: 0.01, decimals: 2 },
      { path: "height.seed", type: "range", label: "随机种子 Seed", min: 1, max: 9999, step: 1, decimals: 0 },
      { path: "height.clampHeight", type: "toggle", label: "限制高度到非负范围" },
    ],
  },
  {
    id: "rules",
    label: "材质规则 Material rules",
    note: "坡度、海拔与手工权重的融合。最终权重逐像素归一化；全零时采用文档化默认值。",
    controls: [
      { path: "rules.slopeStart", type: "range", label: "岩石起始坡度", min: 0, max: 0.95, step: 0.01, decimals: 2 },
      { path: "rules.slopeEnd", type: "range", label: "岩石完全坡度", min: 0.02, max: 1, step: 0.01, decimals: 2 },
      { path: "rules.lowAltitude", type: "range", label: "低海拔带阈值", min: 0, max: 0.9, step: 0.01, decimals: 2 },
      { path: "rules.highAltitude", type: "range", label: "高海拔带阈值", min: 0.05, max: 1, step: 0.01, decimals: 2 },
      { path: "rules.altitudeBlend", type: "range", label: "海拔过渡宽度", min: 0.02, max: 0.6, step: 0.01, decimals: 2 },
      { path: "rules.vegetationSlopeLimit", type: "range", label: "植被坡度上限", min: 0, max: 1, step: 0.01, decimals: 2 },
      { path: "rules.manual.rock", type: "range", label: "手工：岩石", min: 0, max: 1, step: 0.01, decimals: 2 },
      { path: "rules.manual.soil", type: "range", label: "手工：土壤", min: 0, max: 1, step: 0.01, decimals: 2 },
      { path: "rules.manual.vegetation", type: "range", label: "手工：植被", min: 0, max: 1, step: 0.01, decimals: 2 },
      { path: "rules.zeroWeightPatch.enabled", type: "toggle", label: "零权重验证区域" },
      { path: "rules.zeroWeightPatch.u", type: "range", label: "零权重区 U", min: 0, max: 1, step: 0.01, decimals: 2 },
      { path: "rules.zeroWeightPatch.v", type: "range", label: "零权重区 V", min: 0, max: 1, step: 0.01, decimals: 2 },
      { path: "rules.zeroWeightPatch.radius", type: "range", label: "零权重区半径", min: 0.02, max: 0.4, step: 0.01, decimals: 2 },
    ],
  },
  {
    id: "mapping",
    label: "贴图映射 Mapping",
    note: "三平面世界空间映射为默认：花纹锚定世界坐标，切换网格细分/移动相机都不会滑动。",
    controls: [
      {
        path: "mapping.mode",
        type: "select",
        label: "映射方式",
        options: [
          { value: 0, label: "三平面 Triplanar（世界空间，默认）" },
          { value: 1, label: "平面 XZ Planar（陡壁拉伸）" },
          { value: 2, label: "网格 UV（随细分滑动，对照）" },
        ],
      },
      { path: "mapping.metersPerTile", type: "range", label: "纹理重复尺度 m/tile", min: 1, max: 32, step: 0.5, decimals: 1 },
      { path: "mapping.sharpness", type: "range", label: "投影混合锐度", min: 1, max: 16, step: 0.1, decimals: 1 },
      { path: "mapping.normalStrength", type: "range", label: "细节法线强度", min: 0, max: 3, step: 0.01, decimals: 2 },
      { path: "mapping.anisotropy", type: "range", label: "各向异性过滤", min: 1, max: 16, step: 1, decimals: 0 },
    ],
  },
  {
    id: "lighting",
    label: "光照 Lighting",
    controls: [
      { path: "render.sunAzimuth", type: "range", label: "太阳方位角°", min: 0, max: 360, step: 1, decimals: 0 },
      { path: "render.sunElevation", type: "range", label: "太阳高度角°", min: 2, max: 88, step: 1, decimals: 0 },
      { path: "render.sunIntensity", type: "range", label: "太阳强度", min: 0, max: 6, step: 0.05, decimals: 2 },
      { path: "render.ambient", type: "range", label: "天空环境光", min: 0, max: 1, step: 0.01, decimals: 2 },
      { path: "render.exposure", type: "range", label: "曝光", min: 0.2, max: 3, step: 0.01, decimals: 2 },
      { path: "render.fogDensity", type: "range", label: "雾密度", min: 0, max: 0.003, step: 0.00005, decimals: 5 },
    ],
  },
  {
    id: "quality",
    label: "网格与性能 Mesh / quality",
    controls: [
      {
        path: "quality.lod",
        type: "select",
        label: "网格细分 LOD",
        options: [64, 96, 128, 192, 256, 320].map((v) => ({ value: v, label: `${v} × ${v}` })),
      },
      { path: "quality.chunks", type: "select", label: "分块数量", options: [1, 2, 3].map((v) => ({ value: v, label: `${v} × ${v} chunks` })) },
      {
        path: "quality.textureSize",
        type: "select",
        label: "纹理分辨率",
        options: [256, 512, 1024].map((v) => ({ value: v, label: `${v}² RGBA8 ×2 ×3` })),
      },
      { path: "quality.showWireframe", type: "toggle", label: "显示网格线" },
      { path: "quality.showChunkBounds", type: "toggle", label: "显示分块边界" },
    ],
  },
  {
    id: "view",
    label: "相机 Camera",
    controls: [
      { path: "view.distance", type: "range", label: "距离 m", min: 40, max: 900, step: 1, decimals: 0 },
      { path: "view.yaw", type: "range", label: "偏航角 rad", min: 0, max: 6.28, step: 0.01, decimals: 2 },
      { path: "view.pitch", type: "range", label: "俯仰角 rad", min: 0.05, max: 1.45, step: 0.01, decimals: 2 },
      { path: "view.fov", type: "range", label: "视场角°", min: 25, max: 90, step: 1, decimals: 0 },
    ],
  },
];

export const DEBUG_MODES_EXPORT = DEBUG_MODES;

export const PRESETS = [
  {
    id: "default",
    label: "默认山坡 Slopes & gullies",
    note: "综合地形：山坡、沟谷、平台及可漫游的斜坡。",
    patch: {},
  },
  {
    id: "plane",
    label: "验证：平地 Plane",
    note: "接近平坦的地表，检查土壤/植被融合与平坦纹理。",
    patch: {
      height: { relief: 0.22, plateauAmount: 0.85, plateauEdge: 0.4, cliffStrength: 0, valleyStrength: 0.12, gullyDepth: 4, detailAmount: 0.05 },
      rules: { slopeStart: 0.06, slopeEnd: 0.3, vegetationSlopeLimit: 0.9 },
      view: { distance: 260, pitch: 0.72, yaw: 0.4 },
    },
  },
  {
    id: "cliff",
    label: "验证：陡壁 Cliff",
    note: "近乎垂直的悬崖，检查三平面映射与法线混合在极端坡度下的表现。",
    patch: {
      height: { relief: 1, cliffStrength: 1, plateauAmount: 0.2, valleyStrength: 0.3 },
      rules: { slopeStart: 0.2, slopeEnd: 0.45 },
      render: { sunAzimuth: 20, sunElevation: 24 },
      view: { targetX: 112, targetZ: -25, distance: 340, pitch: 0.28, yaw: -1.45 },
    },
  },
  {
    id: "chunkEdge",
    label: "验证：分块边缘 Chunk edges",
    note: "3×3 分块与分块边界显示，确认边界处纹理与法线连续、无裂缝。",
    patch: {
      height: { chunkEdgeStrength: 0.45, detailAmount: 0.2 },
      quality: { chunks: 3, showChunkBounds: true, lod: 128 },
      view: { distance: 340, pitch: 0.55, yaw: 0.9 },
    },
  },
  {
    id: "zeroWeights",
    label: "验证：零权重区 Zero weights",
    note: "人为把一块区域的权重压到 0，验证回退默认材质（玄武岩色），结果区绝不出现未定义颜色。",
    patch: {
      rules: {
        zeroWeightPatch: { enabled: true, u: 0.34, v: 0.52, radius: 0.11 },
        manual: { rock: 0, soil: 0, vegetation: 0 },
      },
      quality: { debugMode: "fallback" },
      view: { targetX: -70, targetZ: 0, distance: 220, pitch: 0.5, yaw: 0.35 },
    },
  },
  {
    id: "weights",
    label: "权重视图 Weights RGB",
    note: "R=岩石, G=土壤, B=植被的归一化权重，直接检查融合分布。",
    patch: { quality: { debugMode: "weights" }, view: { distance: 300, pitch: 0.85, yaw: 0.6 } },
  },
];

export function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch === undefined ? base : patch;
  if (typeof base !== "object" || base === null) return patch === undefined ? base : patch;
  if (typeof patch !== "object" || patch === null) return base;
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    out[key] = deepMerge(base[key], patch[key]);
  }
  return out;
}

export function createDefaultState() {
  return {
    version: STATE_VERSION,
    height: { ...DEFAULT_HEIGHT_PARAMS },
    rules: JSON.parse(JSON.stringify(DEFAULT_MATERIAL_RULES)),
    mapping: { ...DEFAULT_MAPPING },
    render: { ...DEFAULT_RENDER, sunColor: [...DEFAULT_RENDER.sunColor], skyColor: [...DEFAULT_RENDER.skyColor] },
    view: { ...DEFAULT_VIEW },
    quality: { ...DEFAULT_QUALITY },
    probe: { u: 0.5, v: 0.5, active: true },
  };
}

export function getPath(obj, path) {
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split(".");
  let cursor = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (typeof cursor[key] !== "object" || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
  return obj;
}

// Applies a patch to a state, then runs the kernel validator so out-of-range
// input produced by the UI (or imported JSON) is corrected with feedback.
export function applyStatePatch(state, patch) {
  const merged = deepMerge(state, patch);
  const validated = validateState(merged);
  return {
    state: {
      version: STATE_VERSION,
      height: validated.height,
      rules: validated.rules,
      mapping: validated.mapping,
      render: validated.render,
      view: validated.view,
      quality: validated.quality,
      probe: merged.probe || { u: 0.5, v: 0.5, active: false },
    },
    warnings: validated.warnings,
    memoryEstimate: validated.memoryEstimate,
  };
}

export function applyPreset(state, presetId) {
  const preset = PRESETS.find((p) => p.id === presetId);
  // Validation presets are self-contained: each starts from the default baseline
  // so switching scenes never inherits a previous scene's patch (e.g. the zero
  // weight region leaking into the weights view).
  const base = createDefaultState();
  if (!preset) return { state: base, warnings: [{ code: "preset", message: `未知预设 ${presetId}` }] };
  return applyStatePatch(base, preset.patch);
}

// Persistence payloads. JSON round-trips through the same validator, so a hand-
// edited file cannot smuggle undefined values into the renderer.
export function serializeState(state) {
  const { state: clean, warnings } = applyStatePatch(createDefaultState(), state);
  return JSON.stringify({ app: "terrain-fusion-preview", version: STATE_VERSION, state: clean, warnings }, null, 2);
}

export function deserializeState(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `JSON 解析失败: ${e.message}` };
  }
  const payload = parsed && typeof parsed === "object" && parsed.state && typeof parsed.state === "object" ? parsed.state : parsed;
  if (!payload || typeof payload !== "object" || !payload.height || !payload.rules) {
    return { ok: false, error: "缺少 height/rules 字段，无法识别为地形融合参数。" };
  }
  const { state, warnings } = applyStatePatch(createDefaultState(), payload);
  return { ok: true, state, warnings };
}

export function buildStateQuerystring(state) {
  const { state: clean } = applyStatePatch(createDefaultState(), state);
  return encodeURIComponent(JSON.stringify(clean));
}
