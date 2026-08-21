import type { Address, Signature } from "@solana/kit";
import {
  accountExists,
  getSignatureStatuses,
  getTransaction,
  type ParsedTransaction,
  type SignatureStatusInfo,
  type SolanaRpc,
} from "./solana";
import { withTransientRpcRetry } from "./transient";

export interface VerifyTransactionLandedOptions {
  /** Account that must exist on-chain after the transaction (e.g. the created mint). */
  expectAccount?: Address;
}

export type VerifyTransactionLandedResult =
  | { ok: true; status: SignatureStatusInfo; transaction: ParsedTransaction }
  | { ok: false; reason: "not_confirmed" | "account_missing" | "not_indexed" };

/**
 * Verify that a caller-supplied signature actually landed on-chain before any
 * state is recorded from it. Three independent checks, each closing a hole the
 * previous one leaves open:
 *
 * 1. The signature must be confirmed (no error, past the `processed`-only
 *    stage) — a made-up signature fails here.
 * 2. When `expectAccount` is given, that account must now exist — a confirmed
 *    but unrelated transaction fails here.
 * 3. The transaction itself is fetched and returned so the caller can check it
 *    performed the expected operation — confirmed-signature + pre-existing
 *    account pairs fail in the caller's own check. `getSignatureStatuses` and
 *    `getTransaction` are indexed independently on the RPC, so a fresh
 *    transaction can be confirmed yet not queryable; that surfaces as
 *    `not_indexed`, which callers must treat as retryable rather than a
 *    permanent rejection.
 *
 * Verdicts are returned, not thrown; transient RPC failures are retried and
 * only rethrown once the retry schedule is exhausted.
 */
export async function verifyTransactionLanded(
  rpc: SolanaRpc,
  signature: Signature,
  options: VerifyTransactionLandedOptions = {}
): Promise<VerifyTransactionLandedResult> {
  const [status] = await withTransientRpcRetry(() => getSignatureStatuses(rpc, [signature]));

  if (!status || status.err !== null || status.confirmationStatus === "processed") {
    return { ok: false, reason: "not_confirmed" };
  }

  const { expectAccount } = options;
  if (expectAccount) {
    const exists = await withTransientRpcRetry(() => accountExists(rpc, expectAccount));
    if (!exists) {
      return { ok: false, reason: "account_missing" };
    }
  }

  const transaction = await getTransaction(rpc, signature);
  if (!transaction) {
    return { ok: false, reason: "not_indexed" };
  }

  return { ok: true, status, transaction };
}
