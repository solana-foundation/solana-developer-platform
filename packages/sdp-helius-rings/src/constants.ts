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

export const ZONE_KINDS = ["treasury", "public"] as const;

export const TRANSFER_MODES = ["registered", "anonymous"] as const;
