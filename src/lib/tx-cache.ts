/**
 * Versioned browser cache for parsed DLMM position transactions.
 *
 * Bump HISTORY_CACHE_VERSION whenever parsing, stacking, or the stored
 * instruction shape changes so stale entries are discarded automatically.
 */

import type { DlmmInstruction } from '@geeklad/meteora-dlmm-liquidity-tx-parser';

/** Increment to force every client to refetch and reparse history. */
export const HISTORY_CACHE_VERSION = 2;

const DB_NAME = 'dlmm-position-tx-cache';
const STORE = 'parsed-txs';

type CachedRecord = {
  version: number;
  signature: string;
  instructions: DlmmInstruction[];
};

const memory = new Map<string, CachedRecord>();

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, HISTORY_CACHE_VERSION);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(STORE)) {
        db.deleteObjectStore(STORE);
      }
      db.createObjectStore(STORE, { keyPath: 'signature' });
    };
    request.onsuccess = () => resolve(request.result);
  });
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = openDb().catch(error => {
      console.warn('History tx cache unavailable', error);
      dbPromise = null;
      return null;
    });
  }
  return dbPromise;
}

function reviveInstructions(raw: DlmmInstruction[]): DlmmInstruction[] {
  return raw.map(instruction => ({
    ...instruction,
    timestamp: instruction.timestamp instanceof Date
      ? instruction.timestamp
      : new Date(instruction.timestamp),
  }));
}

export async function readCachedInstructions(
  signature: string
): Promise<DlmmInstruction[] | null> {
  const mem = memory.get(signature);
  if (mem && mem.version === HISTORY_CACHE_VERSION) {
    return reviveInstructions(mem.instructions);
  }
  const database = await db();
  if (!database) return null;
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(signature);
    request.onerror = () => reject(request.error ?? new Error('cache read failed'));
    request.onsuccess = () => {
      const record = request.result as CachedRecord | undefined;
      if (!record || record.version !== HISTORY_CACHE_VERSION) {
        resolve(null);
        return;
      }
      memory.set(signature, record);
      resolve(reviveInstructions(record.instructions));
    };
  });
}

export async function writeCachedInstructions(
  signature: string,
  instructions: DlmmInstruction[]
): Promise<void> {
  const record: CachedRecord = {
    version: HISTORY_CACHE_VERSION,
    signature,
    instructions,
  };
  memory.set(signature, record);
  const database = await db();
  if (!database) return;
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('cache write failed'));
    tx.objectStore(STORE).put(record);
  });
}

export async function clearHistoryTxCache(): Promise<void> {
  memory.clear();
  const database = await db();
  if (!database) return;
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('cache clear failed'));
    tx.objectStore(STORE).clear();
  });
}
