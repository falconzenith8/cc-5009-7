// Application shell: builds kernel-driven controls, owns render loop, probe,
// persistence and failure feedback. All terrain math comes from the kernel.

import {
  CONTROL_GROUPS,
  PRESETS,
  DEBUG_MODES_EXPORT,
  STORAGE_KEY,
  createDefaultState,
  applyStatePatch,
  applyPreset,
  getPath,
  setPath,
  serializeState,
  deserializeState,
} from "../kernel/state.js";
import {
  buildTerrainMeshes,
  meshMemory,
  formatBytes,
  evaluateSample,
  composeAlbedoLinear,
  composeRoughness,
  sampleHeightField,
  normalizeHeightParams,
} from "../kernel/terrain.js";
import { MATERIAL_IDS, MATERIAL_BY_ID } from "../kernel/materials.js";
import { linearToSrgb } from "../kernel/math.js";
import { materialTextureBytes } from "../kernel/textures.js";
import { mat4Perspective, mat4LookAt, mat4Multiply, transformPoint4 } from "../render/gl.js";
import { TerrainRenderer } from "../render/renderer.js";

const $ = (sel) => document.querySelector(sel);

const app = {
  state: createDefaultState(),
  presetId: "default",
  renderer: null,
  build: null,
  memory: null,
  warnings: [],
  probe: { u: 0.5, v: 0.5 },
  probeScreen: null,
  lastBuildMs: 0,
  autoOrbit: false,
  fps: { frames: 0, last: performance.now(), value: 0 },
  lastFrameMs: 0,
  controlValues: new Map(),
};

