import { type SolanaRpc, sendTransaction } from "@sdp/rpc/solana";
import { isTransientRpcError, withTransientRpcRetry } from "@sdp/rpc/transient";
import {
  getBase64Decoder,
  isSolanaError,
  type Signature,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  unwrapSimulationError,
} from "@solana/kit";
import { AppError, accountFrozen, solanaRpcError, transactionFailed } from "@/lib/errors";
import type { SponsorshipFeePayment } from "@/services/sponsorship.service";

const PROGRAM_ERROR_LINE = /^Program log: Error: /;
const PROGRAM_FAILED_LINE = /^Program .* failed: /;

export interface SignedSubmissionStore {
  persistSigned(input: {
    signature: Signature;
    signedTransaction: string;
    lastValidBlockHeight: string;
  }): Promise<void>;
  markStarted(): Promise<void>;
  hasStarted(): Promise<boolean>;
  /**
   * Forget `signature`, which `persistSigned` saved, after its send was provably refused, so
   * recovery does not wait on a transaction that never left. A store whose row is marked failed
   * anyway does nothing.
   */
  clearSigned(signature: Signature): Promise<void>;
}

/**
 * Identifies a submission error that proves the transaction was not broadcast.
 *
 * @param error - The error returned by the sponsored submission path.
 * @returns Whether the error is a definitive preflight rejection.
 */
export function isDefiniteSubmissionError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error.code === "TRANSACTION_FAILED" || error.code === "ACCOUNT_FROZEN")
  );
}

/**
 * Maps a Solana preflight rejection to the public money-path error contract.
 *
 * @param error - The RPC error to inspect.
 * @returns The mapped application error, or null when the outcome is ambiguous.
 */
export function mapPreflightError(error: unknown): AppError | null {
  if (
    !isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)
  ) {
    return null;
  }
  const cause = unwrapSimulationError(error);
  const message = cause instanceof Error ? cause.message : error.message;
  if (isSolanaError(cause, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM) && cause.context.code === 17) {
    return accountFrozen(message);
  }
  const logs = error.context.logs;
  const lines = logs === null ? [] : logs;
  const programError = lines.filter((line) => PROGRAM_ERROR_LINE.test(line)).at(-1);
  const programFailed = lines.filter((line) => PROGRAM_FAILED_LINE.test(line)).at(-1);
  let diagnostic = message;
  if (programError !== undefined) {
    diagnostic = programError;
  } else if (programFailed !== undefined) {
    diagnostic = programFailed;
  }
  return transactionFailed(diagnostic, { logs });
}

/**
 * Signs, durably records, and submits an owned sponsored transaction for any money path.
 *
 * @param input - Sponsorship, RPC, transaction lifetime, and durable lifecycle store.
 * @returns The signature of the submitted transaction.
 */
export async function submitSponsoredTransaction(input: {
  feePayment: SponsorshipFeePayment;
  rpc: SolanaRpc;
  transaction: Uint8Array;
  lastValidBlockHeight: bigint;
  store: SignedSubmissionStore;
}): Promise<Signature> {
  const submission = await input.feePayment.prepareOwnedSubmission(input.transaction, {
    persistSigned: ({ signature, signedTransaction }) =>
      input.store.persistSigned({
        signature,
        signedTransaction: getBase64Decoder().decode(signedTransaction),
        lastValidBlockHeight: input.lastValidBlockHeight.toString(),
      }),
    markStarted: input.store.markStarted,
    hasStarted: input.store.hasStarted,
  });

  let sawTransientFailure = false;
  // A refusal is returned, not thrown: a returned value is never retried, so nothing re-sends
  // these bytes once the reservation is released below.
  const outcome = await withTransientRpcRetry(
    async (): Promise<
      { kind: "sent"; signature: Signature } | { kind: "refused"; cause: unknown; mapped: AppError }
    > => {
      try {
        return {
          kind: "sent",
          signature: await sendTransaction(input.rpc, submission.signedTransaction),
        };
      } catch (error) {
        const preflightError = sawTransientFailure ? null : mapPreflightError(error);
        if (preflightError) return { kind: "refused", cause: error, mapped: preflightError };
        const transient = isTransientRpcError(error);
        if (sawTransientFailure && !transient) {
          throw new Error("Solana RPC submission outcome is ambiguous after a transient failure", {
            cause: error,
          });
        }
        sawTransientFailure ||= transient;
        throw error;
      }
    }
  );
  if (outcome.kind === "refused") {
    // Agave answers a preflight failure before it forwards the transaction (rpc/src/rpc.rs
    // @ b1912476ed: SendTransactionPreflightFailure at :4046, ahead of _send_transaction at
    // :4069), so nothing was broadcast.
    try {
      await submission.releaseDefinitelyUnbroadcast(outcome.cause);
    } catch {
      // Managed sponsorship logs and trips its breaker; preserve the
      // definitive chain verdict so the payment cannot remain processing.
    }
    await input.store.clearSigned(submission.signature);
    throw outcome.mapped;
  }
  const submittedSignature = outcome.signature;
  if (submittedSignature !== submission.signature) {
    throw solanaRpcError("Solana RPC returned a different transaction signature");
  }
  return submission.signature;
}
