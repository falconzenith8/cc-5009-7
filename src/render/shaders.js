// GLSL ES 3.00 shaders.
//
// Design notes:
//  * Weights are recomputed per-fragment from the interpolated geometric normal
//    and world height, using the SAME fusion contract as src/kernel/terrain.js.
//    The raw-weight coefficients are not literals in this shader: they arrive
//    via uFusionCoeffs[0..3] / uFusionScalar, populated from the declared v2
//    material pack (glslFusionContract below). The legacy v1 shader carried a
//    divergent set of constants; v2 forbids that drift.
//  * Triplanar mapping uses WORLD-space coordinates (metres -> tiles), so
//    textures are anchored to world space: moving the camera or changing mesh
//    subdivision never slides the pattern.
//  * Per-material detail normals are decoded from tangent-space RGBA textures
//    and rotated into a tangent frame around the geometric normal, then summed
//    and renormalized (whiteout-style). Encoded colors are never averaged as
//    if they were world normals.
//  * Seam handling: all textures are authored tileable and sampled with
//    GL_REPEAT + mipmaps + anisotropy; triplanar projection weights fade
//    smoothly across the 45-degree seams. The optional planar XZ mode is
//    intentionally kept as an A/B reference and visibly stretches on walls.

import { FUSION_CONTRACT_V2, MATERIAL_IDS_V2 } from "../kernel/materialPack.js";

// Uniform layout consumed by FRAGMENT_SRC. The renderer uploads exactly these
// values from the v2 pack; tests assert the emitted values equal
// FUSION_CONTRACT_V2.coefficients, which is how "CPU and GPU share one
// contract" is enforced rather than assumed.
//
// uFusionCoeffs:
//   [0] = baseRock, slopeRock, highRock, midRock
//   [1] = baseSoil, soilFlat, lowSoil, midSoil
//   [2] = soilGain, baseVeg, midVeg, lowVeg
//   [3] = vegGain, manualGain, vegSlopeTransition, weightEpsilon
export function glslFusionContract(packContract = FUSION_CONTRACT_V2) {
  const c = packContract.coefficients;
  return {
    coeffs: [
      [c.baseRock, c.slopeRock, c.highRock, c.midRock],
      [c.baseSoil, c.soilFlat, c.lowSoil, c.midSoil],
      [c.soilGain, c.baseVeg, c.midVeg, c.lowVeg],
      [c.vegGain, packContract.manualGain, packContract.vegetationSlopeTransition, packContract.weightEpsilon],
    ],
    fallbackMaterialId: packContract.fallback.materialId,
    materialOrder: MATERIAL_IDS_V2,
  };
}

export const VERTEX_SRC = `#version 300 es
precision highp float;
in vec3 aPosition;
in vec3 aNormal;
in vec4 aWeights;
uniform mat4 uViewProj;
out vec3 vWorld;
out vec3 vNormal;
out float vFlag;
void main() {
  vWorld = aPosition;
  vNormal = aNormal;
  vFlag = aWeights.w;
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}
`;

export const FRAGMENT_SRC = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec3 vWorld;
in vec3 vNormal;
in float vFlag;
out vec4 outColor;

uniform vec3 uCamPos;
uniform float uWorldSize;
uniform float uMaxHeight;

uniform float uSlopeStart;
uniform float uSlopeEnd;
uniform float uLowAltitude;
uniform float uHighAltitude;
uniform float uAltitudeBlend;
uniform float uVegSlopeLimit;
uniform vec3 uManual;
uniform vec4 uZeroPatch;       // enabled, u, v, radius

// Declared v2 fusion contract (see glslFusionContract). No raw-weight
// coefficients are hard-coded in this shader.
uniform vec4 uFusionCoeffs[4];

uniform int uMapMode;          // 0 triplanar, 1 planar XZ, 2 mesh UV
uniform float uTileScale;      // 1 / metersPerTile
uniform float uSharpness;
uniform float uNormalStrength;
uniform float uLodTiles;       // tile count tied to subdivision (mesh-UV mode)

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform float uAmbient;
uniform vec3 uSkyColor;
uniform float uFogDensity;
uniform float uExposure;

