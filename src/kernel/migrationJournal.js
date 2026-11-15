// Append-only record of material asset version changes and rollbacks.
//
// Every migration, already-v2 load and rollback leaves an entry, so the answer
// to "which asset version is live and what happened to the previous one" is
// always recoverable. The store is pluggable: the browser uses an in-memory
// ring buffer backed by localStorage, the CLI passes a file-backed store.
// Nothing here is allowed to throw into the render path; a failed record is
// reported back to the caller instead.

import { PACK_ASSET_VERSION, LEGACY_PACK_ASSET_VERSION } from "./materialPack.js";

export const JOURNAL_EVENT = Object.freeze({
  MIGRATED: "migrated",
  LOADED_V2: "loaded-v2",
  LOADED_LEGACY: "loaded-legacy",
  REPAIR: "channel-repair",
  REJECTED: "rejected",
  ROLLED_BACK: "rolled-back",
});

const MAX_ENTRIES = 200;

export function createMemoryStore(initial = []) {
  let entries = Array.isArray(initial) ? initial.slice(0, MAX_ENTRIES) : [];
  return {
    read: () => entries.slice(),
    write: (next) => {
      entries = next.slice(-MAX_ENTRIES);
    },
  };
}

// localStorage-backed store for the browser. Missing/corrupt storage degrades
// to an empty journal rather than breaking the app.
export function createLocalStorageStore(storage, key) {
  const read = () => {
    try {
      const raw = storage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  return {
    read,
    write: (next) => {
      try {
        storage.setItem(key, JSON.stringify(next.slice(-MAX_ENTRIES)));
      } catch {
        // Quota / private mode: keep the in-memory copy, surface the failure.
      }
    },
  };
}

export function createMigrationJournal(store = createMemoryStore()) {
  function append(event) {
    const entries = store.read();
    const entry = {
      at: new Date().toISOString(),
      seq: entries.length ? entries[entries.length - 1].seq + 1 : 1,
      ...event,
    };
    entries.push(entry);
    store.write(entries);
    return entry;
  }

  return {
    recordMigration(report, meta = {}) {
      const entry = append({
        event: report.status === "rejected" ? JOURNAL_EVENT.REJECTED : JOURNAL_EVENT.MIGRATED,
        fromVersion: report.sourceVersion ?? LEGACY_PACK_ASSET_VERSION,
        toVersion: report.targetVersion ?? PACK_ASSET_VERSION,
        status: report.status,
        ok: report.ok,
        channelsFilled: report.channelsFilled?.length || 0,
        defaultsConverted: report.defaultsConverted?.length || 0,
        weightDeltaMax: report.semanticPreservation?.weightDeltaMax,
        boundariesIdentical: report.semanticPreservation?.allBoundariesIdentical,
        ...meta,
      });
      for (const repair of report.channelsFilled || []) {
        append({ event: JOURNAL_EVENT.REPAIR, ...repair, migrationSeq: entry.seq });
      }
      return entry;
    },
    recordLoad(version, meta = {}) {
      return append({
        event: version === PACK_ASSET_VERSION ? JOURNAL_EVENT.LOADED_V2 : JOURNAL_EVENT.LOADED_LEGACY,
        version,
        ...meta,
      });
    },
    recordRollback(fromVersion, toVersion, reason) {
      return append({
        event: JOURNAL_EVENT.ROLLED_BACK,
        fromVersion,
        toVersion,
        reason: String(reason || "unspecified"),
      });
    },
    entries: () => store.read(),
    last: () => {
      const entries = store.read();
      return entries.length ? entries[entries.length - 1] : null;
    },
  };
}
