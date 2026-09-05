/**
 * Runtime-iterable enums for the domain. Types derived from these arrays live
 * in `./types.ts` — one source of truth per set.
 */

/** Operation state, ordered along the happy path (draft → completed). `failed` is terminal from any non-terminal state; `voided` is terminal from `failed` only. */
export const OPERATION_STATES = [
  "draft",
  "preparing",
  "approval_required",
  "proving",
  "ready_to_sign",
  "submitted",
  "indexing",
  "completed",
  "failed",
  "voided",
] as const;

export const OP_TYPES = [
  "shield",
  "transfer_registered",
  "transfer_anonymous",
  "withdraw",
  "merge",
  "timelock_create",
  "timelock_settle",
  "zone_create",
] as const;

export const FAILURE_CODES = [
  "policy_denied",
  "approval_rejected",
  "proof_failed",
  "signer_failed",
  "submit_failed",
  "indexing_timeout",
  "gateway_unavailable",
  "config_error",
  "invalid_input",
  "insufficient_balance",
  "manual_reconciliation_required",
] as const;

export const PRIVATE_HISTORY_KINDS = ["shield", "transfer", "withdraw", "merge", "split"] as const;

export const PRIVATE_HISTORY_DIRECTIONS = ["inbound", "outbound", "self"] as const;

export const KEY_KINDS = ["viewing", "nullifier"] as const;

export const MATERIAL_TAGS = ["simulated", "live"] as const;

export const RUNTIME_HEALTH_COMPONENTS = ["rpc", "prover", "photon"] as const;

export const RUNTIME_HEALTH_STATUSES = ["green", "amber", "red"] as const;

export const WALLET_STATUSES = ["pending", "ready", "paused"] as const;

/** Bring-up is resumable: `failed` is retryable by re-submitting the same ring program id. */
export const RING_STATUSES = ["pending", "active", "failed"] as const;

/**
 * Shape of a ring's operator-chosen name: a 1-32 char lowercase slug, because
 * it appears in request bodies and logs. Mirrored by migration 0072's CHECK.
 */
export const RING_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

/** Reserved: operations name the default public pool with it, so no ring may claim it. */
export const DEFAULT_RING_NAME = "default";

export const ZONE_KINDS = ["treasury", "public"] as const;

export const TRANSFER_MODES = ["registered", "anonymous"] as const;
