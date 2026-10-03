/**
 * Data portability: read-only diagnostics plus a non-destructive export and
 * import of the local database.
 *
 * WHY THIS EXISTS
 *
 * This application has no server database. Its system of record is IndexedDB
 * inside the browser (`pos-db`), and browser storage is partitioned by ORIGIN
 * (scheme + host + port). That has one consequence operators hit constantly:
 *
 *     a different URL  ->  a different origin  ->  a different, empty database
 *
 * So when a deployment moves to a new address, the new address looks like it
 * has "lost" the data. It has not: the records are still in the browser
 * profile of the device and address where they were entered. There is no
 * connection string to fix, because there is no server to connect to.
 *
 * This service is the safe way to move that data across: export everything to
 * a JSON file on the old address, import it on the new one. Import is a MERGE.
 * It never clears a store, never deletes a record and never resets the
 * database.
 *
 * RULES ENFORCED HERE
 *
 *   1. Export is read-only.
 *   2. Import only ever writes. There is no clear/delete/reset path in this
 *      module at all.
 *   3. A record already present is replaced only when the incoming copy has a
 *      newer `updatedAt`. Older copies are skipped, never applied over newer
 *      local data.
 *   4. The admin credential store is never imported, so a restore cannot lock
 *      anyone out of the terminal.
 *   5. The sync queue is neither exported nor imported: it is a transport
 *      buffer for a future backend, not business data.
 *   6. Nothing in here is reachable from receipt printing. Printing stays
 *      read-only against the same data.
 */

import {
  ALL_STORES,
  DB_NAME,
  DB_VERSION,
  STORES,
  type StoreName,
} from '@/config/storage.config';
import { SYNC_API_URL } from '@/config/sync.config';
import { db } from '@/data/db/indexedDb';
import { SETTING_KEYS } from '@/services/settingsService';

const BACKUP_FORMAT = 'pos-data-backup';
const BACKUP_VERSION = 1;

/** Stores that are deliberately left out of a backup. */
const EXPORT_EXCLUDED: readonly StoreName[] = [STORES.syncQueue];

/** Stores that are never written by an import. */
const IMPORT_EXCLUDED: readonly StoreName[] = [STORES.admin, STORES.syncQueue];

interface EntityLike {
  id?: unknown;
  updatedAt?: unknown;
}

/** A row planned for writing, and how it was counted. */
interface StagedWrite {
  record: EntityLike;
  kind: 'added' | 'updated';
}

export interface DataBackup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  source: {
    origin: string;
    database: string;
    databaseVersion: number;
  };
  stores: Partial<Record<StoreName, unknown[]>>;
}

/** Where the data this terminal is showing actually lives. */
export interface StorageSource {
  origin: string;
  databaseName: string;
  databaseVersion: number;
  /** True once the browser has granted persistent (non-evictable) storage. */
  persisted: boolean;
  counts: Record<StoreName, number>;
  totalRecords: number;
  /** True when VITE_SYNC_API_URL is configured and a shared backend exists. */
  syncEnabled: boolean;
}

export interface StoreImportTally {
  added: number;
  updated: number;
  skipped: number;
}

export interface ImportResult {
  added: number;
  updated: number;
  skipped: number;
  stores: Partial<Record<StoreName, StoreImportTally>>;
  /** Stores whose write failed; every other store still imported. */
  failed: StoreName[];
}

function currentOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

function isEntity(value: unknown): value is EntityLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as EntityLike).id === 'string' &&
    (value as EntityLike).id !== ''
  );
}

function isNewer(incoming: unknown, existing: unknown): boolean {
  if (typeof incoming !== 'string' || typeof existing !== 'string') return false;
  return incoming > existing;
}

function isStoreName(value: string): value is StoreName {
  return (ALL_STORES as readonly string[]).includes(value);
}

