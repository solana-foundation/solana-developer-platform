import { SigningError } from "@sdp/custody/signing";
import type { TransactionSigner } from "@solana/kit";
import { getLogger } from "@/runtime/logger";

/**
 * How long one custody signing call may take (HOO-1918). Past it the request
 * fails instead of hanging and holding its Idempotency-Key. It sits well under
 * the reconciler's five-minute threshold for unsigned rows, so the reconciler
 * never fails a row whose signature is still on its way.
 */
export const CUSTODY_SIGNING_TIMEOUT_MS = 60_000;

/** The Fireblocks and Utila signers' default poll budget: 60 attempts, 1s apart. */
const DEFAULT_SIGNING_POLL_BUDGET_MS = 60 * 1_000;

/** Room past the poll budget for the signing request itself. */
const SIGNING_POLL_MARGIN_MS = 15_000;

/**
 * The longest any signing call may take, whatever the configured budget. A
 * recovery job treats a row still unsigned past its own window as dead and
 * fails it, after which a late signature can no longer be recorded. The
 * shortest such window is the Rings sweep's 2-minute grace for
 * `ready_to_sign` (`RINGS_UNSIGNED_GRACE_MS`); transfers wait 5 minutes. The
 * cap leaves 30 seconds of that window for the work before and after signing.
 * `signing-timeout.test.ts` pins it below both.
 */
export const MAX_CUSTODY_SIGNING_TIMEOUT_MS = 90_000;

type SigningBudgetEnv = {
  UTILA_POLL_INTERVAL_MS?: string;
  UTILA_MAX_POLL_ATTEMPTS?: string;
};

/** The configured custody poll budget plus its margin, before the cap. */
function requestedSigningTimeoutMs(env: SigningBudgetEnv): number {
  const interval = Number(env.UTILA_POLL_INTERVAL_MS ?? 1_000);
  const attempts = Number(env.UTILA_MAX_POLL_ATTEMPTS ?? 60);
  const utilaBudget = interval * attempts;
  const budget = Math.max(
    DEFAULT_SIGNING_POLL_BUDGET_MS,
    Number.isFinite(utilaBudget) ? utilaBudget : 0
  );
  return Math.max(CUSTODY_SIGNING_TIMEOUT_MS, budget + SIGNING_POLL_MARGIN_MS);
}

/**
 * The signing bound for this deployment: {@link CUSTODY_SIGNING_TIMEOUT_MS},
 * raised to the configured custody poll budget plus a margin, so the bound
 * never cuts off a signer that is still polling within its budget, and capped
 * at {@link MAX_CUSTODY_SIGNING_TIMEOUT_MS} so it never outlives recovery.
 * Utila's is the only budget set by configuration; Fireblocks uses the default.
 */
export function custodySigningTimeoutMs(env: SigningBudgetEnv): number {
  return Math.min(requestedSigningTimeoutMs(env), MAX_CUSTODY_SIGNING_TIMEOUT_MS);
}

/**
 * Logs at startup when the configured Utila poll budget is longer than the
 * signing cap allows, since signing calls are then cut off at the cap.
 */
export function warnIfCustodySigningBudgetCapped(env: SigningBudgetEnv): void {
  const requestedMs = requestedSigningTimeoutMs(env);
  if (requestedMs > MAX_CUSTODY_SIGNING_TIMEOUT_MS) {
    getLogger().warn(
      {
        event: "sdp_custody_signing_budget_capped",
        requested_ms: requestedMs,
        cap_ms: MAX_CUSTODY_SIGNING_TIMEOUT_MS,
      },
      "UTILA_POLL_INTERVAL_MS × UTILA_MAX_POLL_ATTEMPTS exceeds the custody signing cap; signing calls stop at the cap"
    );
  }
}

function withSigningTimeout<T>(signing: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new SigningError(`Custody signing timed out after ${timeoutMs}ms`, "NETWORK_ERROR")),
      timeoutMs
    );
  });
  return Promise.race([signing, timedOut]).finally(() => clearTimeout(timer));
}

/**
 * Bounds a custody signer's signing calls. Only calls that sign without
 * sending are bounded: a timed-out signature was never broadcast, so the
 * request's row stays unsigned and the reconciler settles it. A signer that
 * also sends is left alone, because a timeout there could report failure for a
 * transaction already on its way to the chain.
 */
export function boundSigningTime(
  signer: TransactionSigner,
  timeoutMs: number = CUSTODY_SIGNING_TIMEOUT_MS
): TransactionSigner {
  // Linked to the original, so every property it does not override (the
  // address, a sending method, anything on a class prototype) is the original's.
  const overrides: PropertyDescriptorMap = {};
  if ("signTransactions" in signer && typeof signer.signTransactions === "function") {
    const sign = signer.signTransactions.bind(signer);
    overrides.signTransactions = {
      value: (...args: Parameters<typeof sign>) => withSigningTimeout(sign(...args), timeoutMs),
    };
  }
  if (
    "modifyAndSignTransactions" in signer &&
    typeof signer.modifyAndSignTransactions === "function"
  ) {
    const modify = signer.modifyAndSignTransactions.bind(signer);
    overrides.modifyAndSignTransactions = {
      value: (...args: Parameters<typeof modify>) => withSigningTimeout(modify(...args), timeoutMs),
    };
  }
  // SAFETY: Object.create returns an object whose prototype is the signer, so
  // it carries every member of TransactionSigner; only signing is wrapped.
  return Object.create(signer, overrides) as TransactionSigner;
}
