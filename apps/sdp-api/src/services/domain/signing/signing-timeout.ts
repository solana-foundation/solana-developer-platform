import { SigningError } from "@sdp/custody/signing";
import type { TransactionSigner } from "@solana/kit";

/**
 * How long one custody signing call may take (HOO-1918). Past it the request
 * fails instead of hanging and holding its Idempotency-Key. It sits well under
 * the reconciler's five-minute threshold for unsigned rows, so the reconciler
 * never fails a row whose signature is still on its way.
 */
export const CUSTODY_SIGNING_TIMEOUT_MS = 60_000;

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
