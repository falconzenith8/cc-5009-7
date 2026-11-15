import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PACK_ASSET_VERSION,
  FUSION_CONTRACT_V2,
  LEGACY_GPU_FUSION_CONTRACT_V1,
  DEFAULT_MATERIAL_PACK_V2,
  COLOR_SPACE_SRGB,
  COLOR_SPACE_LINEAR,
  CHANNEL_ROUGHNESS,
  CHANNEL_TANGENT_NORMAL,
  CHANNEL_FUSION_WEIGHT,
  resolveChannel,
} from "../../src/kernel/materialPack.js";
import {
  migrateMaterialAsset,
  migrateTextureChannels,
  migrateFusionConfig,
  measureSemanticPreservation,
  assertPackIsV2,
  LEGACY_DEFAULTS_V1,
  MIGRATION_STATUS,
} from "../../src/kernel/materialMigration.js";
import { verifyPackAgainstLock, buildLock, computePackHash, fnv1aHash, canonicalJson } from "../../src/kernel/assetLock.js";
import { createMigrationJournal, createMemoryStore, JOURNAL_EVENT } from "../../src/kernel/migrationJournal.js";
import { loadMaterialAsset } from "../../src/kernel/materialLoader.js";
import { glslFusionContract } from "../../src/render/shaders.js";
import { normalizeWeights, evaluateRawWeights, sampleHeightNormal, sampleHeightField, DEFAULT_MATERIAL_RULES } from "../../src/kernel/terrain.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ---------------------------------------------------------------------------
// Pack declarations
// ---------------------------------------------------------------------------

test("v2 pack explicitly declares color space and channel semantics for every texture", () => {
  assert.equal(DEFAULT_MATERIAL_PACK_V2.assetVersion, PACK_ASSET_VERSION);
  for (const id of ["rock", "soil", "vegetation"]) {
    const m = DEFAULT_MATERIAL_PACK_V2.materials[id];
    const alb = m.textures.albedoRoughness;
    assert.equal(alb.internalFormat, "SRGB8_ALPHA8");
    assert.equal(alb.colorSpace.rgb, COLOR_SPACE_SRGB);
    assert.equal(alb.colorSpace.alpha, COLOR_SPACE_LINEAR);
    const rough = resolveChannel(DEFAULT_MATERIAL_PACK_V2, id, "albedoRoughness", "A");
    assert.equal(rough.semantic, CHANNEL_ROUGHNESS);
    assert.equal(rough.colorSpace, COLOR_SPACE_LINEAR);
    const nrm = m.textures.normal;
    assert.equal(nrm.internalFormat, "RGBA8");
    assert.equal(nrm.colorSpace.rgb, COLOR_SPACE_LINEAR);
    const nx = resolveChannel(DEFAULT_MATERIAL_PACK_V2, id, "normal", "R");
    assert.equal(nx.semantic, CHANNEL_TANGENT_NORMAL);
    assert.equal(nx.axis, "x");
  }
});

test("weight buffer layout declares fusion weights and the vertex-flag channel", () => {
  const layout = DEFAULT_MATERIAL_PACK_V2.weightBuffer.layout;
  assert.equal(layout.length, 4);
  assert.deepEqual(layout.slice(0, 3).map((c) => c.semantic), [CHANNEL_FUSION_WEIGHT, CHANNEL_FUSION_WEIGHT, CHANNEL_FUSION_WEIGHT]);
  assert.equal(layout[3].semantic, "vertexFlag");
  assert.deepEqual(Object.keys(layout[3].enum), ["0", "1", "2"]);
  assert.equal(DEFAULT_MATERIAL_PACK_V2.weightBuffer.normalization, "partition-of-unity");
  assert.equal(DEFAULT_MATERIAL_PACK_V2.weightBuffer.weightEpsilon, 1e-8);
});

test("pack normalization rule is partition of unity with a declared fallback material", () => {
  assert.equal(FUSION_CONTRACT_V2.normalization, "partition-of-unity");
  assert.equal(FUSION_CONTRACT_V2.fallback.materialId, "rock");
  assert.equal(FUSION_CONTRACT_V2.fallback.weight, 1);
  const n = normalizeWeights({ rock: 0, soil: 0, vegetation: 0 });
  assert.equal(n.fallback, true);
  assert.equal(n.epsilon, FUSION_CONTRACT_V2.weightEpsilon);
  assert.deepEqual(n.weights, { rock: 1, soil: 0, vegetation: 0 });
});

