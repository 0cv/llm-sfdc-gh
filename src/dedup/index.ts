/**
 * In-memory deduplication cache.
 * Prevents processing the same error multiple times within a TTL window.
 */

import { config } from "../config.js";

const seen = new Map<string, number>(); // fingerprint → timestamp

const TTL_MS = config.dedupTtlHours * 60 * 60 * 1000;

export function isDuplicate(fingerprint: string): boolean {
  const now = Date.now();

  // Clean expired entries
  for (const [key, ts] of seen) {
    if (now - ts > TTL_MS) seen.delete(key);
  }

  if (seen.has(fingerprint)) return true;

  seen.set(fingerprint, now);
  return false;
}
