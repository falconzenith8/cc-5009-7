#!/usr/bin/env node
// Command-line helper for the terrain material asset migration.
//
// The graphical preview window remains the primary entry point; this CLI only
// assists the same joint conversion that the UI runs:
//
//   node tools/migration/migrate-material-asset.mjs \
//     --input  path/to/legacy-asset.json   (v1 material asset / project JSON)
//     --output path/to/migrated-v2.json    (v2 pack + migration report)
//     --lock   assets/terrain-material.lock.json
//     --evidence tests/evidence/migration.json
//
// A metadata-only version bump fails the strict v2 assertion. Missing texture
// channels are repaired with declared defaults and recorded, never silently
// accepted. Exit code is non-zero on rejection or lock mismatch.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { migrateMaterialAsset, assertPackIsV2 } from "../../src/kernel/materialMigration.js";
import { verifyPackAgainstLock, buildLock } from "../../src/kernel/assetLock.js";
import { createMigrationJournal, createMemoryStore } from "../../src/kernel/migrationJournal.js";
import { PACK_ASSET_VERSION, LEGACY_PACK_ASSET_VERSION } from "../../src/kernel/materialPack.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith("--")) {
      const name = key.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[name] = true;
      } else {
        args[name] = next;
        i++;
      }
    }
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Legacy texture byte payloads may be base64 in JSON fixtures.
function decodeTexturePayload(payload) {
  if (!payload) return undefined;
  if (payload.bytesBase64) {
    return { ...payload, bytes: new Uint8Array(Buffer.from(payload.bytesBase64, "base64")) };
  }
  return payload;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.input) {
    process.stdout.write(
      [
        "Usage: migrate-material-asset.mjs --input <legacy.json> [--output <v2.json>] [--lock <lock.json>] [--evidence <report.json>]",
        "",
        "Migrates a legacy (v1/version-less) terrain material asset or project to the",
        "explicitly declared v2 pack. The GUI preview is the primary entry point; this",
        "CLI only assists the same joint conversion.",
        "",
      ].join("\n")
    );
    process.exit(args.help ? 0 : 2);
  }

  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath)) fail(`input not found: ${inputPath}`);
  const raw = readJson(inputPath);
  // Accept either a wrapped project file ({state:{...}}) or a bare asset.
  const projectState = raw.state && raw.state.rules ? raw.state : raw;
  const legacyAsset = {
    assetVersion: projectState.assetVersion ?? raw.version ?? LEGACY_PACK_ASSET_VERSION,
    materials: projectState.materials,
    textures: projectState.textures
      ? Object.fromEntries(
          Object.entries(projectState.textures).map(([id, maps]) => [
            id,
            Object.fromEntries(Object.entries(maps).map(([kind, p]) => [kind, decodeTexturePayload(p)])),
          ])
        )
      : undefined,
    config: { rules: projectState.rules, params: projectState.height },
  };

  const result = migrateMaterialAsset(legacyAsset);
  if (!result.ok) {
    fail(`migration rejected: ${result.error?.message || "unknown reason"}`);
  }
  // The strict v2 assertion is also run independently so a tampered migrator
  // cannot return an under-declared pack behind ok:true.
  assertPackIsV2(result.pack);

  const journal = createMigrationJournal(createMemoryStore());
  journal.recordMigration(result.report, { source: "cli", input: path.relative(ROOT, inputPath) });

  let lock = null;
  let lockVerification = null;
  if (args.lock) {
    const lockPath = path.resolve(args.lock);
    if (!fs.existsSync(lockPath)) fail(`lock file not found: ${lockPath}`);
    lock = readJson(lockPath);
    lockVerification = verifyPackAgainstLock(result.pack, lock);
    if (!lockVerification.ok) {
      fail(`asset lock verification failed: ${lockVerification.reasons.join("; ")}`);
    }
  } else {
    lock = buildLock(result.pack);
    lockVerification = verifyPackAgainstLock(result.pack, lock);
  }

  const output = {
    assetVersion: PACK_ASSET_VERSION,
    pack: stripFunctions(result.pack),
    lock: lockVerification,
    report: result.report,
    journal: journal.entries(),
  };

  if (args.output) {
    const outPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
  }

  if (args.evidence) {
    const evidencePath = path.resolve(args.evidence);
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    const evidence = buildEvidence(result, lockVerification, inputPath);
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  }

  process.stdout.write(
    [
      `migration ${result.report.status}`,
      `  source asset version : ${result.report.sourceVersion}`,
      `  target asset version : ${result.report.targetVersion}`,
      `  channels filled      : ${result.report.channelsFilled.length}`,
      `  defaults converted   : ${result.report.defaultsConverted.length}`,
      `  weight delta max     : ${result.report.semanticPreservation.weightDeltaMax.toFixed(6)}`,
      `  weight delta mean    : ${result.report.semanticPreservation.weightDeltaMean.toFixed(6)}`,
      `  steep sample points  : ${result.report.semanticPreservation.steepPointCount} (${result.report.semanticPreservation.steepLabels.join(", ")})`,
      `  boundary pixels      : ${result.report.semanticPreservation.allBoundariesIdentical ? "identical" : "DIFFER"}`,
      `  lock verification    : ${lockVerification.ok ? "ok" : "FAIL"} (hash ${lockVerification.liveHash})`,
      args.output ? `  written to           : ${path.relative(ROOT, path.resolve(args.output))}` : "",
      args.evidence ? `  evidence written to  : ${path.relative(ROOT, path.resolve(args.evidence))}` : "",
      "",
    ]
      .filter(Boolean)
      .join("\n")
  );
  process.exit(0);
}

function buildEvidence(result, lockVerification, inputPath) {
  const preservation = result.report.semanticPreservation;
  const canonical = JSON.stringify(stripFunctions(result.pack));
  return {
    generatedAt: new Date().toISOString(),
    input: path.relative(ROOT, inputPath),
    sourceVersion: result.report.sourceVersion,
    targetVersion: result.report.targetVersion,
    status: result.report.status,
    packSha256: createHash("sha256").update(canonical).digest("hex"),
    lock: { ok: lockVerification.ok, liveHash: lockVerification.liveHash, reasons: lockVerification.reasons },
    fusionWeights: preservation.points.map((p) => ({
      label: p.label,
      u: p.u,
      v: p.v,
      slope: Number(p.slope.toFixed(6)),
      legacy: roundWeights(p.legacyWeights),
      v2: roundWeights(p.v2Weights),
      maxWeightDelta: Number(p.maxWeightDelta.toFixed(6)),
      fallback: p.fallback,
    })),
    boundaryPixels: preservation.boundaryPixels,
    channelsFilled: result.report.channelsFilled,
    defaultsConverted: result.report.defaultsConverted,
  };
}

function roundWeights(w) {
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Number(v.toFixed(6))]));
}

function stripFunctions(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(message) {
  process.stderr.write(`migrate-material-asset: ${message}\n`);
  process.exit(1);
}

main();
