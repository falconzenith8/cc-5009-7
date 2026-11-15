// Material asset loader.
//
// Reads either a legacy (v1, or version-less) material asset/project or a v2
// pack, runs the joint migration when needed, verifies the live pack against
// the build lock, and records every version decision in the migration journal.
// Legacy projects therefore keep loading, but only through the real v2
// adaptation path — never by reinterpreting old channels under a bumped label.

import {
  PACK_ASSET_VERSION,
  LEGACY_PACK_ASSET_VERSION,
  DEFAULT_MATERIAL_PACK_V2,
} from "./materialPack.js";
import { migrateMaterialAsset, assertPackIsV2 } from "./materialMigration.js";
import { verifyPackAgainstLock } from "./assetLock.js";
import { createMigrationJournal, createMemoryStore } from "./migrationJournal.js";

export function isLegacyAsset(asset) {
  if (!asset || typeof asset !== "object") return true;
  // A v2 pack carries explicit channel declarations; a version number alone is
  // not enough (metadata-only bumps must not be treated as v2).
  const version = asset.assetVersion ?? asset.version;
  const hasDeclarations = !!asset.pack?.materials || !!asset.materials?.rock?.textures;
  return version !== PACK_ASSET_VERSION || !hasDeclarations;
}

// Loads a material asset object. Options:
//   lock            build lock to verify against (optional)
//   journal         migration journal (a fresh in-memory one if omitted)
//   allowRollback   when true, a failed v2 verification falls back to the
//                   built-in v2 pack and records a rollback entry
export function loadMaterialAsset(asset, options = {}) {
  const journal = options.journal || createMigrationJournal(createMemoryStore());
  const lock = options.lock || null;

  if (asset && (asset.assetVersion === PACK_ASSET_VERSION || asset.version === PACK_ASSET_VERSION)) {
    const pack = asset.pack || asset;
    try {
      assertPackIsV2(pack);
    } catch (e) {
      const entry = journal.recordLoad(PACK_ASSET_VERSION, { rejected: true, reason: e.message });
      return { ok: false, error: e.message, journalEntry: entry, journal };
    }
    if (lock) {
      const verification = verifyPackAgainstLock(pack, lock);
      if (!verification.ok) {
        if (options.allowRollback) {
          const rollback = journal.recordRollback(PACK_ASSET_VERSION, PACK_ASSET_VERSION, verification.reasons.join("; "));
          return {
            ok: true,
            pack: DEFAULT_MATERIAL_PACK_V2,
            rolledBack: true,
            verification,
            journalEntry: rollback,
            journal,
          };
        }
        return { ok: false, error: `asset lock verification failed: ${verification.reasons.join("; ")}`, verification, journal };
      }
    }
    const entry = journal.recordLoad(PACK_ASSET_VERSION, { hash: lock?.contentHash });
    return { ok: true, pack, migrated: false, journalEntry: entry, journal };
  }

  // Legacy path: joint conversion of textures + config. This is the only way a
  // v1 project reaches the renderer.
  const legacy = asset && (asset.assetVersion !== undefined || asset.version !== undefined)
    ? asset
    : { ...asset, assetVersion: LEGACY_PACK_ASSET_VERSION };
  const result = migrateMaterialAsset(legacy);
  journal.recordMigration(result.report, { source: options.source || "loader" });
  if (!result.ok) {
    return { ok: false, error: "legacy asset migration was rejected", report: result.report, journal };
  }
  if (lock) {
    const verification = verifyPackAgainstLock(result.pack, lock);
    if (!verification.ok) {
      if (options.allowRollback) {
        const rollback = journal.recordRollback(LEGACY_PACK_ASSET_VERSION, PACK_ASSET_VERSION, verification.reasons.join("; "));
        return {
          ok: true,
          pack: DEFAULT_MATERIAL_PACK_V2,
          migrated: true,
          rolledBack: true,
          report: result.report,
          verification,
          journalEntry: rollback,
          journal,
        };
      }
      return {
        ok: false,
        error: `migrated pack failed asset lock: ${verification.reasons.join("; ")}`,
        report: result.report,
        verification,
        journal,
      };
    }
  }
  return {
    ok: true,
    pack: result.pack,
    textures: result.textures,
    migrated: true,
    report: result.report,
    journal,
  };
}