export const dataPortService = {
  /**
   * Describe the data source this browser is actually reading.
   *
   * Shown in Admin so an operator can see, at a glance, which address and
   * which local database they are looking at — the question behind "where did
   * my data go?".
   */
  async describeSource(): Promise<StorageSource> {
    const counts = db.isSupported()
      ? await db.countAll()
      : (Object.fromEntries(ALL_STORES.map((s) => [s, 0])) as Record<
          StoreName,
          number
        >);

    const persisted =
      db.isSupported() && typeof navigator !== 'undefined' && navigator.storage?.persisted
        ? await navigator.storage.persisted()
        : false;

    return {
      origin: currentOrigin(),
      databaseName: DB_NAME,
      databaseVersion: DB_VERSION,
      persisted,
      counts,
      totalRecords: Object.values(counts).reduce((sum, n) => sum + n, 0),
      syncEnabled: SYNC_API_URL.trim().length > 0,
    };
  },

  /** Read-only snapshot of every business store as a downloadable object. */
  async exportBackup(): Promise<DataBackup> {
    const stores: Partial<Record<StoreName, unknown[]>> = {};

    for (const name of ALL_STORES) {
      if (EXPORT_EXCLUDED.includes(name)) continue;
      stores[name] = await db.getAll(name);
    }

    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      source: {
        origin: currentOrigin(),
        database: DB_NAME,
        databaseVersion: DB_VERSION,
      },
      stores,
    };
  },

  /**
   * Merge a backup into this database.
   *
   * ADDITIVE ONLY. Nothing is cleared and no record is removed, whatever the
   * file contains.
   */
  async importBackup(input: unknown): Promise<ImportResult> {
    const result: ImportResult = {
      added: 0,
      updated: 0,
      skipped: 0,
      stores: {},
      failed: [],
    };

    const backup = input as DataBackup | null;
    if (
      !backup ||
      typeof backup !== 'object' ||
      backup.format !== BACKUP_FORMAT ||
      !backup.stores ||
      typeof backup.stores !== 'object'
    ) {
      throw new Error(
        'That file is not a POS data backup. Export a backup from the other address and try again.',
      );
    }

    for (const [key, records] of Object.entries(backup.stores)) {
      if (!isStoreName(key)) continue;
      const store: StoreName = key;
      if (IMPORT_EXCLUDED.includes(store)) continue;
      if (!Array.isArray(records)) continue;

      const incoming = records.filter(isEntity);
      if (incoming.length === 0) continue;

      const tally: StoreImportTally = { added: 0, updated: 0, skipped: 0 };
      const existing = await db.getAll<EntityLike>(store);
      const byId = new Map(existing.map((r) => [r.id as string, r]));

      const staged: StagedWrite[] = [];
      const seen = new Set<string>();

      for (const record of incoming) {
        const id = record.id as string;

        // Duplicate rows inside the backup itself.
        if (seen.has(id)) {
          tally.skipped += 1;
          continue;
        }
        seen.add(id);

        const current = byId.get(id);
        if (!current) {
          staged.push({ record, kind: 'added' });
          tally.added += 1;
          continue;
        }

        if (isNewer(record.updatedAt, current.updatedAt)) {
          staged.push({ record, kind: 'updated' });
          tally.updated += 1;
        } else {
          tally.skipped += 1;
        }
      }

      // Unique indexes: a collision would abort the whole transaction, so
      // conflicting rows are filtered out first rather than rolled back.
      const safe = await filterUniqueIndexConflicts(store, staged, byId, tally);

      try {
        await db.putMany(
          store,
          safe.map((entry) => entry.record),
        );
      } catch {
        // One unwritable store must not abandon the rest of the import.
        result.failed.push(store);
        continue;
      }

      // Order numbers must stay unique across a merge, otherwise the next
      // generated number could repeat one that is already on file.
      if (store === STORES.settings) {
        await mergeOrderSequence(safe.map((entry) => entry.record), byId);
      }

      result.stores[store] = tally;
      result.added += tally.added;
      result.updated += tally.updated;
      result.skipped += tally.skipped;
    }

    return result;
  },
};

/**
 * Drop rows that would violate a unique secondary index.
 *
 * Only two stores carry unique indexes beyond the primary key, and both would
 * abort the batch write on a collision — which would lose every other record
 * in the same batch.
 */
async function filterUniqueIndexConflicts(
  store: StoreName,
  candidates: StagedWrite[],
  existingById: Map<string, EntityLike>,
  tally: StoreImportTally,
): Promise<StagedWrite[]> {
  const uniqueKey: 'orderNumber' | 'orderId' | null =
    store === STORES.orders
      ? 'orderNumber'
      : store === STORES.sales
        ? 'orderId'
        : null;

  if (!uniqueKey) return candidates;

  const taken = new Set(
    [...existingById.values()].map((r) => (r as Record<string, unknown>)[uniqueKey]),
  );

  return candidates.filter((entry) => {
    const value = (entry.record as Record<string, unknown>)[uniqueKey];
    if (typeof value !== 'string' || value === '') return true;

    if (taken.has(value)) {
      // Move the row from its planned tally into "skipped".
      tally.skipped += 1;
      if (entry.kind === 'added') tally.added -= 1;
      else tally.updated -= 1;
      return false;
    }

    taken.add(value);
    return true;
  });
}

/**
 * Keep the higher of the two order-number counters.
 *
 * Duplicate order numbers would be rejected by the unique index on
 * `orders.orderNumber`, so the counter may only move forward. The generic
 * "newer updatedAt wins" rule is not enough here: an older backup legitimately
 * carries the higher counter.
 */
async function mergeOrderSequence(
  written: EntityLike[],
  existingById: Map<string, EntityLike>,
): Promise<void> {
  // Absent means the local record was newer, so the local value already won.
  const incoming = written.find((r) => r.id === SETTING_KEYS.orderSequence);
  if (!incoming) return;

  const current = existingById.get(SETTING_KEYS.orderSequence);
  const asNumber = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;

  const incomingValue = asNumber((incoming as { value?: unknown }).value);
  const currentValue = asNumber((current as { value?: unknown } | undefined)?.value);

  const merged = Math.max(incomingValue, currentValue);
  if (merged === incomingValue) return; // what was written is already the higher value

  // The merge wrote a lower counter over a higher local one. Put the higher
  // value back, keeping the local record's own timestamps and revision.
  await db.put(STORES.settings, { ...(current ?? incoming), value: merged });
}
