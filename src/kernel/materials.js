// Material palette for the fusion kernel. Colors are authored in sRGB and
// converted to linear at load. `normalScale` is the strength of the authored
// tangent-space detail normal; `roughness` is the base perceptual roughness.
import { srgbToLinear } from "./math.js";

export const MATERIAL_IDS = ["rock", "soil", "vegetation"];

export const MATERIALS = [
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
    albedo: [0.29, 0.40, 0.17],
    roughness: 0.9,
    normalScale: 1.6,
    metallic: 0.0,
    detailScale: 0.78,
  },
];

export const MATERIAL_BY_ID = Object.fromEntries(MATERIALS.map((m) => [m.id, m]));

// Linear-light albedo per material, used by the reference rasterizer and shader.
export const MATERIAL_LINEAR = Object.fromEntries(
  MATERIALS.map((m) => [m.id, srgbToLinear(m.albedo)])
);

// Fallback when every weight is zero. This is an explicit, documented default
// ("neutral basalt") so the result can never be an undefined/black color.
export const FALLBACK_MATERIAL_ID = "rock";
export const FALLBACK_WEIGHT_FRACTION = 1.0;

export function materialIndex(id) {
  return MATERIAL_IDS.indexOf(id);
}