function rgbCss(linear) {
  const [r, g, b] = linearToSrgb(linear);
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

function showError(title, error) {
  const overlay = $("#error-overlay");
  overlay.hidden = false;
  overlay.innerHTML = "";
  const card = document.createElement("div");
  card.className = "error-card";
  const h = document.createElement("h3");
  h.textContent = title;
  card.appendChild(h);
  const msg = document.createElement("p");
  msg.textContent = error?.message || String(error);
  card.appendChild(msg);
  if (error?.detail) {
    const pre = document.createElement("pre");
    pre.textContent = error.detail;
    card.appendChild(pre);
  }
  const btn = document.createElement("button");
  btn.className = "btn";
  btn.textContent = "重新加载";
  btn.addEventListener("click", () => location.reload());
  card.appendChild(btn);
  overlay.appendChild(card);
  $("#status-text").textContent = `失败：${title}`;
  $("#status-text").className = "err";
}

function clearError() {
  const overlay = $("#error-overlay");
  overlay.hidden = true;
  overlay.innerHTML = "";
}

// ---------------------------------------------------------------------------
// State / rebuild pipeline
// ---------------------------------------------------------------------------

function rebuild(reason) {
  try {
    const t0 = performance.now();
    if (!app.renderer) return;
    app.renderer.ensureTextures(app.state.quality.textureSize);
    const build = buildTerrainMeshes({
      segments: app.state.quality.lod,
      chunks: app.state.quality.chunks,
      params: app.state.height,
      rules: app.state.rules,
    });
    app.build = build;
    app.memory = meshMemory(build);
    app.renderer.uploadMeshes(build);
    app.lastBuildMs = performance.now() - t0;
    updateMemoryPanel();
    updateHud();
    updateStatus(reason);
    if (build.fallbackCount > 0) {
      setStatusNote(`零权重回退顶点 ${build.fallbackCount} 个（已使用默认岩石材质）。`);
    }
  } catch (e) {
    showError("地形融合失败", e);
    console.error(e);
  }
}

function scheduleRebuild(reason) {
  if (app.rebuildHandle) cancelAnimationFrame(app.rebuildHandle);
  app.rebuildHandle = requestAnimationFrame(() => {
    app.rebuildHandle = null;
    rebuild(reason);
  });
}

function resourceKey(state) {
  return `${state.quality.lod}|${state.quality.chunks}|${state.quality.textureSize}|${state.height.seed}|${state.height.worldSize}|${state.height.maxHeight}|${state.height.relief}|${state.height.ridgeScale}|${state.height.gullyScale}|${state.height.gullyDepth}|${state.height.plateauAmount}|${state.height.plateauEdge}|${state.height.cliffStrength}|${state.height.valleyStrength}|${state.height.detailAmount}|${state.height.chunkEdgeStrength}|${state.height.clampHeight}|${state.rules.slopeStart}|${state.rules.slopeEnd}|${state.rules.lowAltitude}|${state.rules.highAltitude}|${state.rules.altitudeBlend}|${state.rules.vegetationSlopeLimit}|${state.rules.manual.rock}|${state.rules.manual.soil}|${state.rules.manual.vegetation}|${state.rules.zeroWeightPatch.enabled}|${state.rules.zeroWeightPatch.u}|${state.rules.zeroWeightPatch.v}|${state.rules.zeroWeightPatch.radius}`;
}

function commitPatch(patch, opts = {}) {
  const before = resourceKey(app.state);
  const result = applyStatePatch(app.state, patch);
  app.state = result.state;
  app.warnings = result.warnings;
  renderWarnings();
  syncControls();
  updateMappingNote();
  updateDebugSelect();
  const after = resourceKey(app.state);
  if (!opts.noPersist) persistState();
  if (before !== after) scheduleRebuild("网格/纹理资源重建");
  else updateProbe();
  updateHud();
}

function persistState() {
  try {
    localStorage.setItem(STORAGE_KEY, serializeState(app.state));
    $("#persist-note").textContent = `已保存 ${new Date().toLocaleTimeString()} · localStorage ${STORAGE_KEY}`;
  } catch (e) {
    $("#persist-note").textContent = `保存失败：${e.message}`;
  }
}

function loadStoredState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const res = deserializeState(raw);
    if (!res.ok) {
      renderWarnings([{ code: "load", message: `本地参数无法载入：${res.error}` }]);
      return null;
    }
    return res.state;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Controls (kernel-schema driven)
// ---------------------------------------------------------------------------

function renderDebugSelect() {
  const select = $("#debug-mode-select");
  select.innerHTML = "";
  for (const mode of DEBUG_MODES_EXPORT) {
    const opt = document.createElement("option");
    opt.value = mode.id;
    opt.textContent = mode.label;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => {
    commitPatch({ quality: { debugMode: select.value } });
  });
}

function updateDebugSelect() {
  const select = $("#debug-mode-select");
  if (select.value !== app.state.quality.debugMode) select.value = app.state.quality.debugMode;
}

function renderControls() {
  const host = $("#control-groups");
  host.innerHTML = "";
  for (const group of CONTROL_GROUPS) {
    const details = document.createElement("details");
    details.className = "control-group";
    details.open = ["rules", "mapping"].includes(group.id);
    const summary = document.createElement("summary");
    summary.textContent = group.label;
    details.appendChild(summary);
    if (group.note) {
      const note = document.createElement("p");
      note.className = "group-note";
      note.textContent = group.note;
      details.appendChild(note);
    }
    for (const control of group.controls) {
      details.appendChild(buildControl(control));
    }
    host.appendChild(details);
  }
}

function buildControl(control) {
  const row = document.createElement("div");
  row.className = `control ${control.type}`;
  const id = `ctl-${control.path.replace(/\./g, "-")}`;
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = control.label;
  row.appendChild(label);

  if (control.type === "range") {
    const val = document.createElement("span");
    val.className = "val";
    row.appendChild(val);
    const input = document.createElement("input");
    input.type = "range";
    input.id = id;
    input.min = control.min;
    input.max = control.max;
    input.step = control.step;
    input.addEventListener("input", () => {
      const raw = Number(input.value);
      const value = control.decimals === 0 ? Math.round(raw) : raw;
      setPath(app.state, control.path, value);
      val.textContent = formatControlValue(control, value);
      commitPatch({});
    });
    row.appendChild(input);
    app.controlValues.set(control.path, { input, val, control });
  } else if (control.type === "toggle") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    input.addEventListener("change", () => {
      commitPatch(setPath({}, control.path, input.checked));
    });
    row.appendChild(input);
    app.controlValues.set(control.path, { input, control });
  } else if (control.type === "select") {
    const select = document.createElement("select");
    select.id = id;
    for (const opt of control.options) {
      const o = document.createElement("option");
      o.value = String(opt.value);
      o.textContent = opt.label;
      select.appendChild(o);
    }
    select.addEventListener("change", () => {
      const isNumeric = typeof control.options[0].value === "number";
      const value = isNumeric ? Number(select.value) : select.value;
      commitPatch(setPath({}, control.path, value));
    });
    row.appendChild(select);
    app.controlValues.set(control.path, { input: select, control });
  }
  return row;
}

