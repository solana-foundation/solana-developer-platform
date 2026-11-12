import { FireblocksApiError } from "@sdp/custody/provisioning/fireblocks-http";
import type { FireblocksTransferResult } from "@sdp/custody/provisioning/fireblocks-transfers";
import { compareDecimalAmounts, parseDecimalAmount } from "@sdp/solana/amount";
import { fireblocksPaymentStatus, isFireblocksPolicyRefusal } from "@sdp/types/fireblocks";
import { assertIsSignature } from "@solana/kit";
import type {
  PaymentsRepository,
  PaymentTransferRow,
  UpdatePaymentTransferInput,
} from "@/db/repositories/payments.repository";
import { AppError, badRequest, conflict, custodyPolicyRefusalMessage } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import { describeError } from "@/runtime/money-path-events";
import { type AuditLogEntry, criticalOutcomeEntry } from "@/services/audit.service";
import {
  type CustodyTransferProposer,
  transferProposalIntentSchema as intentSchema,
  ProposalNotSentError,
} from "@/services/domain/signing/admitted-proposer";
import { createOrgTransferProposalReader } from "@/services/solana/signer";
import type { Env } from "@/types/env";

/**
 * Row state for transfers a custody provider builds and sends itself (PRO-2435 D2). Admission,
 * credentials and the provider call all live in the custody waist (`admitted-proposer.ts`); this
 * file only claims, records and reconciles the payment row, so a proposed transfer and a signed
 * one share the transfer handler, its idempotency, its audit and its failure path.
 */

/**
 * Where a proposed transfer's row state is written. Plain observations go to `repo`; a write that
 * ends the payment commits through `audited`, with the outcome that closes the row's open audit
 * intent, exactly as a signed transfer's settle does (HOO-2556). A request passes its own ledger
 * transaction; the pending-transfers job builds one over the system audit service.
 */
export interface ProposalLedger {
  repo: PaymentsRepository;
  audited<T>(
    work: (repo: PaymentsRepository) => Promise<{ entry: AuditLogEntry | null; result: T }>
  ): Promise<T>;
}

/** The outcome that closes the intent the sending request opened, with Fireblocks' verdict. */
function proposalAuditOutcome(
  row: PaymentTransferRow,
  auditIntentId: string,
  settled: PaymentTransferRow
): AuditLogEntry {
  const metadata: Record<string, unknown> = {
    status: settled.status,
    fireblocksTransactionId: settled.provider_reference,
    fireblocksStatus: settled.provider_data.fireblocksStatus ?? null,
    signature: settled.signature,
  };
  if (settled.status === "failed") metadata.error = settled.error;
  return criticalOutcomeEntry(
    {
      id: auditIntentId,
      entry: {
        organizationId: row.organization_id,
        action: "transfer",
        resourceType: "payment_transfer",
        resourceId: row.id,
      },
    },
    { status: settled.status === "failed" ? "failure" : "success", metadata }
  );
}

/**
 * Writes one guarded update. A terminal one closes the row's open audit intent in the same
 * transaction: a ledger failure rolls the settle back, so the payment stays processing and the
 * next read or run settles and audits it again. Clearing the intent is the claim, so of the
 * request, a viewer and the cron only the first appends an outcome.
 */
async function writeTransfer(
  ledger: ProposalLedger,
  row: PaymentTransferRow,
  update: UpdatePaymentTransferInput
): Promise<PaymentTransferRow | null> {
  const auditIntentId = row.audit_intent_id;
  if (update.status === undefined || update.status === "processing" || auditIntentId === null)
    return ledger.repo.updateTransfer(update);
  return ledger.audited(async (repo) => {
    const settled = await repo.updateTransfer(update);
    const claimed =
      settled !== null &&
      (await repo.closeTransferAuditIntent({
        transferId: row.id,
        organizationId: row.organization_id,
        projectId: row.project_id,
        auditIntentId,
      }));
    return {
      entry: claimed && settled ? proposalAuditOutcome(row, auditIntentId, settled) : null,
      result: settled,
    };
  });
}

export function isFireblocksTransfer(row: PaymentTransferRow): boolean {
  return row.provider_data.fireblocksTransfer !== undefined;
}

function providerFailure(result: FireblocksTransferResult): string {
  const subStatus =
    result.subStatus && /^[A-Z0-9_]{1,100}$/.test(result.subStatus) ? ` (${result.subStatus})` : "";
  const next =
    result.status === "BLOCKED"
      ? " Check this transfer's approval and destination rules in Fireblocks."
      : " Review this transaction in Fireblocks.";
  return `Fireblocks ${result.status}${subStatus}.${next}`;
}

