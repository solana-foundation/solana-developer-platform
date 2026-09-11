import type { PaymentsRepository, PaymentTransferRow } from "@/db/repositories/payments.repository";
import { AppError } from "@/lib/errors";
import type { SignedSubmissionStore } from "@/services/sponsorship-submission";

export type TransferSignedSubmissionStore = SignedSubmissionStore & {
  submittedRow(): Promise<PaymentTransferRow | null>;
};

export function createTransferSignedSubmissionStore(
  repository: PaymentsRepository,
  transfer: PaymentTransferRow
): TransferSignedSubmissionStore {
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