function formatControlValue(control, value) {
  if (control.decimals === 0) return String(Math.round(value));
  return Number(value).toFixed(control.decimals);
}

function syncControls() {
  for (const [path, entry] of app.controlValues) {
    const value = getPath(app.state, path);
    if (entry.control.type === "toggle") {
      entry.input.checked = !!value;
    } else if (entry.control.type === "select") {
      entry.input.value = String(value);
    } else {
      entry.input.value = String(value);
      entry.val.textContent = formatControlValue(entry.control, value);
    }
  }
}

function renderPresets() {
  const host = $("#presets");
  host.innerHTML = "";
  for (const preset of PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `preset-btn ${preset.id === app.presetId ? "active" : ""}`;
    btn.textContent = preset.label;
    btn.title = preset.note;
    btn.addEventListener("click", () => {
      app.presetId = preset.id;
      const result = applyPreset(app.state, preset.id);
      app.state = result.state;
      app.warnings = result.warnings;
      renderWarnings();
      syncControls();
      updateDebugSelect();
      updateMappingNote();
      renderPresets();
      persistState();
      scheduleRebuild(`预设：${preset.label}`);
      updateHud();
    });
    host.appendChild(btn);
  }
}

function renderWarnings(extra = null) {
  const host = $("#warnings");
  host.innerHTML = "";
  const list = [...(extra || []), ...(app.warnings || [])];
  for (const warning of list) {
    const item = document.createElement("div");
    item.className = "warning-item";
    item.textContent = warning.message;
    host.appendChild(item);
  }
}

function setStatusNote(message) {
  const el = $("#status-build");
  el.textContent = message;
  el.className = "ok";
}

// ---------------------------------------------------------------------------
// Inspector / probe
// ---------------------------------------------------------------------------

function buildWeightRows() {
  const body = $("#weight-rows");
  body.innerHTML = "";
  for (const id of MATERIAL_IDS) {
    const tr = document.createElement("tr");
    tr.dataset.material = id;
    tr.innerHTML = `
      <td><span class="weight-swatch" style="background:${MATERIAL_BY_ID[id].swatch}"></span> ${MATERIAL_BY_ID[id].label}</td>
      <td data-raw>–</td>
      <td data-norm>–<div class="weight-bar"><i data-bar style="background:${MATERIAL_BY_ID[id].swatch};width:0%"></i></div></td>
      <td><span data-chip class="weight-swatch" style="background:#333"></span></td>
    `;
    body.appendChild(tr);
  }
}

function updateProbe() {
  const { u, v } = app.probe;
  let sample;
  try {
    sample = evaluateSample(u, v, app.state.height, app.state.rules);
  } catch (e) {
    showError("权重评估失败", e);
    return;
  }
  const albedoLinear = composeAlbedoLinear(sample.weights);
  const roughness = composeRoughness(sample.weights);
  const normal = sample.normal;

  $("#probe-uv").textContent = `u ${u.toFixed(3)} · v ${v.toFixed(3)}`;
  $("#probe-height").textContent = `${sample.height.toFixed(1)} m`;
  $("#probe-slope").textContent = `${(sample.raw.slope).toFixed(3)} (${(Math.acos(Math.min(1, normal[1])) * 180 / Math.PI).toFixed(1)}°)`;
  const normEl = $("#probe-norm");
  normEl.textContent = sample.fallback
    ? "全零 → 回退岩石 = 1"
    : `Σ=${(sample.weights.rock + sample.weights.soil + sample.weights.vegetation).toFixed(4)}`;
  normEl.className = sample.fallback ? "mono err" : "mono";

  const raws = {
    rock: sample.raw.rock,
    soil: sample.raw.soil,
    vegetation: sample.raw.vegetation,
  };
  const rawSum = raws.rock + raws.soil + raws.vegetation;
  for (const id of MATERIAL_IDS) {
    const tr = document.querySelector(`#weight-rows tr[data-material="${id}"]`);
    if (!tr) continue;
    const rawEl = tr.querySelector("[data-raw]");
    const normEl2 = tr.querySelector("[data-norm]");
    const bar = tr.querySelector("[data-bar]");
    const chip = tr.querySelector("[data-chip]");
    rawEl.textContent = rawSum > 1e-8 ? raws[id].toFixed(3) : "0.000";
    const w = sample.weights[id] || 0;
    normEl2.childNodes[0].nodeValue = w.toFixed(3);
    bar.style.width = `${(w * 100).toFixed(1)}%`;
    chip.style.background = `rgb(${Math.round(MATERIAL_BY_ID[id].albedo[0] * 255)},${Math.round(MATERIAL_BY_ID[id].albedo[1] * 255)},${Math.round(MATERIAL_BY_ID[id].albedo[2] * 255)})`;
    chip.style.opacity = String(0.25 + w * 0.75);
  }

  $("#sum-albedo").textContent = `[${albedoLinear.map((c) => c.toFixed(3)).join(", ")}]`;
  $("#sum-roughness").textContent = roughness.toFixed(3);
  $("#sum-normal").textContent = `[${normal.map((c) => c.toFixed(3)).join(", ")}]`;
  const fallbackEl = $("#sum-fallback");
  fallbackEl.textContent = sample.fallback ? "已启用 · 岩石 1.0" : "未触发";
  fallbackEl.className = sample.fallback ? "mono err" : "mono";
  $("#swatch-main").style.background = rgbCss(albedoLinear);
  $("#swatch-main").title = `线性 ${albedoLinear.map((c) => c.toFixed(3)).join(", ")}`;
}

