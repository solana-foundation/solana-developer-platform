import type { OperationEvent } from "@sdp/helius-rings";
import { REDACTED_LEAF_FIELDS, REDACTION_CENSOR } from "@/runtime/log-redaction";
import type { RepositoryDbClient } from "./base";

export function generateHeliusRingsEventId(): string {
  return `hre_${crypto.randomUUID()}`;
}

/** Upper bound on an unpaginated timeline read. */
export const DEFAULT_RINGS_EVENT_LIST_LIMIT = 200;

export interface HeliusRingsEventRow {
  id: string;
  operation_id: string;
  /**
   * Free-form. Event kinds are additive documentation of what happened, and the
   * DB deliberately carries no CHECK on them — gating each new kind behind a
   * migration is how you end up with someone logging it somewhere worse.
   */
  kind: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export interface AppendHeliusRingsEventInput {
  operationId: string;
  kind: string;
  /** Redacted by `append` before it is written. */
  payload?: Record<string, unknown> | null;
}

export interface ListHeliusRingsEventsInput {
  operationId: string;
  limit?: number;
}

export interface HeliusRingsEventRepositoryContext {
  db: RepositoryDbClient;
}

export interface HeliusRingsEventRepository {
  /**
   * Appends one timeline entry. The payload is redacted on the way in, so the
   * table cannot accumulate secret material even if a caller passes something it
   * should not have.
   */
  append(input: AppendHeliusRingsEventInput): Promise<HeliusRingsEventRow>;
  listByOperation(input: ListHeliusRingsEventsInput): Promise<HeliusRingsEventRow[]>;
}

/**
 * Keys censored wherever they appear in an event payload.
 *
 * The Rings key domain comes from the log redaction registry rather than being
 * retyped here — two copies of a security-critical list is how one of them goes
 * stale. `material` is added because that is the key ref field name, and
 * `ciphertext` because a sealed blob is still not timeline material.
 */
const CENSORED_KEYS = new Set<string>([...REDACTED_LEAF_FIELDS, "material", "ciphertext"]);

/** Keys censored only under a `proof` parent, where they mean proof internals. */
const CENSORED_PROOF_KEYS = new Set(["ref", "internal"]);

function shouldCensor(key: string, parentKey: string | null): boolean {
  return CENSORED_KEYS.has(key) || (parentKey === "proof" && CENSORED_PROOF_KEYS.has(key));
}

/**
 * Deep-copies a payload, replacing sensitive values with the censor.
 *
 * Unlike the pino registry — which is bounded to one nesting level by
 * fast-redact — this walks to arbitrary depth, because an event payload is
 * written once and then read back forever, so the cost is paid on write rather
 * than on every log line. Cycles are broken with a seen-set rather than
 * throwing, since a malformed payload should not fail the state transition that
 * is trying to record itself.
 */
export function redactHeliusRingsEventPayload(value: unknown, seen = new WeakSet()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactHeliusRingsEventPayload(entry, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (shouldCensor(key, null)) {
      result[key] = REDACTION_CENSOR;
      continue;
    }
    if (key === "proof" && entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const proof: Record<string, unknown> = {};
      for (const [proofKey, proofEntry] of Object.entries(entry as Record<string, unknown>)) {
        proof[proofKey] = shouldCensor(proofKey, "proof")
          ? REDACTION_CENSOR
          : redactHeliusRingsEventPayload(proofEntry, seen);
      }
      result[key] = proof;
      continue;
    }
    result[key] = redactHeliusRingsEventPayload(entry, seen);
  }
  return result;
}

export function mapHeliusRingsEventRow(row: HeliusRingsEventRow): OperationEvent {
  return {
    kind: row.kind,
    createdAt: row.created_at,
    payload: row.payload ?? undefined,
  };
}