/**
 * What a failed native transfer records. A confirmed policy block keeps the custody policy
 * refusal's message and code, so the row, the dashboard and a replay of its key read like a
 * refused signature (HOO-2478); any other failure keeps Fireblocks' status.
 */
function failureRecord(result: FireblocksTransferResult): {
  error: string;
  providerData: { executionFailure?: { code: "CUSTODY_POLICY_REFUSED" } };
} {
  if (isFireblocksPolicyRefusal(result)) {
    return {
      error: custodyPolicyRefusalMessage("fireblocks"),
      providerData: { executionFailure: { code: "CUSTODY_POLICY_REFUSED" } },
    };
  }
  return { error: providerFailure(result), providerData: {} };
}

async function persistResult(
  ledger: ProposalLedger,
  row: PaymentTransferRow,
  result: FireblocksTransferResult,
  detail: boolean
): Promise<PaymentTransferRow> {
  const intent = intentSchema.parse(row.provider_data.fireblocksTransfer);
  if (row.provider_reference && row.provider_reference !== result.id)
    throw conflict("Fireblocks transaction identity changed");
  if (
    detail &&
    (result.externalTxId !== row.id ||
      result.operation !== "TRANSFER" ||
      result.assetId !== intent.assetId ||
      result.source?.type !== "VAULT_ACCOUNT" ||
      result.source.id !== intent.vaultAccountId)
  )
    throw conflict("Fireblocks transaction does not match the payment intent");
  let signature: string | undefined;
  if (result.txHash) {
    assertIsSignature(result.txHash);
    signature = result.txHash;
  }
  // A hash during approval/broadcast can still be replaced. Only COMPLETED is a chain verdict.
  const completed = detail && result.status === "COMPLETED" && signature !== undefined;
  if (completed) {
    // Fireblocks may omit destinationAddress before confirmation. A completed
    // transfer must prove the exact destination and net payment, using decimal
    // strings rather than the deprecated floating-point amount fields.
    const amounts = result.amountInfo;
    if (
      result.destinationAddress !== row.destination_address ||
      !row.amount ||
      !amounts?.amount ||
      !amounts.netAmount ||
      compareDecimalAmounts(amounts.amount, row.amount) !== 0 ||
      compareDecimalAmounts(amounts.netAmount, row.amount) !== 0 ||
      (amounts.requestedAmount != null &&
        compareDecimalAmounts(amounts.requestedAmount, row.amount) !== 0)
    )
      throw conflict("Fireblocks settlement does not match the payment destination and amount");
  }
  let fee: number | undefined;
  if (
    completed &&
    (result.feeCurrency === "SOL" || result.feeCurrency === "SOL_TEST") &&
    typeof result.feeInfo?.networkFee === "string"
  ) {
    try {
      const lamports = parseDecimalAmount(result.feeInfo.networkFee, 9);
      if (lamports <= BigInt(Number.MAX_SAFE_INTEGER)) fee = Number(lamports);
    } catch {
      /* An unavailable fee must not prevent recording a confirmed payment. */
    }
  }
  const status = fireblocksPaymentStatus(result.status, completed);
  const failure = status === "failed" ? failureRecord(result) : null;
  return (
    (await writeTransfer(ledger, row, {
      transferId: row.id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      expectedStatus: "processing",
      status,
      signature: completed ? signature : undefined,
      fee,
      providerReference: result.id,
      providerData: {
        fireblocksStatus: result.status,
        fireblocksSubStatus:
          result.subStatus && /^[A-Z0-9_]{1,100}$/.test(result.subStatus) ? result.subStatus : null,
        ...failure?.providerData,
      },
      error: failure?.error ?? null,
      updatedAt: new Date().toISOString(),
    })) ?? (await currentRow(ledger.repo, row))
  );
}

async function currentRow(repo: PaymentsRepository, row: PaymentTransferRow) {
  return (
    (await repo.getTransferById({
      transferId: row.id,
      organizationId: row.organization_id,
      projectId: row.project_id,
    })) ?? row
  );
}