// ---------------------------------------------------------------------------
// Memory / HUD
// ---------------------------------------------------------------------------

function updateMemoryPanel() {
  const body = $("#memory-rows");
  if (!body) return;
  const mem = app.memory;
  const stats = app.renderer?.stats;
  const texBytes = stats?.textureBytes ?? materialTextureBytes(app.state.quality.textureSize) * 3;
  const rows = [
    ["网格顶点", `${mem?.vertexCount?.toLocaleString() ?? "–"} 顶点 · ${mem?.triangleCount?.toLocaleString() ?? "–"} 三角形`],
    ["GPU 网格缓冲", formatBytes(mem?.gpuBytes ?? 0)],
    ["CPU 网格数组", formatBytes(mem?.cpuBytes ?? 0)],
    ["GPU 纹理（含 mip）", formatBytes(texBytes)],
    ["纹理分辨率", `${app.state.quality.textureSize}² × 6 张 RGBA8`],
    ["顶点属性/顶点", `${(mem?.bytesPerVertexCpu ?? 0).toFixed(1)} B`],
    ["绘制调用", String(stats?.drawCalls ?? "–")],
    ["本帧渲染三角形", (stats?.renderedTriangles ?? 0).toLocaleString()],
  ];
  body.innerHTML = rows
    .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
    .join("");
  const totalBytes = (mem?.gpuBytes ?? 0) + texBytes;
  $("#memory-note").textContent = `GPU 合计约 ${formatBytes(totalBytes)}（网格 + 纹理）；数据来自当前已上传的 GL 资源。`;
}

function updateHud() {
  const build = app.build;
  const mem = app.memory;
  $("#hud-mesh").textContent = build
    ? `${build.vertexCount.toLocaleString()} v · ${build.triangleCount.toLocaleString()} tri · ${app.state.quality.chunks}×${app.state.quality.chunks}`
    : "–";
  const texBytes = app.renderer?.stats?.textureBytes || 0;
  $("#hud-textures").textContent = `${formatBytes(texBytes)} · ${app.state.quality.textureSize}²`;
  const mappingNames = { 0: "三平面 Triplanar", 1: "平面 XZ Planar", 2: "网格 UV Mesh-UV" };
  $("#hud-mapping").textContent = `${mappingNames[app.state.mapping.mode]} · ${app.state.mapping.metersPerTile} m/tile`;
}

function updateMappingNote() {
  const note = $("#mapping-note");
  if (!note) return;
  const mode = app.state.mapping.mode;
  if (mode === 0) {
    note.textContent =
      "三平面投影：按世界坐标的绝对米数取三组 X/Y/Z 采样，混合权重在 45° 处平滑过渡；所有贴图可平铺并用 GL_REPEAT + mipmap + 各向异性过滤，接缝只在 45° 混合带淡入淡出，无可见硬缝。移动相机或切换 LOD 不改变采样坐标，因此花纹不滑动。";
  } else if (mode === 1) {
    note.textContent =
      "平面 XZ 投影：只用水平坐标采样，陡壁上花纹沿垂直方向拉伸（这是映射方式本身决定的可解释取舍，不是 bug）。本次选择的接缝处理是 GL_REPEAT 平铺 + mipmap；斜面上仍保留正常光照。";
  } else {
    note.textContent =
      "网格 UV 对照模式：平铺次数绑定到当前细分（LOD/4），切换细分或相机位置会让花纹相对地表滑动/缩放，仅用于对比，不作为默认。";
  }
}

