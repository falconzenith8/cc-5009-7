// WebGL2 terrain renderer. Owns GL objects, texture memory and draw state.
// Receives validated state from the app and reports actual resource counts.

import { createProgram, createBuffer, createTexture2D, createVAO, mat4Perspective, mat4LookAt, mat4Multiply, mat4Identity } from "./gl.js";
import { VERTEX_SRC, FRAGMENT_SRC, SKY_VERTEX_SRC, SKY_FRAGMENT_SRC, LINE_VERTEX_SRC, LINE_FRAGMENT_SRC } from "./shaders.js";
import { generateMaterialTextures, mipChainBytes } from "../kernel/textures.js";
import { liftCameraAboveTerrain, terrainFocusHeight } from "../kernel/terrain.js";
import { MATERIAL_IDS, MATERIAL_BY_ID } from "../kernel/materials.js";
import { srgbToLinear } from "../kernel/math.js";

const DEBUG_MODE_INDEX = {
  final: 0,
  weights: 1,
  rock: 2,
  soil: 3,
  vegetation: 4,
  fallback: 5,
  normal: 6,
  slope: 7,
  altitude: 8,
  chunks: 9,
};

export class TerrainRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      antialias: true,
      alpha: false,
      depth: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error("WebGL2 不可用：浏览器或 GPU 驱动不支持 WebGL2。");
    this.gl = gl;
    this.terrainProgram = createProgram(gl, VERTEX_SRC, FRAGMENT_SRC, "terrain");
    this.skyProgram = createProgram(gl, SKY_VERTEX_SRC, SKY_FRAGMENT_SRC, "sky");
    this.lineProgram = createProgram(gl, LINE_VERTEX_SRC, LINE_FRAGMENT_SRC, "lines");

    this.skyVAO = this._createSkyVAO();
    this.textures = null;
    this.textureSize = 0;
    this.chunkResources = [];
    this.meshStateKey = "";
    this.textureKey = "";
    this.stats = {
      drawCalls: 0,
      renderedTriangles: 0,
      textureBytes: 0,
      meshGpuBytes: 0,
      meshCpuBytes: 0,
      meshVertices: 0,
      textureGenerationMs: 0,
      meshGenerationMs: 0,
      programs: 3,
    };
    this.anisoExt = gl.getExtension("EXT_texture_filter_anisotropic");
    this.maxAniso = this.anisoExt ? gl.getParameter(this.anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;
    this._textureCache = new Map();
  }

  _createSkyVAO() {
    const gl = this.gl;
    const buffer = createBuffer(gl, gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]));
    return createVAO(gl, [{ buffer, location: this.skyProgram.attribs.aPosition, size: 2 }]);
  }

  // -------------------------------------------------------------------------
  // Textures
  // -------------------------------------------------------------------------

  ensureTextures(textureSize) {
    if (this.textures && this.textureSize === textureSize) return;
    const gl = this.gl;
    const started = performance.now();
    const generated = MATERIAL_IDS.map((id) => generateMaterialTextures(id, textureSize, 1337));
    const tex = {};
    for (const g of generated) {
      const albedo = createTexture2D(gl, {
        width: g.size,
        height: g.size,
        internalFormat: gl.SRGB8_ALPHA8,
        data: g.albedoRough,
        mipmap: true,
        anisotropy: this.maxAniso,
      });
  // Albedo textures use SRGB8_ALPHA8: RGB is decoded to linear on sampling
  // (matching composeAlbedoLinear in the kernel), while alpha keeps linear
  // roughness. Normal maps must stay linear RGBA8.
      const normal = createTexture2D(gl, {
        width: g.size,
        height: g.size,
        data: g.normalMap,
        mipmap: true,
        anisotropy: this.maxAniso,
      });
      tex[g.materialId] = { albedo, normal, stats: g.stats };
    }
    // Free previous GPU textures.
    if (this.textures) {
      for (const id of MATERIAL_IDS) {
        gl.deleteTexture(this.textures[id].albedo);
        gl.deleteTexture(this.textures[id].normal);
      }
    }
    this.textures = tex;
    this.textureSize = textureSize;
    this.stats.textureGenerationMs = performance.now() - started;
    this.stats.textureBytes = MATERIAL_IDS.length * 2 * mipChainBytes(textureSize);
    this._textureCache.clear();
  }

  // -------------------------------------------------------------------------
  // Mesh
  // -------------------------------------------------------------------------

  uploadMeshes(buildResult) {
    const gl = this.gl;
    const started = performance.now();
    for (const res of this.chunkResources) this._disposeChunk(res);
    this.chunkResources = [];
    let gpuBytes = 0;
    let cpuBytes = 0;
    for (const mesh of buildResult.meshes) {
      const posBuf = createBuffer(gl, gl.ARRAY_BUFFER, mesh.positions);
      const nrmBuf = createBuffer(gl, gl.ARRAY_BUFFER, mesh.normals);
      const wgtBuf = createBuffer(gl, gl.ARRAY_BUFFER, mesh.weights);
      const idxBuf = createBuffer(gl, gl.ELEMENT_ARRAY_BUFFER, mesh.indices);
      const lineBuf = createBuffer(gl, gl.ELEMENT_ARRAY_BUFFER, mesh.lineIndices);
      const vao = createVAO(gl, [
        { buffer: posBuf, location: this.terrainProgram.attribs.aPosition, size: 3 },
        { buffer: nrmBuf, location: this.terrainProgram.attribs.aNormal, size: 3 },
        { buffer: wgtBuf, location: this.terrainProgram.attribs.aWeights, size: 4 },
      ], idxBuf);
      const lineVao = createVAO(gl, [
        { buffer: posBuf, location: this.lineProgram.attribs.aPosition, size: 3 },
        { buffer: nrmBuf, location: this.lineProgram.attribs.aNormal, size: 3 },
      ], lineBuf);
      gpuBytes += mesh.positions.byteLength + mesh.normals.byteLength + mesh.weights.byteLength + mesh.indices.byteLength + mesh.lineIndices.byteLength;
      cpuBytes += mesh.positions.byteLength + mesh.normals.byteLength + mesh.uvs.byteLength + mesh.weights.byteLength + mesh.indices.byteLength + mesh.lineIndices.byteLength;
      this.chunkResources.push({
        vao, lineVao, posBuf, nrmBuf, wgtBuf, idxBuf, lineBuf,
        indexCount: mesh.indices.length,
        lineIndexCount: mesh.lineIndices.length,
        triangleCount: mesh.triangleCount,
        vertexCount: mesh.vertexCount,
      });
    }
    this.stats.meshGpuBytes = gpuBytes;
    this.stats.meshCpuBytes = cpuBytes;
    this.stats.meshVertices = buildResult.vertexCount;
    this.stats.renderedTriangles = buildResult.triangleCount;
    this.stats.meshGenerationMs = performance.now() - started;
  }

  _disposeChunk(res) {
    const gl = this.gl;
    gl.deleteVertexArray(res.vao);
    gl.deleteVertexArray(res.lineVao);
    gl.deleteBuffer(res.posBuf);
    gl.deleteBuffer(res.nrmBuf);
    gl.deleteBuffer(res.wgtBuf);
    gl.deleteBuffer(res.idxBuf);
    gl.deleteBuffer(res.lineBuf);
  }

  // -------------------------------------------------------------------------
  // Camera / uniforms
  // -------------------------------------------------------------------------

  cameraEye(state) {
    const { view } = state;
    const cp = Math.cos(view.pitch);
    const raw = [
      view.targetX + view.distance * cp * Math.sin(view.yaw),
      Math.sin(view.pitch) * view.distance,
      view.targetZ + view.distance * cp * Math.cos(view.yaw),
    ];
    const lifted = liftCameraAboveTerrain(raw, state.height, 20);
    this.cameraCorrected = lifted.corrected;
    return lifted.eye;
  }

  render(state, options = {}) {
    const gl = this.gl;
    const { width, height } = this.resize();
    gl.viewport(0, 0, width, height);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.clearColor(0.16, 0.19, 0.23, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this.ensureTextures(state.quality.textureSize);

    const eye = this.cameraEye(state);
    const target = [state.view.targetX, this._targetHeight(state), state.view.targetZ];
    const proj = mat4Perspective(new Float32Array(16), (state.view.fov * Math.PI) / 180, width / height, 0.5, 4000);
    const viewM = mat4LookAt(new Float32Array(16), eye, target, [0, 1, 0]);
    const viewProj = mat4Multiply(new Float32Array(16), proj, viewM);

    const sunDir = this._sunDirection(state.render);
    const skyColor = state.render.skyColor;
    const skyLinear = srgbToLinear(state.render.skyColor);

    // Sky
    gl.depthMask(false);
    gl.useProgram(this.skyProgram.program);
    gl.uniform3fv(this.skyProgram.uniforms.uSkyColor, skyLinear);
    gl.uniform3fv(this.skyProgram.uniforms.uGroundColor, [0.18, 0.16, 0.13]);
    gl.uniform3fv(this.skyProgram.uniforms.uSunDir, sunDir);
    gl.uniform2f(this.skyProgram.uniforms.uResolution, width, height);
    gl.bindVertexArray(this.skyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);

    // Terrain
    const p = this.terrainProgram;
    gl.useProgram(p.program);
    const u = p.uniforms;
    gl.uniformMatrix4fv(u.uViewProj, false, viewProj);
    gl.uniform3fv(u.uCamPos, eye);
    gl.uniform1f(u.uWorldSize, state.height.worldSize);
    gl.uniform1f(u.uMaxHeight, state.height.maxHeight);
    gl.uniform1f(u.uSlopeStart, state.rules.slopeStart);
    gl.uniform1f(u.uSlopeEnd, state.rules.slopeEnd);
    gl.uniform1f(u.uLowAltitude, state.rules.lowAltitude);
    gl.uniform1f(u.uHighAltitude, state.rules.highAltitude);
    gl.uniform1f(u.uAltitudeBlend, state.rules.altitudeBlend);
    gl.uniform1f(u.uVegSlopeLimit, state.rules.vegetationSlopeLimit);
    gl.uniform3fv(u.uManual, [state.rules.manual.rock, state.rules.manual.soil, state.rules.manual.vegetation]);
    const zp = state.rules.zeroWeightPatch;
    gl.uniform4f(u.uZeroPatch, zp.enabled ? 1 : 0, zp.u, zp.v, zp.radius);
    gl.uniform1i(u.uMapMode, state.mapping.mode);
    gl.uniform1f(u.uTileScale, 1 / state.mapping.metersPerTile);
    gl.uniform1f(u.uSharpness, state.mapping.sharpness);
    gl.uniform1f(u.uNormalStrength, state.mapping.normalStrength);
    gl.uniform1f(u.uLodTiles, Math.max(1, Math.round(state.quality.lod / 4)));
    gl.uniform3f(u.uSunDir, state.render.sunAzimuth, state.render.sunElevation, 0);
    gl.uniform3fv(u.uSunColor, srgbToLinear(state.render.sunColor));
    gl.uniform1f(u.uSunIntensity, state.render.sunIntensity);
    gl.uniform1f(u.uAmbient, state.render.ambient);
    gl.uniform3fv(u.uSkyColor, skyLinear);
    gl.uniform1f(u.uFogDensity, state.render.fogDensity);
    gl.uniform1f(u.uExposure, state.render.exposure);
    // `showChunkBounds` overlays the chunk grid on the lit result; a non-final
    // debug view takes precedence because it already encodes the boundaries of
    // whatever quantity is being inspected.
    const debugMode =
      state.quality.showChunkBounds && state.quality.debugMode === "final"
        ? "chunks"
        : state.quality.debugMode;
    gl.uniform1i(u.uDebugMode, DEBUG_MODE_INDEX[debugMode] ?? 0);
    gl.uniform1i(u.uChunks, state.quality.chunks);
    gl.uniform3fv(u.uFallbackLinear, srgbToLinear(MATERIAL_BY_ID.rock.albedo));
    gl.uniform3f(u.uDeepColor, 0.09, 0.075, 0.06);

    // Texture units
    let unit = 0;
    const bind = (loc, texture) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(loc, unit);
      unit++;
    };
    bind(u.uAlbRock, this.textures.rock.albedo);
    bind(u.uNormRock, this.textures.rock.normal);
    bind(u.uAlbSoil, this.textures.soil.albedo);
    bind(u.uNormSoil, this.textures.soil.normal);
    bind(u.uAlbVeg, this.textures.vegetation.albedo);
    bind(u.uNormVeg, this.textures.vegetation.normal);

    let drawCalls = 0;
    for (const res of this.chunkResources) {
      gl.bindVertexArray(res.vao);
      gl.drawElements(gl.TRIANGLES, res.indexCount, gl.UNSIGNED_INT, 0);
      drawCalls++;
    }

    // Wireframe overlay (grid lines visualize real subdivision).
    if (state.quality.showWireframe) {
      const lp = this.lineProgram;
      gl.useProgram(lp.program);
      gl.uniformMatrix4fv(lp.uniforms.uViewProj, false, viewProj);
      gl.uniform3f(lp.uniforms.uLineColor, 0.06, 0.07, 0.08);
      gl.uniform1f(lp.uniforms.uBias, 0.35);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      for (const res of this.chunkResources) {
        gl.bindVertexArray(res.lineVao);
        gl.drawElements(gl.LINES, res.lineIndexCount, gl.UNSIGNED_INT, 0);
        drawCalls++;
      }
      gl.disable(gl.BLEND);
    }

    gl.bindVertexArray(null);
    this.stats.drawCalls = drawCalls;
    return this.stats;
  }

  _targetHeight(state) {
    return terrainFocusHeight(state.height);
  }

  _sunDirection(render) {
    const az = (render.sunAzimuth * Math.PI) / 180;
    const el = (render.sunElevation * Math.PI) / 180;
    return [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return { width: w, height: h, dpr };
  }

  // Ray cast from a screen pixel into the terrain height field. Used for the
  // probe inspector and ground-accurate camera framing.
  pick(screenX, screenY, state) {
    const rect = this.canvas.getBoundingClientRect();
    const nx = (screenX / rect.width) * 2 - 1;
    const ny = 1 - (screenY / rect.height) * 2;
    const eye = this.cameraEye(state);
    const target = [state.view.targetX, this._targetHeight(state), state.view.targetZ];
    const fov = (state.view.fov * Math.PI) / 180;
    const aspect = rect.width / rect.height;
    const forward = normalize([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
    const right = normalize(cross(forward, [0, 1, 0]));
    const up = cross(right, forward);
    const tanY = Math.tan(fov / 2);
    const dir = normalize([
      forward[0] + right[0] * nx * tanY * aspect + up[0] * ny * tanY,
      forward[1] + right[1] * nx * tanY * aspect + up[1] * ny * tanY,
      forward[2] + right[2] * nx * tanY * aspect + up[2] * ny * tanY,
    ]);
    return { eye, dir };
  }
}

function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
