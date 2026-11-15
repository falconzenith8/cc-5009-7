// Build lock for the terrain material asset version.
//
// The lock pins which material pack version the build is allowed to load and
// records a content hash of the canonical v2 pack declaration. The renderer and
// the CLI verify the live pack against this lock; a version or hash mismatch
// fails loudly instead of silently shading with an undeclared asset.

import { DEFAULT_MATERIAL_PACK_V2, PACK_ASSET_VERSION, FUSION_CONTRACT_V2 } from "./materialPack.js";

export const LOCK_SCHEMA_VERSION = 1;

// Deterministic, JSON-only hash (FNV-1a 32-bit) over a canonicalized object.
// Object keys are sorted recursively so key insertion order cannot change the
// hash; functions and symbols are never present in pack declarations.
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export function fnv1aHash(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// The hashed payload excludes volatile packaging fields but includes every
// shading-relevant declaration: fusion contract, channel semantics, color
// spaces and material parameters.
export function packLockPayload(pack = DEFAULT_MATERIAL_PACK_V2) {
  return {
    assetVersion: pack.assetVersion,
    contract: pack.contract,
    weightBuffer: pack.weightBuffer,
    materials: Object.fromEntries(
      pack.materialOrder.map((id) => {
        const m = pack.materials[id];
        return [id, {
          albedoSrgb: m.albedoSrgb,
          albedoLinear: m.albedoLinear,
          roughness: m.roughness,
          normalScale: m.normalScale,
          metallic: m.metallic,
          detailScale: m.detailScale,
          textures: m.textures,
        }];
      })
    ),
  };
}

export function computePackHash(pack = DEFAULT_MATERIAL_PACK_V2) {
  return fnv1aHash(canonicalJson(packLockPayload(pack)));
}

export function buildLock(pack = DEFAULT_MATERIAL_PACK_V2) {
  return {
    lockSchemaVersion: LOCK_SCHEMA_VERSION,
    packId: pack.packId,
    assetVersion: PACK_ASSET_VERSION,
    contractId: FUSION_CONTRACT_V2.contractId,
    contentHash: computePackHash(pack),
    weightNormalization: pack.weightBuffer.normalization,
    generatedAt: new Date().toISOString(),
  };
}

// Verifies a live pack against a lock. Returns { ok, reasons[] } rather than
// throwing so callers can present every mismatch at once.
export function verifyPackAgainstLock(pack, lock) {
  const reasons = [];
  if (!lock || typeof lock !== "object") {
    return { ok: false, reasons: ["asset lock is missing or unreadable"] };
  }
  if (lock.assetVersion !== pack.assetVersion) {
    reasons.push(`locked assetVersion ${lock.assetVersion} != pack ${pack.assetVersion}`);
  }
  if (lock.contractId !== pack.contract.contractId) {
    reasons.push(`locked contract ${lock.contractId} != pack ${pack.contract.contractId}`);
  }
  if (lock.weightNormalization !== pack.weightBuffer.normalization) {
    reasons.push(`locked normalization ${lock.weightNormalization} != pack ${pack.weightBuffer.normalization}`);
  }
  const liveHash = computePackHash(pack);
  if (lock.contentHash !== liveHash) {
    reasons.push(`content hash mismatch: lock ${lock.contentHash} != live ${liveHash}`);
  }
  return { ok: reasons.length === 0, reasons, liveHash };
}
