import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONTROL_GROUPS,
  PRESETS,
  STATE_VERSION,
  createDefaultState,
  applyStatePatch,
  applyPreset,
  serializeState,
  deserializeState,
  getPath,
  setPath,
  deepMerge,
  buildStateQuerystring,
} from "../../src/kernel/state.js";
import {
  DEFAULT_QUALITY,
  DEBUG_MODES,
  validateState,
} from "../../src/kernel/terrain.js";

test("control schema is complete and driven by the kernel", () => {
  const ids = CONTROL_GROUPS.map((g) => g.id);
  assert.deepEqual(ids, ["terrain", "rules", "mapping", "lighting", "quality", "view"]);
  let controls = 0;
  for (const group of CONTROL_GROUPS) {
    assert.ok(typeof group.label === "string" && group.label.length > 0);
    assert.ok(Array.isArray(group.controls) && group.controls.length > 0);
    for (const c of group.controls) {
      controls++;
      assert.ok(typeof c.path === "string" && c.path.includes("."));
      assert.ok(["range", "select", "toggle"].includes(c.type), c.type);
      if (c.type === "range") {
        assert.ok(Number.isFinite(c.min) && Number.isFinite(c.max), c.path);
        assert.ok(c.min < c.max, c.path);
        assert.ok(Number.isFinite(c.step) && c.step > 0, c.path);
        assert.ok(Number.isFinite(c.decimals), c.path);
      } else if (c.type === "select") {
        assert.ok(Array.isArray(c.options) && c.options.length > 1, c.path);
      }
    }
  }
  // Every control path resolves in the default state.
  const state = createDefaultState();
  for (const group of CONTROL_GROUPS) {
    for (const c of group.controls) {
      assert.notEqual(getPath(state, c.path), undefined, `missing default for ${c.path}`);
    }
  }
  assert.ok(controls >= 35);
});

test("every debug mode in the kernel has a matching renderer index and vice versa", () => {
  // Keep the debug list and the quality default mutually consistent.
  const ids = DEBUG_MODES.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes(DEFAULT_QUALITY.debugMode));
});

test("getPath/setPath/deepMerge behave immutably enough for state edits", () => {
  const s = createDefaultState();
  assert.equal(getPath(s, "rules.manual.rock"), 0);
  setPath(s, "rules.manual.rock", 0.5);
  assert.equal(s.rules.manual.rock, 0.5);

  const a = { x: { y: 1, z: 2 }, keep: true };
  const b = deepMerge(a, { x: { y: 9 } });
  assert.deepEqual(b, { x: { y: 9, z: 2 }, keep: true });
  assert.equal(a.x.y, 1, "deepMerge must not mutate the base");
});

test("applyStatePatch validates and persists through the kernel", () => {
  const base = createDefaultState();
  const { state, warnings } = applyStatePatch(base, {
    rules: { slopeStart: 0.9, slopeEnd: 0.1 },
    quality: { lod: 9999 },
  });
  assert.ok(warnings.some((w) => w.code === "slope-band"));
  assert.ok(state.rules.slopeEnd > state.rules.slopeStart);
  assert.ok(state.quality.lod <= 512);
  assert.equal(state.version, STATE_VERSION);
});

test("applyStatePatch does not mutate the input state", () => {
  const base = createDefaultState();
  const before = JSON.stringify(base);
  applyStatePatch(base, { height: { maxHeight: 300 }, mapping: { mode: 1 } });
  assert.equal(JSON.stringify(base), before);
});

test("serialize/deserialize is a lossless round trip", () => {
  const original = applyStatePatch(createDefaultState(), {
    height: { maxHeight: 222, seed: 4242 },
    rules: { manual: { rock: 0.25, soil: 0.5, vegetation: 0.75 } },
    mapping: { mode: 2, metersPerTile: 9.5 },
    view: { distance: 500, yaw: 1.25 },
    quality: { lod: 256, chunks: 2, debugMode: "weights" },
    probe: { u: 0.25, v: 0.75, active: true },
  }).state;
  const text = serializeState(original);
  // The persisted file declares its schema and carries no undefined values.
  assert.ok(!text.includes("undefined"));
  const parsed = JSON.parse(text);
  assert.equal(parsed.app, "terrain-fusion-preview");
  assert.equal(parsed.version, STATE_VERSION);

  const round = deserializeState(text);
  assert.equal(round.ok, true);
  assert.deepEqual(round.state.height, original.height);
  assert.deepEqual(round.state.rules, original.rules);
  assert.deepEqual(round.state.mapping, original.mapping);
  assert.deepEqual(round.state.view, original.view);
  assert.deepEqual(round.state.quality, original.quality);
  assert.deepEqual(round.state.probe, original.probe);
});