// ---------------------------------------------------------------------------
// CPU / GPU fusion contract parity (the new-vs-old terrain fusion contract)
// ---------------------------------------------------------------------------

test("GLSL-emitted fusion coefficients are exactly the v2 CPU contract", () => {
  const gpu = glslFusionContract();
  const c = FUSION_CONTRACT_V2.coefficients;
  assert.deepEqual(gpu.coeffs[0], [c.baseRock, c.slopeRock, c.highRock, c.midRock]);
  assert.deepEqual(gpu.coeffs[1], [c.baseSoil, c.soilFlat, c.lowSoil, c.midSoil]);
  assert.deepEqual(gpu.coeffs[2], [c.soilGain, c.baseVeg, c.midVeg, c.lowVeg]);
  assert.deepEqual(gpu.coeffs[3], [c.vegGain, FUSION_CONTRACT_V2.manualGain, FUSION_CONTRACT_V2.vegetationSlopeTransition, FUSION_CONTRACT_V2.weightEpsilon]);
  assert.equal(gpu.fallbackMaterialId, FUSION_CONTRACT_V2.fallback.materialId);
  // Every uploaded uniform component must be a finite number; a single NaN
  // (e.g. a coefficient read from the wrong contract level) poisons the whole
  // weight sum and forces the shader into the all-zero fallback.
  for (const row of gpu.coeffs) {
    for (const value of row) assert.ok(Number.isFinite(value), `non-finite fusion uniform: ${value}`);
  }
});

test("v1 legacy GPU contract differs from v2 and is retained only as migration evidence", () => {
  assert.notEqual(LEGACY_GPU_FUSION_CONTRACT_V1.contractId, FUSION_CONTRACT_V2.contractId);
  assert.notDeepEqual(LEGACY_GPU_FUSION_CONTRACT_V1.coefficients, FUSION_CONTRACT_V2.coefficients);
  assert.equal(LEGACY_GPU_FUSION_CONTRACT_V1.coefficients.baseRock, 0.06);
  assert.equal(FUSION_CONTRACT_V2.coefficients.baseRock, 0.05);
});

test("CPU kernel raw weights use the declared v2 coefficients, not literals", () => {
  const p = {};
  const normal = sampleHeightNormal(0.5, 0.5, p);
  const height = sampleHeightField(0.5, 0.5, p);
  const raw = evaluateRawWeights(normal, height, p, DEFAULT_MATERIAL_RULES);
  assert.ok(Number.isFinite(raw.rock) && Number.isFinite(raw.soil) && Number.isFinite(raw.vegetation));
  // Manual gain must come from the contract.
  const boosted = evaluateRawWeights(normal, height, p, {
    ...DEFAULT_MATERIAL_RULES,
    manual: { rock: 1, soil: 0, vegetation: 0 },
  });
  assert.ok(Math.abs((boosted.rock - raw.rock) - FUSION_CONTRACT_V2.manualGain) < 1e-12);
});

// ---------------------------------------------------------------------------
// Texture channel migration: missing channels + boundary pixels
// ---------------------------------------------------------------------------

test("missing albedo alpha is filled with declared linear roughness and recorded", () => {
  const size = 8;
  const bytes = new Uint8Array(size * size * 4);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17) & 0xff;
  const migrated = migrateTextureChannels("rock", "albedoRoughness", bytes, {
    size,
    presentMask: [true, true, true, false],
    missingRoughness: 0.84,
  });
  assert.equal(migrated.channelsFilled.length, 1);
  assert.equal(migrated.channelsFilled[0].repair, "roughness-channel-filled");
  // Filled alpha equals the declared roughness byte everywhere.
  const roughByte = Math.round(0.84 * 255);
  for (let i = 0; i < size * size; i++) assert.equal(migrated.bytes[i * 4 + 3], roughByte);
  // Existing RGB channels survive, including boundary pixels.
  for (let i = 0; i < size * size; i++) {
    for (let c = 0; c < 3; c++) assert.equal(migrated.bytes[i * 4 + c], bytes[i * 4 + c]);
  }
  assert.equal(migrated.declaration.channels[3].semantic, CHANNEL_ROUGHNESS);
  assert.equal(migrated.declaration.internalFormat, "SRGB8_ALPHA8");
});