uniform int uDebugMode;
uniform int uChunks;
uniform vec3 uFallbackLinear;
uniform vec3 uDeepColor;

uniform sampler2D uAlbRock;
uniform sampler2D uNormRock;
uniform sampler2D uAlbSoil;
uniform sampler2D uNormSoil;
uniform sampler2D uAlbVeg;
uniform sampler2D uNormVeg;


float saturate(float v) { return clamp(v, 0.0, 1.0); }

vec2 worldToUV(vec3 p) {
  return p.xz / uWorldSize + 0.5;
}

// Must match evaluateRawWeights / zeroWeightPatch / normalizeWeights in
// terrain.js. The coefficients come from the declared v2 fusion contract via
// uFusionCoeffs (glslFusionContract), never from shader-local literals.
vec3 computeWeights(vec3 n, float height, out float slope, out float alt, out bool fallback) {
  slope = saturate(1.0 - n.y);
  alt = saturate(height / max(uMaxHeight, 1.0));

  float slopeTerm = smoothstep(uSlopeStart, uSlopeEnd, slope);
  float flatTerm = 1.0 - slopeTerm;

  float aLow = 1.0 - smoothstep(uLowAltitude, uLowAltitude + uAltitudeBlend, alt);
  float aHigh = smoothstep(uHighAltitude - uAltitudeBlend, uHighAltitude, alt);
  float aMid = max(0.0, 1.0 - aLow - aHigh);
  float bandSum = aLow + aMid + aHigh;
  vec3 bands = bandSum > 1e-8 ? vec3(aLow, aMid, aHigh) / bandSum : vec3(0.0);

  float vegSlope = 1.0 - smoothstep(uVegSlopeLimit, uVegSlopeLimit + uFusionCoeffs[3].z, slope);

  vec4 k0 = uFusionCoeffs[0]; // baseRock, slopeRock, highRock, midRock
  vec4 k1 = uFusionCoeffs[1]; // baseSoil, soilFlat, lowSoil, midSoil
  vec4 k2 = uFusionCoeffs[2]; // soilGain, baseVeg, midVeg, lowVeg
  vec4 k3 = uFusionCoeffs[3]; // vegGain, manualGain, vegTransition, epsilon

  float rock = k0.x + slopeTerm * k0.y + bands.z * k0.z + bands.y * k0.w;
  float soil = k1.x + flatTerm * (k1.y + bands.x * k1.z + bands.y * k1.w) * k2.x;
  float veg  = k2.y + flatTerm * vegSlope * (bands.y * k2.z + bands.x * k2.w) * k3.x;
  rock += uManual.x * k3.y;
  soil += uManual.y * k3.y;
  veg  += uManual.z * k3.y;

  if (uZeroPatch.x > 0.5) {
    vec2 uv = worldToUV(vWorld);
    float d = length(uv - uZeroPatch.yz);
    float mask = smoothstep(uZeroPatch.w * 0.45, uZeroPatch.w, d);
    rock *= mask; soil *= mask; veg *= mask;
  }

  float sum = rock + soil + veg;
  fallback = !(sum > k3.w);
  return fallback ? vec3(1.0, 0.0, 0.0) : vec3(rock, soil, veg) / sum;
}

vec3 triplanarBlendWeights(vec3 n) {
  vec3 w = pow(abs(n) + vec3(1e-5), vec3(uSharpness));
  float s = w.x + w.y + w.z;
  return s > 1e-8 ? w / s : vec3(0.0, 1.0, 0.0);
}

