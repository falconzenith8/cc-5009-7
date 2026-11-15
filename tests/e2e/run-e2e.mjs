// End-to-end validation for the terrain-fusion preview.
//
//   node tests/e2e/run-e2e.mjs                  compare against tests/baselines
//   node tests/e2e/run-e2e.mjs --update-baselines
//
// Starts the real server, drives the app through window.__terrainApp and
// inspects the DOM panels and the rendered canvas. Screenshots come from
// canvas.toDataURL (preserveDrawingBuffer), not page.screenshot, so the WebGL
// contents are deterministic under SwiftShader.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { launchBrowser } from "./browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASELINE_DIR = path.join(ROOT, "tests/baselines");
const UPDATE = process.argv.includes("--update-baselines");
const VIEWPORT = { width: 1500, height: 940 };
const SCENES = ["default", "plane", "cliff", "chunkEdge", "zeroWeights", "weights"];

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function startServer(port) {
  const proc = spawn("node", [path.join(ROOT, "server.js"), "--port", String(port), "--host", "127.0.0.1"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { method: "GET" });
      if (res.ok) return proc;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  proc.kill();
  throw new Error(`server did not start: ${stderr}`);
}

function decodePng(dataUrl) {
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  return PNG.sync.read(Buffer.from(base64, "base64"));
}

function readBaseline(id) {
  const file = path.join(BASELINE_DIR, `${id}.png`);
  if (!fs.existsSync(file)) return null;
  return PNG.sync.read(fs.readFileSync(file));
}

function writeBaseline(id, png) {
  fs.mkdirSync(BASELINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(BASELINE_DIR, `${id}.png`), PNG.sync.write(png));
}

// Fraction of pixels whose channel delta exceeds `channelTolerance`, plus the mean delta.
function diffPng(a, b, channelTolerance = 26) {
  if (a.width !== b.width || a.height !== b.height) {
    return { comparable: false, changed: 1, mean: 255 };
  }
  let changed = 0;
  let sum = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = Math.max(
      Math.abs(a.data[o] - b.data[o]),
      Math.abs(a.data[o + 1] - b.data[o + 1]),
      Math.abs(a.data[o + 2] - b.data[o + 2])
    );
    sum += d;
    if (d > channelTolerance) changed++;
  }
  return { comparable: true, changed: changed / n, mean: sum / n };
}

function imageStats(png) {
  let sum = 0;
  let sumSq = 0;
  let alphaOk = true;
  const n = png.width * png.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const lum = 0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2];
    sum += lum;
    sumSq += lum * lum;
    if (png.data[o + 3] !== 255) alphaOk = false;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  return { mean, std: Math.sqrt(Math.max(0, variance)), alphaOk };
}

async function shoot(page) {
  return decodePng(
    await page.evaluate(() => {
      window.__terrainApp.renderNow();
      return window.__terrainApp.screenshot();
    })
  );
}

async function waitReady(page) {
  await page.waitForFunction(() => document.body.dataset.appReady === "1", null, { timeout: 30000 });
  await page.evaluate(() => window.__terrainApp.pauseDrift());
}

async function applyScene(page, id) {
  await page.evaluate((scene) => {
    window.__terrainApp.applyPreset(scene);
    window.__terrainApp.renderNow();
  }, id);
  // Let the render loop settle and force one more deterministic frame.
  await page.waitForTimeout(120);
  return shoot(page);
}