let lastHud = 0;
function tickHud(now) {
  if (now - lastHud > 250) {
    lastHud = now;
    app.fps.frames++;
    if (now - app.fps.last >= 500) {
      app.fps.value = (app.fps.frames * 1000) / (now - app.fps.last);
      app.fps.frames = 0;
      app.fps.last = now;
    }
    const stats = app.renderer?.stats;
    $("#hud-fps").textContent = `${app.fps.value.toFixed(0)} fps · ${stats?.drawCalls ?? 0} calls`;
    updateMemoryPanel();
  }
}

function updateStatus(reason) {
  $("#status-text").textContent = `就绪 · ${reason} · 构建 ${app.lastBuildMs.toFixed(0)} ms`;
  $("#status-text").className = "ok";
  if (app.build) {
    $("#status-build").textContent = `${app.build.vertexCount.toLocaleString()} 顶点 · ${app.build.vertexChunks ?? ""}`;
  }
}

// ---------------------------------------------------------------------------
// Interaction: orbit / pan / zoom / probe
// ---------------------------------------------------------------------------

function setupInteraction(canvas) {
  let dragging = false;
  let mode = "orbit";
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener("pointerdown", (ev) => {
    canvas.focus();
    dragging = true;
    mode = ev.shiftKey || ev.button === 2 ? "pan" : "orbit";
    lastX = ev.clientX;
    lastY = ev.clientY;
    canvas.setPointerCapture(ev.pointerId);
    canvas.style.cursor = mode === "pan" ? "grabbing" : "grabbing";
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const dx = ev.clientX - lastX;
    const dy = ev.clientY - lastY;
    lastX = ev.clientX;
    lastY = ev.clientY;
    if (mode === "orbit") {
      commitPatch(
        {
          view: {
            yaw: app.state.view.yaw - dx * 0.005,
            pitch: Math.max(0.05, Math.min(1.45, app.state.view.pitch + dy * 0.004)),
          },
        },
        { noPersist: true }
      );
    } else {
      const scale = app.state.view.distance * 0.0016;
      const yaw = app.state.view.yaw;
      commitPatch(
        {
          view: {
            targetX: app.state.view.targetX - (Math.cos(yaw) * dx - Math.sin(yaw) * dy) * scale,
            targetZ: app.state.view.targetZ + (Math.sin(yaw) * dx + Math.cos(yaw) * dy) * scale,
          },
        },
        { noPersist: true }
      );
    }
  });
  const endDrag = (ev) => {
    if (!dragging) return;
    dragging = false;
    canvas.style.cursor = "";
    try {
      canvas.releasePointerCapture(ev.pointerId);
    } catch {}
    persistState();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const factor = Math.exp(ev.deltaY * 0.0012);
    commitPatch(
      { view: { distance: app.state.view.distance * factor } },
      { noPersist: true }
    );
  }, { passive: false });

  canvas.addEventListener("click", (ev) => {
    const hit = pickTerrain(ev.clientX, ev.clientY);
    if (hit) {
      app.probe = { u: hit.u, v: hit.v };
      app.probeScreen = { x: ev.clientX, y: ev.clientY };
      updateProbe();
      setStatusNote(`探针 @ u ${hit.u.toFixed(3)}, v ${hit.v.toFixed(3)}`);
    }
  });

  canvas.addEventListener("dblclick", () => {
    commitPatch({ view: { targetX: 0, targetZ: -28 } });
  });

  window.addEventListener("keydown", (ev) => {
    if (ev.target.tagName === "INPUT" || ev.target.tagName === "SELECT") return;
    const rotations = { ArrowLeft: -0.08, ArrowRight: 0.08 };
    if (rotations[ev.key]) {
      commitPatch({ view: { yaw: app.state.view.yaw + rotations[ev.key] } }, { noPersist: true });
    } else if (ev.key === "ArrowUp") {
      commitPatch({ view: { pitch: Math.min(1.45, app.state.view.pitch + 0.05) } }, { noPersist: true });
    } else if (ev.key === "ArrowDown") {
      commitPatch({ view: { pitch: Math.max(0.05, app.state.view.pitch - 0.05) } }, { noPersist: true });
    } else if (ev.key === "+" || ev.key === "=") {
      commitPatch({ view: { distance: app.state.view.distance * 0.9 } }, { noPersist: true });
    } else if (ev.key === "-") {
      commitPatch({ view: { distance: app.state.view.distance * 1.1 } }, { noPersist: true });
    }
  });
}

