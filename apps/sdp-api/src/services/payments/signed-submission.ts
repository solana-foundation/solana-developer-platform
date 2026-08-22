import { isTransientRpcError, withTransientRpcRetry } from "@sdp/rpc";
import * as solanaRpc from "@sdp/rpc/solana";
import {
  getBase64Decoder,
  isSolanaError,
  type Signature,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  unwrapSimulationError,
} from "@solana/kit";
import type { PaymentsRepository, PaymentTransferRow } from "@/db/repositories/payments.repository";
import { AppError, accountFrozen, transactionFailed } from "@/lib/errors";
import type { SponsorshipFeePayment } from "@/services/sponsorship.service";

export interface SignedSubmissionStore {
  persistSigned(input: {
    signature: Signature;
    signedTransaction: string;
    lastValidBlockHeight: string;
  }): Promise<void>;
  markStarted(): Promise<void>;
  hasStarted(): Promise<boolean>;
}

export function isDefiniteSubmissionError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error.code === "TRANSACTION_FAILED" || error.code === "ACCOUNT_FROZEN")
  );
}

function mapPreflightError(error: unknown): AppError | null {
  if (
    !isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)
  ) {
    return null;
  }
  const cause = unwrapSimulationError(error);
  const message = cause instanceof Error ? cause.message : error.message;
  return isSolanaError(cause, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM) && cause.context.code === 17
    ? accountFrozen(message)
    : transactionFailed(message);
}

export function createTransferSignedSubmissionStore(
  repository: PaymentsRepository,
  transfer: PaymentTransferRow
): SignedSubmissionStore & { submittedRow(): Promise<PaymentTransferRow | null> } {
  let row: PaymentTransferRow | null = null;
  let startState: "not_started" | "unknown" | "started" = "not_started";
  return {
    persistSigned: async ({ signature, signedTransaction, lastValidBlockHeight }) => {
      row = await repository.persistSignedTransfer({
        transferId: transfer.id,
        organizationId: transfer.organization_id,
        projectId: transfer.project_id,
        signature,
        signedTransaction,
        lastValidBlockHeight,
        updatedAt: new Date().toISOString(),
      });
      if (!row) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Payment transfer signed submission was not persisted"
        );
      }
    },
    markStarted: async () => {
      startState = "unknown";
      const startedRow = await repository.markTransferSubmissionStarted({
        transferId: transfer.id,
        organizationId: transfer.organization_id,
        projectId: transfer.project_id,
        startedAt: new Date().toISOString(),
      });
      if (!startedRow) {
        throw new AppError("INTERNAL_ERROR", "Payment transfer submission was not started");
      }
      row = startedRow;
      startState = "started";
    },
    hasStarted: async () => {
      const current = await repository.getTransferById({
        transferId: transfer.id,
        organizationId: transfer.organization_id,
        projectId: transfer.project_id,
      });
      if (current) row = current;
      const started =
        current?.submission_started_at !== null && current?.submission_started_at !== undefined;
      startState = started ? "started" : "not_started";
      return started;
    },
    submittedRow: async () => (startState === "not_started" ? null : row),
  };
}

export async function submitSignedPaymentTransaction(input: {
  feePayment: SponsorshipFeePayment;
  rpc: solanaRpc.SolanaRpc;
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
  const submittedSignature = await withTransientRpcRetry(async () => {
    try {
      return await solanaRpc.sendTransaction(input.rpc, submission.signedTransaction);
    } catch (error) {
      const preflightError = sawTransientFailure ? null : mapPreflightError(error);
      if (preflightError) {
        try {
          await submission.releaseDefinitelyUnbroadcast(error);
        } catch {
          // Managed sponsorship logs and trips its breaker; preserve the
          // definitive chain verdict so the payment cannot remain processing.
        }
        throw preflightError;
      }
      const transient = isTransientRpcError(error);
      if (sawTransientFailure && !transient) {
        throw new Error("Solana RPC submission outcome is ambiguous after a transient failure", {
          cause: error,
        });
      }
      sawTransientFailure ||= transient;
      throw error;
    }
  });
  if (submittedSignature !== submission.signature) {
    throw new Error("Solana RPC returned a different transaction signature");
  }
  return submission.signature;
}