async function main() {
  const port = await findFreePort();
  const server = await startServer(port);
  const browser = await launchBrowser();
  const page = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
  });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(msg.text());
  });

  try {
    const url = `http://127.0.0.1:${port}/`;
    await page.goto(url, { waitUntil: "load" });
    await waitReady(page);
    check("app boots without page errors", pageErrors.length === 0, pageErrors.join(" | "));

    // --- Canvas is a real lit render, not a flat color card -----------------
    const firstFrame = await shoot(page);
    const stats = imageStats(firstFrame);
    check("canvas has a non-trivial image", stats.std > 8, `std ${stats.std.toFixed(1)} mean ${stats.mean.toFixed(1)}`);
    check("screenshot is fully opaque", stats.alphaOk);
    check("canvas is a real webgl2 surface", (await page.evaluate(() => {
      const c = document.getElementById("viewport");
      return !!c.getContext("webgl2") && c.width > 100;
    })));

    // --- UI panels are populated -------------------------------------------
    const ui = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#weight-rows tr")];
      const memRows = [...document.querySelectorAll("#memory-rows tr")];
      return {
        groups: document.querySelectorAll("#control-groups details").length,
        presets: document.querySelectorAll("#presets button").length,
        weightRows: rows.length,
        weights: rows.map((r) => ({
          id: r.dataset.material,
          raw: r.querySelector("[data-raw]").textContent,
          norm: r.querySelector("[data-norm]").childNodes[0].nodeValue,
        })),
        memoryRows: memRows.map((r) => [...r.children].map((c) => c.textContent)),
        albedo: document.getElementById("sum-albedo").textContent,
        roughness: document.getElementById("sum-roughness").textContent,
        normal: document.getElementById("sum-normal").textContent,
        fallback: document.getElementById("sum-fallback").textContent,
        mappingNote: document.getElementById("mapping-note").textContent,
      };
    });
    check("control schema rendered in UI", ui.groups >= 6, `${ui.groups} groups`);
    check("preset buttons rendered", ui.presets >= SCENES.length, `${ui.presets} presets`);
    check("three weight rows", ui.weightRows === 3, ui.weights.map((w) => w.id).join(","));
    const normalizedSum = ui.weights.reduce((s, w) => s + Number(w.norm), 0);
    check("visible normalized weights sum to 1", Math.abs(normalizedSum - 1) < 0.005, normalizedSum.toFixed(4));
    check("result area shows material composition",
      ui.albedo.startsWith("[") && ui.roughness.length > 0 && ui.normal.startsWith("[") && ui.fallback.length > 0);
    check("mapping note explains seams", ui.mappingNote.includes("接缝"), "note present");

    const memText = ui.memoryRows.map((r) => r.join(":")).join(" | ");
    check("memory panel reports real bytes", ui.memoryRows.length >= 6 && /(KiB|MiB|B)\b/.test(memText), memText.slice(0, 120));

    // --- Probe click drives the inspector ---------------------------------
    const point = await page.evaluate(() => window.__terrainApp.probeScreenPoint(0.5, 0.6));
    check("probe target is on screen", point.visible, JSON.stringify(point));
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(80);
    const probe = await page.evaluate(() => ({
      text: document.getElementById("probe-uv").textContent,
      height: document.getElementById("probe-height").textContent,
      slope: document.getElementById("probe-slope").textContent,
      norm: document.getElementById("probe-norm").textContent,
      app: window.__terrainApp.getProbe(),
    }));
    check("clicking terrain moves the probe", /u 0\.\d+ · v 0\.\d+/.test(probe.text) && probe.app.u > 0 && probe.app.u < 1,
      `${probe.text} (${probe.app.u.toFixed(2)}, ${probe.app.v.toFixed(2)})`);
    check("probe reports height and slope", /m$/.test(probe.height) && /°/.test(probe.slope));

    // --- Zero-weight preset engages the documented fallback -----------------
    const zeroBuild = await page.evaluate(() => {
      window.__terrainApp.applyPreset("zeroWeights");
      window.__terrainApp.setProbe(0.34, 0.52);
      return window.__terrainApp.getBuildStats();
    });
    check("zero-weight patch exists in the mesh", zeroBuild.fallbackCount > 0, `${zeroBuild.fallbackCount} fallback vertices`);
    const probeZero = await page.evaluate(() => ({
      norm: document.getElementById("probe-norm").textContent,
      fallback: document.getElementById("sum-fallback").textContent,
      albedo: document.getElementById("sum-albedo").textContent,
      swatch: document.getElementById("swatch-main").style.background,
    }));
    check("probe at patch centre reports fallback", probeZero.norm.includes("回退"), probeZero.norm);
    check("fallback result has a defined color", /rgb\(\d+,\s*\d+,\s*\d+\)/.test(probeZero.swatch), probeZero.swatch);
    check("fallback readout flags rock = 1", probeZero.fallback.includes("岩石 1.0"), probeZero.fallback);

    // --- Failure feedback flows back through the kernel into the UI --------
    const bad = await page.evaluate(() => window.__terrainApp.commitPatch({
      rules: { slopeStart: 0.9, slopeEnd: 0.1, lowAltitude: 0.9, highAltitude: 0.2 },
    }));
    await page.waitForTimeout(60);
    const warningText = await page.evaluate(() => document.getElementById("warnings").textContent);
    check("invalid bands produce kernel warnings", bad.warnings.length > 0, `${bad.warnings.length} warnings`);
    check("warnings are surfaced in the UI", warningText.length > 0, warningText.slice(0, 80));
    const repaired = await page.evaluate(() => {
      const s = window.__terrainApp.getState();
      return { start: s.rules.slopeStart, end: s.rules.slopeEnd, low: s.rules.lowAltitude, high: s.rules.highAltitude };
    });
    check("kernel repairs invalid slope band", repaired.end > repaired.start, JSON.stringify(repaired));

    // --- Persistence round-trip through JSON and localStorage -------------
    const persist = await page.evaluate(() => {
      window.__terrainApp.applyPreset("default");
      window.__terrainApp.commitPatch({ height: { maxHeight: 210, seed: 2026 }, rules: { manual: { vegetation: 0.6 } } });
      const json = window.__terrainApp.serialize();
      const back = window.__terrainApp.deserialize(json);
      const ls = localStorage.getItem("terrain-fusion-preview-state-v3");
      return { ok: back.ok, height: back.state.height.maxHeight, veg: back.state.rules.manual.vegetation, stored: !!ls && ls.length > 100 };
    });
    check("JSON round-trip preserves parameters", persist.ok && persist.height === 210 && Math.abs(persist.veg - 0.6) < 1e-9, JSON.stringify(persist));
    check("parameters auto-persist to localStorage", persist.stored);

    // --- Texture scale independent of mesh subdivision --------------------
    // In triplanar world-space mapping, changing LOD must not rescale the
    // pattern. Mesh-UV mode (deliberately wrong) must visibly slide.
    const lodA = await page.evaluate(() => {
      window.__terrainApp.applyPreset("default");
      window.__terrainApp.commitPatch({ mapping: { mode: 0 }, quality: { debugMode: "final", lod: 192 } });
      window.__terrainApp.renderNow();
      return window.__terrainApp.screenshot();
    });
    const lodB = await page.evaluate(() => {
      window.__terrainApp.commitPatch({ quality: { lod: 320 } });
      window.__terrainApp.renderNow();
      return window.__terrainApp.screenshot();
    });
    const uvA = await page.evaluate(() => {
      window.__terrainApp.commitPatch({ mapping: { mode: 2 }, quality: { lod: 96 } });
      window.__terrainApp.renderNow();
      return window.__terrainApp.screenshot();
    });
    const uvB = await page.evaluate(() => {
      window.__terrainApp.commitPatch({ quality: { lod: 320 } });
      window.__terrainApp.renderNow();
      return window.__terrainApp.screenshot();
    });
    // Tolerance 8 isolates genuine pattern movement; the triplanar render is
    // pixel-identical across subdivision, while mesh-UV tiles visibly rescale.
    const triplanarShift = diffPng(decodePng(lodA), decodePng(lodB), 8);
    const meshUvShift = diffPng(decodePng(uvA), decodePng(uvB), 8);
    check("triplanar pattern is pixel-stable across LOD", triplanarShift.changed < 0.005,
      `changed ${(triplanarShift.changed * 100).toFixed(2)}% (mean ${triplanarShift.mean.toFixed(2)})`);
    check("mesh-UV mode demonstrably slides with LOD", meshUvShift.changed > triplanarShift.changed + 0.008,
      `mesh-UV ${(meshUvShift.changed * 100).toFixed(2)}% vs triplanar ${(triplanarShift.changed * 100).toFixed(2)}%`);

    // --- Chunked mesh stays crack-free and renders ------------------------
    const chunkInfo = await page.evaluate(() => {
      window.__terrainApp.applyPreset("chunkEdge");
      const s = window.__terrainApp.getBuildStats();
      return { chunks: s.chunks, vertices: s.vertexCount, sumError: s.maxWeightSumError, rendererChunks: s.rendererStats.drawCalls };
    });
    check("chunked build uses multiple chunks", chunkInfo.chunks >= 2, `${chunkInfo.chunks}`);
    check("weight sums stay normalized in chunked mesh", chunkInfo.sumError < 1e-6, chunkInfo.sumError);

    // --- Screenshot baselines --------------------------------------------
    for (const id of SCENES) {
      const png = await applyScene(page, id);
      const sceneStats = imageStats(png);
      check(`scene ${id} renders a lit image`, sceneStats.std > 5 && sceneStats.alphaOk, `std ${sceneStats.std.toFixed(1)}`);

      if (UPDATE) {
        writeBaseline(id, png);
        continue;
      }
      const baseline = readBaseline(id);
      if (!baseline) {
        check(`baseline ${id} exists`, false, "run npm run baselines");
        continue;
      }
      const d = diffPng(baseline, png);
      check(`scene ${id} matches baseline`, d.comparable && d.changed < 0.02 && d.mean < 6,
        `changed ${(d.changed * 100).toFixed(2)}% mean ${d.mean.toFixed(2)}`);
    }

    // --- No page errors accumulated during the whole run ------------------
    check("no runtime errors during validation", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  } finally {
    await browser.close().catch(() => {});
    server.kill("SIGTERM");
  }

  console.log(`\n${failures === 0 ? "All E2E checks passed" : failures + " E2E check(s) failed"}.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