// March the terrain height field along the camera ray. Deterministic and only
// used for picking (not rendering).
function pickTerrain(clientX, clientY) {
  if (!app.renderer) return null;
  const rect = app.renderer.canvas.getBoundingClientRect();
  const localX = clientX - rect.left;
  const localY = clientY - rect.top;
  const { eye, dir } = app.renderer.pick(localX, localY, app.state);
  const p = normalizeHeightParams(app.state.height);
  const half = p.worldSize * 0.5;
  let prev = null;
  const maxDist = 4000;
  for (let t = 1; t < maxDist; t += Math.max(1, p.worldSize / 220)) {
    const x = eye[0] + dir[0] * t;
    const y = eye[1] + dir[1] * t;
    const z = eye[2] + dir[2] * t;
    const u = x / p.worldSize + 0.5;
    const v = z / p.worldSize + 0.5;
    if (u < 0 || u > 1 || v < 0 || v > 1) {
      prev = null;
      continue;
    }
    const h = sampleHeightField(u, v, p);
    if (prev && prev.y >= prev.h && y <= h) {
      // Linear refine between the two samples.
      const denom = prev.y - prev.h - (y - h);
      const frac = denom !== 0 ? (prev.y - prev.h) / denom : 0;
      const tu = prev.u + (u - prev.u) * frac;
      const tv = prev.v + (v - prev.v) * frac;
      return { u: Math.min(1, Math.max(0, tu)), v: Math.min(1, Math.max(0, tv)), point: [x, y, z] };
    }
    prev = { u, v, y, h };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Persistence buttons
// ---------------------------------------------------------------------------

function setupButtons() {
  $("#btn-reset-view").addEventListener("click", () => {
    commitPatch({ view: { targetX: 0, targetZ: -28, distance: 330, yaw: 0.62, pitch: 0.42 } });
  });
  $("#btn-pause").addEventListener("click", (ev) => {
    app.autoOrbit = !app.autoOrbit;
    ev.target.textContent = app.autoOrbit ? "暂停漫游" : "自动漫游";
    ev.target.classList.toggle("active", app.autoOrbit);
  });
  $("#btn-save").addEventListener("click", () => {
    const blob = new Blob([serializeState(app.state)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `terrain-fusion-${app.presetId}-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $("#btn-load").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const res = deserializeState(text);
    if (!res.ok) {
      renderWarnings([{ code: "import", message: `载入失败：${res.error}` }]);
      return;
    }
    app.state = res.state;
    app.warnings = res.warnings;
    renderWarnings();
    syncControls();
    updateDebugSelect();
    updateMappingNote();
    persistState();
    scheduleRebuild("已载入参数文件");
    updateProbe();
    updateHud();
    ev.target.value = "";
  });
  $("#btn-copy-state").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(serializeState(app.state));
      setStatusNote("参数 JSON 已复制到剪贴板");
    } catch (e) {
      setStatusNote(`复制失败：${e.message}`);
    }
  });
  $("#btn-paste-state").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      const res = deserializeState(text);
      if (!res.ok) throw new Error(res.error);
      app.state = res.state;
      app.warnings = res.warnings;
      renderWarnings();
      syncControls();
      updateDebugSelect();
      updateMappingNote();
      persistState();
      scheduleRebuild("已从剪贴板载入");
      updateProbe();
    } catch (e) {
      renderWarnings([{ code: "paste", message: `剪贴板载入失败：${e.message}` }]);
    }
  });
  $("#btn-baseline").addEventListener("click", () => {
    app.renderer.render(app.state);
    const url = app.renderer.canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `terrain-baseline-${app.presetId}.png`;
    a.click();
  });
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function frame(now) {
  try {
    if (app.renderer) {
      if (app.autoOrbit) {
        app.state = {
          ...app.state,
          view: { ...app.state.view, yaw: app.state.view.yaw + 0.0025 },
        };
      }
      app.renderer.render(app.state);
      updateProbeOverlay();
    }
    tickHud(now);
  } catch (e) {
    showError("渲染失败", e);
    console.error(e);
    return;
  }
  requestAnimationFrame(frame);
}

function updateProbeOverlay() {
  // The probe marker is drawn in the DOM for crispness; update its label only.
  if (app.probeScreen) {
    const hud = document.querySelector(".viewport-help");
    if (hud) hud.dataset.probe = `u ${app.probe.u.toFixed(2)} v ${app.probe.v.toFixed(2)}`;
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  try {
    const canvas = $("#viewport");
    app.renderer = new TerrainRenderer(canvas);
    buildWeightRows();
    renderDebugSelect();
    renderControls();
    renderPresets();
    setupInteraction(canvas);
    setupButtons();

    const stored = loadStoredState();
    if (stored) {
      app.state = stored;
      setStatusNote("已恢复本地保存的参数");
      renderWarnings([{ code: "restored", message: "已恢复 localStorage 中的参数；按“重置相机”可回到默认视角。" }]);
    }
    syncControls();
    updateDebugSelect();
    updateMappingNote();
    rebuild("初始构建");
    updateProbe();
    updateHud();
    clearError();
    requestAnimationFrame(frame);

    // Expose a tiny debug surface for automated tests; not used by the UI.
    window.__terrainApp = {
      getState: () => JSON.parse(JSON.stringify(app.state)),
      setState: (patch) => commitPatch(patch),
      getBuildStats: () => ({
        vertexCount: app.build?.vertexCount,
        triangleCount: app.build?.triangleCount,
        fallbackCount: app.build?.fallbackCount,
        maxWeightSumError: app.build?.maxWeightSumError,
        chunks: app.build?.chunks,
        segments: app.build?.segments,
        meshMemory: app.memory,
        rendererStats: { ...app.renderer.stats },
        lastBuildMs: app.lastBuildMs,
      }),
      getProbe: () => ({ ...app.probe }),
      setProbe: (u, v) => {
        app.probe = { u, v };
        updateProbe();
      },
      applyPreset: (id) => {
        const res = applyPreset(app.state, id);
        app.presetId = id;
        app.state = res.state;
        app.warnings = res.warnings;
        renderWarnings();
        syncControls();
        updateDebugSelect();
        updateMappingNote();
        renderPresets();
        persistState();
        rebuild("测试预设");
        updateProbe();
        updateHud();
        return { warnings: app.warnings };
      },
      commitPatch: (patch) => {
        commitPatch(patch);
        return { warnings: app.warnings };
      },
      probeScreenPoint: (u, v) => {
        // Convert a normalized terrain position to a window point via the
        // current camera, so tests can click an exact probe location.
        const p = normalizeHeightParams(app.state.height);
        const world = [(u - 0.5) * p.worldSize, sampleHeightField(u, v, p), (v - 0.5) * p.worldSize];
        const rect = app.renderer.canvas.getBoundingClientRect();
        const eye = app.renderer.cameraEye(app.state);
        const target = [app.state.view.targetX, app.state.height.maxHeight * 0.38, app.state.view.targetZ];
        const view = mat4LookAt(new Float32Array(16), eye, target, [0, 1, 0]);
        const proj = mat4Perspective(new Float32Array(16), (app.state.view.fov * Math.PI) / 180, rect.width / rect.height, 0.5, 4000);
        const vp = mat4Multiply(new Float32Array(16), proj, view);
        const out = new Float32Array(3);
        transformPoint4(out, vp, world);
        return { x: rect.left + ((out[0] * 0.5 + 0.5) * rect.width), y: rect.top + ((1 - (out[1] * 0.5 + 0.5)) * rect.height), visible: out[2] > -1 && out[2] < 1 };
      },
      serialize: () => serializeState(app.state),
      deserialize: (text) => deserializeState(text),
      renderNow: () => {
        const stats = app.renderer.render(app.state);
        return { ...stats };
      },
      pauseDrift: () => {
        app.autoOrbit = false;
        const btn = $("#btn-pause");
        btn.textContent = "自动漫游";
        btn.classList.remove("active");
      },
      screenshot: () => app.renderer.canvas.toDataURL("image/png"),
      getWarnings: () => app.warnings,
    };
    document.body.dataset.appReady = "1";
  } catch (e) {
    showError("初始化失败", e);
    console.error(e);
  }
}

boot();