// One projection pair (albedo+rough, normal) -> weighted albedo/rough and a
// world-space tangential perturbation relative to the geometric normal.
void triplanarSample(
  sampler2D alb, sampler2D nrm,
  vec3 p, vec3 bw, vec3 geomN,
  float materialWeight,
  inout vec3 albedoSum, inout float roughSum, inout vec3 perturbSum
) {
  vec2 uvX = vec2(p.z, -p.y) * uTileScale;
  vec2 uvY = vec2(p.x, -p.z) * uTileScale;
  vec2 uvZ = vec2(p.x,  p.y) * uTileScale;

  vec4 aX = texture(alb, uvX);
  vec4 aY = texture(alb, uvY);
  vec4 aZ = texture(alb, uvZ);
  vec3 albedo = aX.rgb * bw.x + aY.rgb * bw.y + aZ.rgb * bw.z;
  float rough = aX.a * bw.x + aY.a * bw.y + aZ.a * bw.z;

  vec3 tX = texture(nrm, uvX).xyz * 2.0 - 1.0;
  vec3 tY = texture(nrm, uvY).xyz * 2.0 - 1.0;
  vec3 tZ = texture(nrm, uvZ).xyz * 2.0 - 1.0;
  // Projection bases are right-handed (Tu x Tv = N):
  //   X: Tu=+Z, Tv=-Y  ->  (nz, -ny, nx)
  //   Y: Tu=+X, Tv=-Z  ->  (nx,  nz, -ny)
  //   Z: Tu=+X, Tv=+Y  ->  (nx,  ny,  nz)
  vec3 wX = vec3(tX.z, -tX.y, tX.x);
  vec3 wY = vec3(tY.x, tY.z, -tY.y);
  vec3 wZ = vec3(tZ.x, tZ.y, tZ.z);
  vec3 worldDetail = normalize(wX * bw.x + wY * bw.y + wZ * bw.z);

  albedoSum += albedo * materialWeight;
  roughSum += rough * materialWeight;
  // Whiteout perturbation: deviation of the detail normal from the surface
  // normal, accumulated per material, re-added and renormalized in main().
  perturbSum += (worldDetail - geomN) * materialWeight;
}

vec3 sunDirection() {
  float az = radians(uSunDir.x);
  float el = radians(uSunDir.y);
  return normalize(vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az)));
}

