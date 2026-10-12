"use client";

import { z } from "zod";
import {
  type ActionKeyAnswer,
  answerRetiresKey,
  keyAnswerFor,
  storageFingerprint,
} from "./idempotency";

/**
 * Per-tab memory of what one user action was first sent with (its
 * Idempotency-Key, or a value read from the clock), per form input, until the
 * action is definitively answered. The same input finds the same value after
 * an edit and back (A to B to A) and after a reload, so a retry resends the
 * first attempt's request and the API replays it instead of acting twice.
 *
 * `sessionStorage`, as the dashboard's other key stores, with a memory tier
 * for a browser that refuses storage: the value then lives as long as the page
 * does. Inputs are stored as digests ({@link storageFingerprint}), so form
 * contents never sit in storage.
 *
 * Nothing is evicted: an entry leaves only when its action is definitively
 * answered, since every entry left is an attempt that may have written.
 */

const storedEntrySchema = z.object({
  /** Digest of the form input this value belongs to. */
  id: z.string().min(1),
  value: z.unknown(),
  /** An earlier attempt never got a definitive answer, so it may have written. */
  unanswered: z.boolean(),
  /** Handed out for a send that has not settled; a reload mid-flight leaves it set. */
  pending: z.boolean(),
});

type StoredEntry = z.infer<typeof storedEntrySchema>;

/** The tier that cannot fail; authoritative when storage refuses or lags. */
const memoryEntries = new Map<string, readonly StoredEntry[]>();
/** Store keys whose last write missed storage, so readable storage is stale. */
const storageDivergedKeys = new Set<string>();

function readEntries(storeKey: string): StoredEntry[] {
  let parsed: unknown = memoryEntries.get(storeKey) ?? [];
  if (!storageDivergedKeys.has(storeKey)) {
    try {
      const raw = window.sessionStorage.getItem(storeKey);
      parsed = raw === null ? [] : JSON.parse(raw);
    } catch {
      // Storage refused or held garbage: the memory tier answers.
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    const candidate = storedEntrySchema.safeParse(entry);
    return candidate.success ? [candidate.data] : [];
  });
}

function writeEntries(storeKey: string, entries: readonly StoredEntry[]): void {
  memoryEntries.set(storeKey, entries);
  try {
    window.sessionStorage.setItem(storeKey, JSON.stringify(entries));
    storageDivergedKeys.delete(storeKey);
  } catch {
    // Durability is lost, not the value: memory holds it for this page.
    storageDivergedKeys.add(storeKey);
  }
}

/**
 * Test-only: clear the memory tier, as a reload does.
 *
 * @internal
 */
export function resetActionMemosForTests(): void {
  memoryEntries.clear();
  storageDivergedKeys.clear();
}

export interface ActionMemo<T> {
  /**
   * The value this input was first sent with, or `build()`'s, remembered.
   * Call it once per send, right before it.
   */
  valueFor(input: string, build: () => T): T;
  /**
   * Record what the send's answer settles: the value is forgotten on the
   * dashboard-wide rule (`answerRetiresKey`), and kept otherwise.
   */
  settle(input: string, answer: ActionKeyAnswer): void;
}

/**
 * One memo per kind of value, under its own versioned `sessionStorage` key.
 *
 * @param storeKey - The `sessionStorage` key.
 * @param schema - What a stored value must be; anything else is rebuilt.
 */
export function createActionMemo<T>(storeKey: string, schema: z.ZodType<T>): ActionMemo<T> {
  return {
    valueFor(input, build) {
      const id = storageFingerprint(input);
      const entries = readEntries(storeKey);
      const others = entries.filter((entry) => entry.id !== id);
      const existing = entries.find((entry) => entry.id === id);
      const remembered = existing ? schema.safeParse(existing.value) : null;
      if (existing && remembered?.success) {
        // A send still pending when this one starts never settled (a reload
        // mid-flight, or a double submit), so it may have written.
        writeEntries(storeKey, [
          ...others,
          { ...existing, unanswered: existing.unanswered || existing.pending, pending: true },
        ]);
        return remembered.data;
      }
      const value = build();
      writeEntries(storeKey, [...others, { id, value, unanswered: false, pending: true }]);
      return value;
    },

    settle(input, answer) {
      const id = storageFingerprint(input);
      const entries = readEntries(storeKey);
      const existing = entries.find((entry) => entry.id === id);
      if (!existing) return;
      const others = entries.filter((entry) => entry.id !== id);
      writeEntries(
        storeKey,
        answerRetiresKey(answer, existing.unanswered)
          ? others
          : [...others, { ...existing, unanswered: true, pending: false }]
      );
    },
  };
}

/**
 * What a `dashboardFetch` result settles about its key: a success is
 * definitive, a refusal is read by `keyAnswerFor`'s status rule, and a
 * failure below 400 (a followed redirect, a body nobody could read) or no
 * answer at all is open. A replay mark is not visible here, so a replayed
 * failure reads as a refusal, which can only keep a value longer.
 *
 * @param result - The `dashboardFetch` result.
 */
export function dashboardFetchKeyAnswer(result: {
  ok: boolean;
  status: number | null;
}): ActionKeyAnswer {
  if (result.ok) return "definitive";
  if (result.status === null || result.status < 400) return "open";
  return keyAnswerFor(result.status, false);
}
