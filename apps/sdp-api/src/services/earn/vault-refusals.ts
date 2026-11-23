import type { VaultProviderErrorCode } from "@sdp/earn/types";
import { RpcUnavailableError } from "@sdp/rpc/errors";
import { isRpcUpstreamUnavailable, isTransientRpcError } from "@sdp/rpc/transient";
import { badRequest, conflict, providerUnavailable } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";

/**
 * How the API answers each shared vault provider code. Exhaustive, so a code
 * added to `VaultProviderErrorCode` does not compile until it is classified.
 *
 * - `refused`: a caller-fixable 400 carrying the provider's own sentence. Each
 *   names something the request or the vault's current state makes impossible:
 *   an amount unusable at the mint's scale, a paused or capped vault, shares
 *   still inside the post-deposit lock, a compliance approval SDP does not
 *   implement, or queue terms the contract rejects.
 * - `stale`: a 409. A queue request PDA present when the caller selected it may
 *   close before the cancellation build; the caller should refresh history.
 * - `unavailable`: state SDP could not read, an outage rather than a refusal,
 *   answered with a sanitized retryable 503.
 * - `bubbles`: rethrown unchanged for the global error boundary. An unexplained
 *   build failure is SDP's problem to look at, and telling a customer their
 *   request was wrong would be a guess.
 *
 * Matched on the shared `code` shape rather than provider classes, so a new
 * vault-direct provider inherits the mapping by using the same vocabulary.
 * Shared by the vault BUILDS and the deposit QUOTE on purpose: the quote runs
 * the same provider arithmetic, so the two paths refuse in the same words or
 * they drift.
 */
const VAULT_PROVIDER_ERROR_ANSWERS = {
  INVALID_AMOUNT: "refused",
  DEPOSIT_REFUSED: "refused",
  WITHDRAW_REFUSED: "refused",
  REDEMPTION_REFUSED: "refused",
  COMPLIANCE_APPROVAL_REQUIRED: "refused",
  INVALID_QUEUE_PARAMETERS: "refused",
  WITHDRAWAL_REQUEST_NOT_FOUND: "stale",
  VAULT_UNREADABLE: "unavailable",
  REQUEST_UNREADABLE: "unavailable",
  POSITION_UNREADABLE: "unavailable",
  SWAP_UNAVAILABLE: "bubbles",
  DEPLOYMENT_NOT_CONFIGURED: "bubbles",
  CLUSTER_UNSUPPORTED: "bubbles",
  UNSUPPORTED_VAULT: "bubbles",
  INCOMPATIBLE_DEPLOYMENT: "bubbles",
  PROGRAM_MISMATCH: "bubbles",
  MINT_MISMATCH: "bubbles",
} as const satisfies Record<
  VaultProviderErrorCode,
  "refused" | "stale" | "unavailable" | "bubbles"
>;

function hasStringCode(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

/** The shared vault provider failure an error carries, or `null` for any other error. */
function vaultProviderFailure(error: unknown) {
  if (!hasStringCode(error) || !Object.hasOwn(VAULT_PROVIDER_ERROR_ANSWERS, error.code)) {
    return null;
  }
  // SAFETY: `Object.hasOwn` just proved the code is a key of the exhaustive answer map.
  const code = error.code as VaultProviderErrorCode;
  return { code, message: error.message, answer: VAULT_PROVIDER_ERROR_ANSWERS[code] };
}

/** The shared vault provider code an error carries, or `null` for any other error. */
export function vaultProviderErrorCode(error: unknown): VaultProviderErrorCode | null {
  return vaultProviderFailure(error)?.code ?? null;
}

/**
 * Whether the provider or its RPC could not be read, which
 * `rethrowVaultProviderFailure` answers with a retryable 503.
 */
export function isVaultProviderUnavailable(error: unknown): boolean {
  return (
    vaultProviderFailure(error)?.answer === "unavailable" ||
    error instanceof RpcUnavailableError ||
    isRpcUpstreamUnavailable(error)
  );
}

/**
 * Convert the provider-neutral vault error vocabulary into the public API
 * contract. Provider refusals are caller-fixable 400s. An unreadable vault is
 * an infrastructure failure, including RPC outages and rate limits, so it is
 * a retryable 503 with no provider or RPC internals exposed to the caller.
 */
export function rethrowVaultProviderFailure(error: unknown): never {
  const failure = vaultProviderFailure(error);
  if (failure?.answer === "refused") {
    throw badRequest(failure.message);
  }
  if (failure?.answer === "stale") {
    // The PDA was present when the caller selected it but may close before the
    // cancellation build. Treat that race as stale state, not an API outage or
    // an internal failure; the caller should refresh request history.
    throw conflict(failure.message);
  }
  if (isVaultProviderUnavailable(error)) {
    const causes = new Set<Error>();
    let cause = error;
    let transient = false;
    while (cause instanceof Error && !causes.has(cause)) {
      causes.add(cause);
      transient ||= isTransientRpcError(cause);
      cause = cause.cause;
    }
    const root = [...causes].at(-1);
    // Log diagnostic categories without raw upstream text, URLs, or credentials.
    getLogger().warn(
      {
        event: "earn_provider_state_unavailable",
        providerCode: hasStringCode(error) ? error.code : null,
        transient,
        causeCode: root && "code" in root && typeof root.code === "number" ? root.code : null,
      },
      "Earn provider state could not be read"
    );
    throw providerUnavailable("Earn provider is temporarily unavailable. Try again.");
  }
  throw error;
}