void main() {
  vec3 geomN = normalize(vNormal);
  float height = vWorld.y;
  float slope, alt;
  bool fallback;
  vec3 weights = computeWeights(geomN, height, slope, alt, fallback);

  // Skirt / base geometry (flagged by the kernel) is rendered as flat dark rock.
  bool isSkirt = vFlag > 1.5;

  vec3 albedoAcc = vec3(0.0);
  float roughAcc = 0.0;
  vec3 perturbAcc = vec3(0.0);
  float wSum = 0.0;

  if (uMapMode == 0) {
    vec3 bw = triplanarBlendWeights(geomN);
    if (weights.x > 0.0) triplanarSample(uAlbRock, uNormRock, vWorld, bw, geomN, weights.x, albedoAcc, roughAcc, perturbAcc);
    if (weights.y > 0.0) triplanarSample(uAlbSoil, uNormSoil, vWorld, bw, geomN, weights.y, albedoAcc, roughAcc, perturbAcc);
    if (weights.z > 0.0) triplanarSample(uAlbVeg,  uNormVeg,  vWorld, bw, geomN, weights.z, albedoAcc, roughAcc, perturbAcc);
    wSum = weights.x + weights.y + weights.z;
  } else if (uMapMode == 1) {
    // Planar XZ: one texture-space for all faces -> visible stretch on walls.
    vec2 uv = vWorld.xz * uTileScale;
    vec4 aR = texture(uAlbRock, uv);
    vec4 aS = texture(uAlbSoil, uv);
    vec4 aV = texture(uAlbVeg, uv);
    albedoAcc = aR.rgb * weights.x + aS.rgb * weights.y + aV.rgb * weights.z;
    roughAcc = aR.a * weights.x + aS.a * weights.y + aV.a * weights.z;
    // Normals: decode and perturb in the XZ frame; still valid directions,
    // but relief is projected onto up, so steep faces lose detail.
    vec3 tR = texture(uNormRock, uv).xyz * 2.0 - 1.0;
    vec3 tS = texture(uNormSoil, uv).xyz * 2.0 - 1.0;
    vec3 tV = texture(uNormVeg, uv).xyz * 2.0 - 1.0;
    vec3 d = (vec3(tR.x, tR.z, tR.y) * weights.x) + (vec3(tS.x, tS.z, tS.y) * weights.y) + (vec3(tV.x, tV.z, tV.y) * weights.z);
    perturbAcc = d - dot(d, geomN) * geomN;
    wSum = 1.0;
  } else {
    // Mesh UV mode: tile count is tied to the subdivision (one tile per ~4
    // cells), the classic grid-relative mistake. Included only to demonstrate
    // the sliding/scale artifact; never the default.
    vec2 uv = worldToUV(vWorld) * uLodTiles;
    vec4 aR = texture(uAlbRock, uv);
    vec4 aS = texture(uAlbSoil, uv);
    vec4 aV = texture(uAlbVeg, uv);
    albedoAcc = aR.rgb * weights.x + aS.rgb * weights.y + aV.rgb * weights.z;
    roughAcc = aR.a * weights.x + aS.a * weights.y + aV.a * weights.z;
    vec3 tR = texture(uNormRock, uv).xyz * 2.0 - 1.0;
    vec3 tS = texture(uNormSoil, uv).xyz * 2.0 - 1.0;
    vec3 tV = texture(uNormVeg, uv).xyz * 2.0 - 1.0;
    vec3 d = (vec3(tR.x, tR.z, tR.y) * weights.x) + (vec3(tS.x, tS.z, tS.y) * weights.y) + (vec3(tV.x, tV.z, tV.y) * weights.z);
    perturbAcc = d - dot(d, geomN) * geomN;
    wSum = 1.0;
  }

  float safeW = max(wSum, 1e-6);
  vec3 albedo = albedoAcc / safeW;
  float roughness = clamp(roughAcc / safeW, 0.02, 1.0);
  if (isSkirt) {
    albedo = vec3(0.055, 0.048, 0.040);
    roughness = 0.95;
    perturbAcc = vec3(0.0);
  }

  // Whiteout reoriented blend, then hemisphere clamp. If perturb cancels,
  // fall back to the geometric normal (never a zero/NaN normal).
  vec3 normal = geomN + (perturbAcc / safeW) * uNormalStrength;
  float nlen = length(normal);
  normal = nlen > 1e-6 ? normal / nlen : geomN;
  if (dot(normal, geomN) < 0.0) normal = geomN;
  vec3 V = normalize(uCamPos - vWorld);
  vec3 L = sunDirection();
  float ndl = max(dot(normal, L), 0.0);
  // Wrapped ambient: sky dome term is always non-negative, so a zero-weight
  // fallback still produces a defined (non-black) surface color. Sky fill also
  // lifts shadowed faces to a believable outdoor level.
  float skyUp = max(normal.y, 0.0);
  float ambient = uAmbient * (0.55 + 0.45 * skyUp);
  vec3 ambientLight = uSkyColor * ambient + vec3(0.30, 0.26, 0.20) * ambient * 0.55;
  vec3 diffuse = albedo * (uSunColor * uSunIntensity * ndl + ambientLight);

  vec3 H = normalize(L + V);
  float specPow = exp2(11.0 * (1.0 - roughness));
  float spec = pow(max(dot(normal, H), 0.0), specPow) * (1.0 - roughness) * 0.35;
  vec3 specular = uSunColor * spec * ndl * uSunIntensity;

  float exposure = uExposure;
  vec3 color = (diffuse + specular) * exposure;
  // Filmic-ish shoulder, then linear -> sRGB transfer.
  color = color / (color + vec3(0.62)) * 1.08;

  float dist = length(uCamPos - vWorld);
  float fog = 1.0 - exp(-pow(dist * uFogDensity, 2.0));
  vec3 skyAtHorizon = uSkyColor * 0.7;
  color = mix(color, skyAtHorizon, saturate(fog));

  // The skirt (geometry below y = 0) is flat dark rock, already unlit-looking.
  float depthMute = isSkirt ? 1.0 : 0.0;
  color = mix(color, mix(color * 0.4, uDeepColor, 0.45), depthMute);

  // --- Debug views -----------------------------------------------------
  if (uDebugMode == 1) {
    color = weights; // R rock, G soil, B vegetation (normalized)
  } else if (uDebugMode == 2) {
    color = vec3(weights.x);
  } else if (uDebugMode == 3) {
    color = vec3(weights.y);
  } else if (uDebugMode == 4) {
    color = vec3(weights.z);
  } else if (uDebugMode == 5) {
    float lum = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
    color = fallback ? vec3(1.0, 0.0, 0.85) : vec3(lum * 0.55);
    if (fallback) color = mix(vec3(1.0, 0.0, 0.85), vec3(0.25, 0.0, 0.18), step(0.5, fract(vWorld.x * 0.25 + vWorld.z * 0.25)));
  } else if (uDebugMode == 6) {
    color = normal * 0.5 + 0.5;
  } else if (uDebugMode == 7) {
    color = vec3(slope);
  } else if (uDebugMode == 8) {
    color = vec3(alt);
  } else if (uDebugMode == 9) {
    vec2 uv = worldToUV(vWorld) * float(uChunks);
    vec2 f = fract(uv);
    vec2 edge = min(f, 1.0 - f);
    float line = 1.0 - smoothstep(0.0, 0.012, min(edge.x, edge.y));
    color = mix(color, vec3(1.0, 0.55, 0.1), line * 0.85);
  } else if (uDebugMode == 10) {
    // Vertex-flag readback: 0 surface (black), 1 zero-weight fallback (red),
    // 2 skirt/base geometry (blue). Lets tests separate real surface texels
    // from skirt/fallback geometry when correlating fusion weights.
    color = vec3(clamp(vFlag, 0.0, 2.0) * 0.5, 0.0, vFlag > 1.5 ? 1.0 : 0.0);
  }

  if (any(isnan(color)) || any(isinf(color))) color = uFallbackLinear;
  color = clamp(color, 0.0, 1.0);
  // Diagnostic views (weights/normal/slope/altitude/...) encode raw linear data
  // that tests read back numerically; they must bypass the display transfer so
  // an on-screen R value equals the actual fusion weight. Only the lit final
  // view and chunk overlays are encoded to sRGB for display.
  if ((uDebugMode >= 1 && uDebugMode <= 8) || uDebugMode == 10) {
    outColor = vec4(color, 1.0);
  } else {
    vec3 srgb = mix(color * 12.92, 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), color));
    outColor = vec4(srgb, 1.0);
  }
}
`;

export const SKY_VERTEX_SRC = `#version 300 es
precision highp float;
in vec2 aPosition;
out vec2 vNdc;
void main() {
  vNdc = aPosition;
  gl_Position = vec4(aPosition, 0.9999, 1.0);
}
`;

export const SKY_FRAGMENT_SRC = `#version 300 es
precision highp float;
in vec2 vNdc;
out vec4 outColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uSunDir;
uniform vec2 uResolution;
void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = vec2(vNdc.x * aspect, vNdc.y);
  float y = clamp(vNdc.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 zenith = uSkyColor * 0.55;
  vec3 horizon = uSkyColor * 1.15 + vec3(0.06, 0.05, 0.03);
  vec3 color = mix(horizon, zenith, pow(y, 0.55));
  color = mix(uGroundColor, color, smoothstep(-0.25, 0.05, vNdc.y));
  float sunGlow = pow(max(dot(normalize(vec3(p, 1.0)), normalize(uSunDir)), 0.0), 48.0);
  color += vec3(1.0, 0.86, 0.62) * sunGlow * 0.5;
  outColor = vec4(clamp(color / (color + vec3(0.62)) * 1.08, 0.0, 1.0), 1.0);
}
`;

export const LINE_VERTEX_SRC = `#version 300 es
precision highp float;
in vec3 aPosition;
in vec3 aNormal;
uniform mat4 uViewProj;
uniform float uBias;
void main() {
  vec3 p = aPosition + aNormal * uBias;
  gl_Position = uViewProj * vec4(p, 1.0);
}
`;

export const LINE_FRAGMENT_SRC = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec3 uLineColor;
void main() {
  outColor = vec4(uLineColor, 1.0);
}
`;
