// Material palette facade.
//
// The authoritative definitions live in the explicitly declared v2 asset pack
// (materialPack.js): color space, channel semantics, fusion contract and weight
// normalization are all declared there. This module keeps the historical
// import surface stable for the kernel, renderer and UI while resolving every
// value through the pack, so there is no second, undeclared source of material
// data to drift out of sync.

import { DEFAULT_MATERIAL_PACK_V2 } from "./materialPack.js";
import { srgbToLinear } from "./math.js";

export const MATERIAL_IDS = DEFAULT_MATERIAL_PACK_V2.materialOrder;

export const MATERIALS = DEFAULT_MATERIAL_PACK_V2.materialOrder.map((id) => {
  const m = DEFAULT_MATERIAL_PACK_V2.materials[id];
  return {
    id,
    label: m.label,
    swatch: m.swatch,
    // Historical field name; the pack explicitly declares this as sRGB.
    albedo: m.albedoSrgb,
    roughness: m.roughness,
    normalScale: m.normalScale,
    metallic: m.metallic,
    detailScale: m.detailScale,
  };
});

export const MATERIAL_BY_ID = Object.fromEntries(MATERIALS.map((m) => [m.id, m]));

// Linear-light albedo per material, used by the reference rasterizer and shader.
export const MATERIAL_LINEAR = Object.fromEntries(
  MATERIALS.map((m) => [m.id, srgbToLinear(m.albedo)])
);

// Fallback when every weight is zero. Resolved from the pack's declared fusion
// contract ("neutral basalt") so the result can never be undefined/black.
export const FALLBACK_MATERIAL_ID = DEFAULT_MATERIAL_PACK_V2.contract.fallback.materialId;
export const FALLBACK_WEIGHT_FRACTION = DEFAULT_MATERIAL_PACK_V2.contract.fallback.weight;

export function materialIndex(id) {
  return MATERIAL_IDS.indexOf(id);
}