/** Exactly one create attempt per durable intent. Recovery never sends funds. */
export async function submitProposedTransfer(
  ledger: ProposalLedger,
  row: PaymentTransferRow,
  proposer: CustodyTransferProposer
): Promise<PaymentTransferRow> {
  const { repo } = ledger;
  if (!row.destination_address || !row.amount || !row.project_id || !row.source_address)
    throw badRequest("Incomplete payment intent");
  const claimed = await repo.claimFireblocksTransferSubmission({
    transferId: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    now: new Date().toISOString(),
  });
  if (!claimed) return currentRow(repo, row);
  try {
    // The waist admits and re-reads the live credential before it sends; nothing captured at
    // prepare time is submitted.
    const result = await proposer.propose({
      externalId: row.id,
      intent: intentSchema.parse(claimed.provider_data.fireblocksTransfer),
      sourceAddress: row.source_address,
      destination: row.destination_address,
      amount: row.amount,
      memo: row.memo,
    });
    return await persistResult(ledger, claimed, result, false);
  } catch (error) {
    if (error instanceof ProposalNotSentError) {
      // A refusal before submission is definitely unsent, unlike an ambiguous provider outcome.
      const refusal = error.cause;
      await writeTransfer(ledger, claimed, {
        transferId: row.id,
        organizationId: row.organization_id,
        projectId: row.project_id,
        expectedStatus: "processing",
        status: "failed",
        error:
          refusal instanceof AppError
            ? refusal.toResponse().error.message
            : "Fireblocks admission failed before submission",
        providerData: {
          executionFailure: { code: refusal instanceof AppError ? refusal.code : "INTERNAL_ERROR" },
        },
        updatedAt: new Date().toISOString(),
      });
      throw refusal;
    }
    // A timeout, duplicate-ID conflict, invalid response, or DB failure may follow acceptance.
    // Keep the claim and recover by externalTxId; never turn uncertainty into permission to resend.
    if (error instanceof FireblocksApiError && [400, 401, 403, 422, 429].includes(error.status)) {
      return (
        (await writeTransfer(ledger, claimed, {
          transferId: row.id,
          organizationId: row.organization_id,
          projectId: row.project_id,
          expectedStatus: "processing",
          status: "failed",
          error: `${error.message}. Check the API user's permissions and Fireblocks destination policy.`,
          updatedAt: new Date().toISOString(),
        })) ?? currentRow(repo, row)
      );
    }
    getLogger().warn(
      { transferId: row.id, ...describeError(error) },
      "fireblocks_transfer_submission_outcome_unknown"
    );
    return currentRow(repo, claimed);
  }
}

const MISSING_TRANSACTION_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A known provider transaction can never be failed from an unavailable lookup. */
async function recordMissingTransaction(
  ledger: ProposalLedger,
  row: PaymentTransferRow,
  now: number
) {
  if (row.provider_reference) {
    getLogger().error(
      { transferId: row.id, fireblocksTransactionId: row.provider_reference },
      "fireblocks_known_transaction_missing"
    );
    return row;
  }
  const firstMissing = row.provider_data.fireblocksFirstMissingAt;
  const elapsed = typeof firstMissing === "string" ? now - Date.parse(firstMissing) : 0;
  // Two authenticated 404s separated by at least 24h, bound to the same
  // account, establish that the unacknowledged intent is still absent.
  const absent = elapsed >= MISSING_TRANSACTION_WINDOW_MS;
  if (absent) getLogger().warn({ transferId: row.id }, "fireblocks_unaccepted_transfer_expired");
  return (
    (await writeTransfer(ledger, row, {
      transferId: row.id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      expectedStatus: "processing",
      status: absent ? "failed" : "processing",
      expectedProviderReference: null,
      providerData: {
        fireblocksFirstMissingAt:
          typeof firstMissing === "string" ? firstMissing : new Date(now).toISOString(),
      },
      error: absent
        ? "Fireblocks still has no transaction for this payment after 24 hours of recovery. Review the payment in Fireblocks before intentionally starting a new transfer."
        : null,
      updatedAt: new Date(now).toISOString(),
    })) ?? currentRow(ledger.repo, row)
  );
}

/** Dashboard and cron reconciliation. Neither path can POST or automatically resubmit. */
export async function refreshFireblocksTransfer(
  env: Env,
  ledger: ProposalLedger,
  row: PaymentTransferRow
): Promise<PaymentTransferRow> {
  const { repo } = ledger;
  if (
    !isFireblocksTransfer(row) ||
    row.status !== "processing" ||
    !row.project_id ||
    !row.custody_wallet_id
  )
    return row;
  const now = Date.now();
  const claimed = await repo.claimFireblocksTransferPoll({
    transferId: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    now: new Date(now).toISOString(),
    polledBefore: new Date(now - 15_000).toISOString(),
  });
  if (!claimed) return currentRow(repo, row);
  try {
    const intent = intentSchema.parse(claimed.provider_data.fireblocksTransfer);
    const reader = await createOrgTransferProposalReader(
      env,
      row.organization_id,
      row.project_id,
      row.custody_wallet_id,
      { ...intent, sourceAddress: row.source_address }
    );
    const result = await reader.read(row.id);
    return result
      ? await persistResult(ledger, claimed, result, true)
      : await recordMissingTransaction(ledger, claimed, now);
  } catch (error) {
    getLogger().warn(
      { transferId: row.id, ...describeError(error) },
      "fireblocks_transfer_status_unavailable"
    );
    return currentRow(repo, claimed);
  }
}