test("missing normal channels fall back to the flat tangent normal and keep height", () => {
  const size = 4;
  const bytes = new Uint8Array(size * size * 4).fill(200);
  const migrated = migrateTextureChannels("vegetation", "normal", bytes, {
    size,
    presentMask: [false, false, false, true],
  });
  assert.equal(migrated.channelsFilled.length, 3);
  for (let i = 0; i < size * size; i++) {
    assert.equal(migrated.bytes[i * 4], LEGACY_DEFAULTS_V1.missingNormalTexel[0]);
    assert.equal(migrated.bytes[i * 4 + 1], LEGACY_DEFAULTS_V1.missingNormalTexel[1]);
    assert.equal(migrated.bytes[i * 4 + 2], LEGACY_DEFAULTS_V1.missingNormalTexel[2]);
    assert.equal(migrated.bytes[i * 4 + 3], 200); // preserved height
  }
});

test("boundary texels of provided channels are bit-identical after migration", () => {
  const size = 16;
  const bytes = new Uint8Array(size * size * 4);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  const migrated = migrateTextureChannels("soil", "albedoRoughness", bytes, { size });
  const ev = migrated.boundaryEvidence;
  for (const name of ["R", "G", "B", "A"]) {
    assert.deepEqual(ev.migrated[name], ev.source[name]);
  }
});

// ---------------------------------------------------------------------------
// Whole-asset joint conversion
// ---------------------------------------------------------------------------

test("joint migration converts the legacy fixture and refuses metadata-only bumps", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/legacy-v1-asset.json"), "utf8"));
  const legacy = {
    assetVersion: fixture.version,
    textures: fixture.state.textures,
    config: { rules: fixture.state.rules, params: fixture.state.height },
  };
  // base64 -> bytes
  for (const id of Object.keys(legacy.textures)) {
    for (const kind of Object.keys(legacy.textures[id])) {
      const t = legacy.textures[id][kind];
      t.bytes = new Uint8Array(Buffer.from(t.bytesBase64, "base64"));
      delete t.bytesBase64;
    }
  }
  const result = migrateMaterialAsset(legacy);
  assert.equal(result.ok, true);
  assert.equal(result.report.status, MIGRATION_STATUS.MIGRATED_WITH_REPAIRS);
  // rock alpha + soil normal (4) + vegetation normal RGB (3) = 8 repairs.
  assert.ok(result.report.channelsFilled.length >= 8, JSON.stringify(result.report.channelsFilled));
  assert.ok(result.report.defaultsConverted.length >= 1);
  assertPackIsV2(result.pack);

  // A metadata-only bump (version 2 without declarations) must be rejected.
  const fake = { assetVersion: PACK_ASSET_VERSION, foo: "bar" };
  assert.throws(() => assertPackIsV2(fake), /not a valid v2 material pack/);
  assert.throws(() => migrateMaterialAsset(fake), /not a valid v2 material pack/);
});

test("semantic preservation evidence covers fusion weights, slopes and boundary pixels", () => {
  const evidence = measureSemanticPreservation({ params: {}, rules: DEFAULT_MATERIAL_RULES });
  assert.ok(evidence.points.length >= 4);
  assert.ok(evidence.steepPointCount >= 1, "at least one steep/slope sample must be measured");
  assert.ok(evidence.steepLabels.includes("cliff-band") || evidence.steepLabels.includes("steep-face"));
  for (const pt of evidence.points) {
    const sum = pt.v2Weights.rock + pt.v2Weights.soil + pt.v2Weights.vegetation;
    assert.ok(Math.abs(sum - 1) < 1e-9 || pt.fallback, `partition of unity at ${pt.label}`);
    assert.ok(pt.maxWeightDelta >= 0 && pt.maxWeightDelta <= 1);
  }
  assert.ok(evidence.weightDeltaMax >= evidence.weightDeltaMean - 1e-12);
});

test("fusion config migration records every converted legacy default", () => {
  const migrated = migrateFusionConfig({ rules: {} });
  assert.equal(migrated.contractId, FUSION_CONTRACT_V2.contractId);
  const paths = migrated.defaultsConverted.map((d) => d.path);
  assert.ok(paths.includes("fusionContract"));
  assert.ok(paths.includes("rules.zeroWeightPatch"));
  assert.ok(paths.includes("rules.manual"));
  // Explicit fields are not reported as converted defaults.
  const explicit = migrateFusionConfig({
    rules: { manual: { rock: 0, soil: 0, vegetation: 0 }, zeroWeightPatch: { enabled: false } },
  });
  assert.equal(explicit.defaultsConverted.some((d) => d.path === "rules.manual"), false);
});

