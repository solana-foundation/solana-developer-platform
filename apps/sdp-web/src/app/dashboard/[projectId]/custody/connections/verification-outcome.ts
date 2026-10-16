import type { CustodyConnectionCompletion } from "./connection-detail.data";

/**
 * The six ways a credential check can end badly, kept apart because the user's
 * next move differs in every one. Collapsing them — the obvious temptation,
 * since four of them arrive as the same HTTP shape — would tell someone whose
 * request actually succeeded that it failed.
 */
export type CustodyOutcomeKind =
  | "invalid_credentials"
  | "account_mismatch"
  | "temporary"
  | "conflict"
  | "unknown"
  | "wallet_conflict";

/**
 * `neutral` exists so an unconfirmed result is never dressed as a failure.
 * `info` marks a transport problem that is safe to retry; only a conclusive
 * rejection earns `danger`.
 */
export type CustodyOutcomeTone = "danger" | "info" | "warning" | "neutral";

export type CustodyOutcomeAction =
  | "enter_credentials_again"
  | "cancel_setup"
  | "add_new_connection"
  | "check_again"
  | "do_it_later"
  | "reload"
  | "check_current_state"
  | "copy_connection_id"
  | "contact_support";

export interface CustodyOutcome {
  kind: CustodyOutcomeKind;
  tone: CustodyOutcomeTone;
  actions: readonly CustodyOutcomeAction[];
  /** False when retrying cannot converge, so no retry control is offered. */
  retryable: boolean;
}

const OUTCOMES: Record<CustodyOutcomeKind, CustodyOutcome> = {
  invalid_credentials: {
    kind: "invalid_credentials",
    tone: "danger",
    actions: ["enter_credentials_again", "cancel_setup"],
    retryable: true,
  },
  account_mismatch: {
    kind: "account_mismatch",
    tone: "danger",
    actions: ["enter_credentials_again", "add_new_connection"],
    retryable: true,
  },
  temporary: {
    kind: "temporary",
    tone: "info",
    actions: ["check_again", "do_it_later"],
    retryable: true,
  },
  conflict: {
    kind: "conflict",
    tone: "warning",
    actions: ["reload"],
    retryable: true,
  },
  unknown: {
    kind: "unknown",
    tone: "neutral",
    actions: ["check_current_state"],
    retryable: true,
  },
  // No retry control at all: replacing the credentials cannot reconcile the
  // wallet, so a retry button would only loop.
  wallet_conflict: {
    kind: "wallet_conflict",
    tone: "danger",
    actions: ["copy_connection_id", "contact_support"],
    retryable: false,
  },
};

/**
 * Codes the API reports on a completion or a rotation. `provider_account_*`
 * are two spellings of one situation — the credentials work, but they open a
 * different Privy account than the one this connection is bound to.
 */
function outcomeForCode(code: string | undefined): CustodyOutcomeKind | null {
  switch (code) {
    case "invalid_credentials":
      return "invalid_credentials";
    case "provider_account_mismatch":
    case "provider_account_already_connected":
      return "account_mismatch";
    case "wallet_conflict":
      return "wallet_conflict";
    case "provider_response_unknown":
      return "unknown";
    default:
      return null;
  }
}

/**
 * An install or re-check result. `running` is not an outcome yet, and
 * `success` is not a bad one, so both yield null.
 */
export function resolveCompletionOutcome(
  completion: CustodyConnectionCompletion | null | undefined
): CustodyOutcome | null {
  if (!completion || completion.status === "success" || completion.status === "running") {
    return null;
  }
  if (completion.status === "retry_unknown") {
    return OUTCOMES.unknown;
  }
  // A failure whose code we do not recognise is still a conclusive failure,
  // but we cannot claim to know which one; the credentials are the only thing
  // the user can act on.
  return OUTCOMES[outcomeForCode(completion.code) ?? "invalid_credentials"];
}

/**
 * A rotation result. Note these arrive on an HTTP **200** — the request was
 * handled fine, it is the credential that was rejected — so callers must
 * branch on this rather than on the status code.
 */
export function resolveRotationOutcome(
  rotation: { status: "success" | "failed" | "retry_unknown"; code?: string } | null | undefined
): CustodyOutcome | null {
  if (!rotation || rotation.status === "success") {
    return null;
  }
  if (rotation.status === "retry_unknown") {
    return OUTCOMES.unknown;
  }
  return OUTCOMES[outcomeForCode(rotation.code) ?? "invalid_credentials"];
}

/**
 * A transport-level answer, for the calls that report trouble as a status
 * rather than a body. The split mirrors the server-side classification in
 * `byok-actions.ts`: under 500 and not 408/429 is conclusive, everything else
 * leaves the outcome genuinely open.
 *
 * @param status - HTTP status, or 0 when no response arrived at all.
 */
export function resolveHttpOutcome(status: number): CustodyOutcome {
  if (status === 409) {
    return OUTCOMES.conflict;
  }
  if (status === 408 || status === 429 || status === 503) {
    return OUTCOMES.temporary;
  }
  // No response, or a server error: the request may well have committed.
  if (status === 0 || status >= 500) {
    return OUTCOMES.unknown;
  }
  return OUTCOMES.invalid_credentials;
}