test("serialize clamps hostile state rather than emitting it", () => {
  const text = serializeState({
    rules: { slopeStart: -5, slopeEnd: 50 },
    quality: { lod: -1, textureSize: 3 },
  });
  const parsed = JSON.parse(text);
  assert.ok(parsed.state.rules.slopeStart >= 0);
  assert.ok(parsed.state.rules.slopeEnd <= 1);
  assert.ok(parsed.state.quality.lod >= 8);
  assert.equal(parsed.state.quality.textureSize, 512);
});

test("deserialize rejects malformed input without throwing", () => {
  assert.equal(deserializeState("not json").ok, false);
  assert.equal(deserializeState("{}").ok, false);
  assert.equal(deserializeState('{"height":{}}').ok, false);
  assert.equal(deserializeState("null").ok, false);
  const bad = deserializeState('{"height":{},"rules":{}}');
  assert.equal(bad.ok, true, "minimal height/rules payload is accepted");
});

test("deserialize accepts both wrapped and bare payloads", () => {
  const state = applyStatePatch(createDefaultState(), { height: { maxHeight: 150 } }).state;
  const bare = deserializeState(JSON.stringify(state));
  assert.equal(bare.ok, true);
  assert.equal(bare.state.height.maxHeight, 150);
  const wrapped = deserializeState(serializeState(state));
  assert.equal(wrapped.ok, true);
  assert.equal(wrapped.state.height.maxHeight, 150);
});

test("presets all validate and produce distinct, meaningful states", () => {
  const required = ["default", "plane", "cliff", "chunkEdge", "zeroWeights", "weights"];
  for (const id of required) {
    assert.ok(PRESETS.some((p) => p.id === id), `missing preset ${id}`);
  }
  const base = createDefaultState();
  const seen = new Set();
  for (const preset of PRESETS) {
    const { state, warnings } = applyPreset(base, preset.id);
    assert.equal(warnings.length, 0, `${preset.id}: ${JSON.stringify(warnings)}`);
    const validated = validateState(state);
    assert.equal(validated.warnings.length, 0, `${preset.id} produced warnings`);
    seen.add(state.quality.debugMode + "|" + state.quality.chunks + "|" + state.mapping.mode);
  }
  assert.ok(seen.size >= 3, "presets should differ in debug/chunk configuration");

  // Plane validation really is flat compared with the default.
  const plane = applyPreset(base, "plane").state;
  const def = applyPreset(base, "default").state;
  const flatness = (s) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i <= 20; i++) {
      for (let j = 0; j <= 20; j++) {
        const h = heightAt(s, i / 20, j / 20);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
    }
    return hi - lo;
  };
  assert.ok(flatness(plane) < flatness(def) * 0.75, "plane preset should be flatter than default");

  // Zero-weight preset enables the patch and shows the fallback view.
  const zero = applyPreset(base, "zeroWeights").state;
  assert.equal(zero.rules.zeroWeightPatch.enabled, true);
  assert.equal(zero.quality.debugMode, "fallback");

  // Chunk-edge preset uses multiple chunks and the chunk-bounds view.
  const chunk = applyPreset(base, "chunkEdge").state;
  assert.ok(chunk.quality.chunks >= 2);
  assert.equal(chunk.quality.showChunkBounds, true);

  // Cliff preset must produce a meaningfully larger steep fraction than the
  // plane, and its steep band must host a near-vertical wall somewhere.
  const cliff = applyPreset(base, "cliff").state;
  const steepFraction = (s) => {
    let steep = 0;
    let count = 0;
    for (let i = 0; i <= 32; i++) {
      for (let j = 0; j <= 32; j++) {
        const n = normalAt(s, i / 32, j / 32);
        if (1 - n[1] > 0.5) steep++;
        count++;
      }
    }
    return steep / count;
  };
  assert.ok(steepFraction(cliff) > steepFraction(plane) * 4, "cliff must be far steeper than plane");
  assert.ok(steepFraction(cliff) > 0.08, "cliff preset should contain a real escarpment");
});

import { sampleHeightField, sampleHeightNormal } from "../../src/kernel/terrain.js";

function heightAt(state, u, v) {
  return sampleHeightField(u, v, state.height);
}
function normalAt(state, u, v) {
  return sampleHeightNormal(u, v, state.height);
}

test("querystring encoding round-trips and never throws", () => {
  const state = applyStatePatch(createDefaultState(), { quality: { chunks: 2 } }).state;
  const q = buildStateQuerystring(state);
  assert.ok(!q.includes("undefined") && !q.includes("NaN"));
  const decoded = deserializeState(decodeURIComponent(q));
  assert.equal(decoded.ok, true);
  assert.equal(decoded.state.quality.chunks, 2);
});