// ---------------------------------------------------------------------------
// Asset lock
// ---------------------------------------------------------------------------

test("the committed build lock matches the live v2 pack hash", () => {
  const lockFile = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/terrain-material.lock.json"), "utf8"));
  const verification = verifyPackAgainstLock(DEFAULT_MATERIAL_PACK_V2, lockFile);
  assert.equal(verification.ok, true, verification.reasons.join("; "));
  assert.equal(lockFile.assetVersion, PACK_ASSET_VERSION);
  assert.equal(lockFile.contentHash, computePackHash());
});

test("lock verification fails on a tampered pack and records a live hash", () => {
  const lock = buildLock();
  const tampered = JSON.parse(JSON.stringify(DEFAULT_MATERIAL_PACK_V2));
  tampered.materials.rock.roughness = 0.1;
  const verification = verifyPackAgainstLock(tampered, lock);
  assert.equal(verification.ok, false);
  assert.ok(verification.reasons.some((r) => r.includes("content hash mismatch")));
  assert.ok(/^[0-9a-f]{8}$/.test(verification.liveHash));
});

test("canonical JSON is key-order independent", () => {
  const a = { x: 1, y: { b: 2, a: 3 } };
  const b = { y: { a: 3, b: 2 }, x: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(fnv1aHash("abc").length, 8);
});

// ---------------------------------------------------------------------------
// Journal + loader (version and rollback records)
// ---------------------------------------------------------------------------

test("migration journal records migrations, loads and rollbacks in order", () => {
  const journal = createMigrationJournal(createMemoryStore());
  const report = migrateMaterialAsset({ assetVersion: 1, config: { rules: {} } }).report;
  const e1 = journal.recordMigration(report, { source: "test" });
  assert.equal(e1.event, JOURNAL_EVENT.MIGRATED);
  assert.equal(e1.toVersion, PACK_ASSET_VERSION);
  const e2 = journal.recordLoad(PACK_ASSET_VERSION);
  assert.equal(e2.event, JOURNAL_EVENT.LOADED_V2);
  const e3 = journal.recordRollback(PACK_ASSET_VERSION, 1, "test rollback");
  assert.equal(e3.event, JOURNAL_EVENT.ROLLED_BACK);
  assert.equal(e3.reason, "test rollback");
  assert.equal(journal.entries().length >= 3, true);
  assert.equal(journal.last().seq, e3.seq);
});

test("loader accepts legacy projects through the v2 adaptation path", () => {
  const loaded = loadMaterialAsset({ assetVersion: 1, config: { rules: {}, params: {} } });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.migrated, true);
  assertPackIsV2(loaded.pack);
  const events = loaded.journal.entries().map((e) => e.event);
  assert.ok(events.includes(JOURNAL_EVENT.MIGRATED));
});

test("loader enforces the lock and records a rollback when allowed", () => {
  const lock = buildLock();
  const ok = loadMaterialAsset({ assetVersion: 1, config: { rules: {} } }, { lock });
  assert.equal(ok.ok, true);
  const tamperedLock = { ...lock, contentHash: "deadbeef" };
  const strict = loadMaterialAsset({ assetVersion: 1, config: { rules: {} } }, { lock: tamperedLock });
  assert.equal(strict.ok, false);
  const rolled = loadMaterialAsset({ assetVersion: 1, config: { rules: {} } }, { lock: tamperedLock, allowRollback: true });
  assert.equal(rolled.ok, true);
  assert.equal(rolled.rolledBack, true);
  assert.ok(rolled.journal.entries().some((e) => e.event === JOURNAL_EVENT.ROLLED_BACK));
});

test("migration never reports success from defaults alone: repairs are surfaced, not hidden", () => {
  const result = migrateMaterialAsset({ assetVersion: 1, config: { rules: {} } });
  assert.equal(result.ok, true);
  // With no texture payload and no material records, warnings + repairs must be
  // present in the report rather than a silent "success".
  assert.ok(Array.isArray(result.report.warnings));
  assert.ok(result.report.warnings.some((w) => w.includes("record missing")));
  assert.ok(result.report.channelsFilled.length > 0);
  assert.equal(result.report.status, MIGRATION_STATUS.MIGRATED_WITH_REPAIRS);
});
