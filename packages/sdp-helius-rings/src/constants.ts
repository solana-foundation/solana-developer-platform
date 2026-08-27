/**
 * Runtime-iterable enums for the domain. Types derived from these arrays live
 * in `./types.ts` — one source of truth per set.
 */

/**
 * Operation state, ordered along the happy path (draft → completed).
 *
 * Three terminals, not two: `completed`, `failed`, and `voided`. `failed` is
 * reachable from any non-terminal state, and is the only one that is not
 * absolutely final — see `state-machine.ts` for the two reconcile moves out of
 * it and why they are not transitions.
 */
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
  /**
   * A signed failure an operator has confirmed never landed.
   *
   * Terminal, and reachable only from `failed` through the reconcile route —
   * never through `nextState`. It exists so a wallet can be released without
   * lying: marking such a row `completed` would claim money moved, and clearing
   * its signed bytes would free the slot while the transaction could still
   * land. Leaving the states the unique indexes name is what releases the
   * wallet, exactly as `completed` does.
   */
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
  /**
   * The deployment is missing something Rings needs — an endpoint, the API key
   * or the derivation seed. Distinct from `gateway_unavailable` because it is
   * never retryable: the fix is an environment variable, and offering a retry
   * sends the operator to the wrong lever.
   */
  "config_error",
  "invalid_input",
  "insufficient_balance",
  /**
   * Signed bytes exist, their blockhash has expired, and whether they landed is
   * unknown. Neither retryable nor closed: a fresh attempt could pay twice and
   * walking away could strand funds, so an operator reconciles the signature
   * against the chain by hand.
   */
  "manual_reconciliation_required",
] as const;

/**
 * What a synced history row says happened on chain.
 *
 * Deliberately not `OP_TYPES`. That set is what SDP lets a caller *request*,
 * while a history row is whatever the protocol recorded — including a `split`
 * this integration never builds but another client could have. Reusing the
 * request vocabulary would force such a row to be dropped or mislabelled.
 */
export const PRIVATE_HISTORY_KINDS = ["shield", "transfer", "withdraw", "merge", "split"] as const;

/** A history row's direction relative to the wallet that synced it. */
export const PRIVATE_HISTORY_DIRECTIONS = ["inbound", "outbound", "self"] as const;

export const MATERIAL_TAGS = ["simulated", "live"] as const;

export const RUNTIME_HEALTH_STATUSES = ["green", "amber", "red"] as const;

export const RUNTIME_HEALTH_COMPONENTS = ["rpc", "prover", "photon", "gateway"] as const;

export const WALLET_STATUSES = ["pending", "ready", "paused"] as const;

export const ZONE_KINDS = ["treasury", "public"] as const;

export const TRANSFER_MODES = ["registered", "anonymous"] as const;
