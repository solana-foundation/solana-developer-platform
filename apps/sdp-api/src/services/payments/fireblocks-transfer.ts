import { FireblocksApiError } from "@sdp/custody/provisioning/fireblocks-http";
import {
  createFireblocksTransfer,
  type FireblocksTransferResult,
  readFireblocksTransfer,
  resolveFireblocksTransferAsset,
} from "@sdp/custody/provisioning/fireblocks-transfers";
import type { CustodyProvisioningRuntime } from "@sdp/custody/provisioning/runtime";
import { currentClusterScope } from "@sdp/rpc/scope";
import { compareDecimalAmounts, parseDecimalAmount } from "@sdp/solana/amount";
import { fireblocksPaymentStatus, isFireblocksPaymentMint } from "@sdp/types/fireblocks";
import { assertIsSignature } from "@solana/kit";
import { z } from "zod";
import { getDb } from "@/db/client";
import type { PaymentsRepository, PaymentTransferRow } from "@/db/repositories/payments.repository";
import { AppError, badRequest, conflict } from "@/lib/errors";
import { assertMoneyStartAdmitted } from "@/lib/money-admission";
import { getLogger } from "@/runtime/logger";
import { describeError } from "@/runtime/money-path-events";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import {
  isNativePaymentToken,
  type OutboundPaymentOperation,
} from "@/services/payment-operation.service";
import type { Env } from "@/types/env";

const intentSchema = z.object({
  connectionId: z.string(),
  accountFingerprint: z.string(),
  vaultAccountId: z.string(),
  assetId: z.string(),
});
type Intent = z.infer<typeof intentSchema>;
export interface PreparedFireblocksTransfer {
  intent: Intent;
}
const runtime: CustodyProvisioningRuntime = {
  fetch: (input, init) => globalThis.fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  randomUUID: () => crypto.randomUUID(),
  getRandomValues: (data) => crypto.getRandomValues(new Uint8Array(data)),
  sha256: (data) => crypto.subtle.digest("SHA-256", new Uint8Array(data)),
};

export function isFireblocksTransfer(row: PaymentTransferRow): boolean {
  return row.provider_data.fireblocksTransfer !== undefined;
}

/** Validate the exact owner, network and token before admitting a payment intent. */
export async function prepareFireblocksTransfer(
  env: Env,
  organizationId: string,
  projectId: string,
  operation: OutboundPaymentOperation
): Promise<PreparedFireblocksTransfer | null> {
  const access = await new CustodyRuntimeTargets(
    getDb(env),
    env,
    new Map()
  ).getFireblocksTransferAccess({
    organizationId,
    projectId,
    custodyWalletId: operation.sourceWallet.id,
    forSubmission: true,
  });
  if (!access) return null;
  if (access.publicKey !== operation.sourceAddress)
    throw conflict("Fireblocks source wallet changed");
  const network = currentClusterScope().cluster;
  const expectedAsset = network === "mainnet-beta" ? "SOL" : "SOL_TEST";
  if (access.assetId !== expectedAsset)
    throw badRequest("Fireblocks connection does not match the Solana network");
  const native = isNativePaymentToken(operation.token);
  if (!native && !isFireblocksPaymentMint(operation.token, network))
    throw badRequest("Fireblocks payments currently support SOL and USDC only");
  const asset = await resolveFireblocksTransferAsset(
    runtime,
    access,
    expectedAsset,
    native ? null : operation.token
  );
  let units: bigint;
  try {
    units = parseDecimalAmount(operation.amount, asset.decimals);
  } catch {
    throw badRequest(`Payment amount must have at most ${asset.decimals} decimal places`);
  }
  if (units <= 0n || units > 18446744073709551615n)
    throw badRequest("Payment amount is outside the supported range");
  if (!access.accountFingerprint) throw conflict("Fireblocks connection is unverified");
  return {
    intent: {
      connectionId: access.connectionId,
      accountFingerprint: access.accountFingerprint,
      vaultAccountId: access.vaultAccountId,
      assetId: asset.id,
    },
  };
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

async function persistResult(
  repo: PaymentsRepository,
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
  return (
    (await repo.updateTransfer({
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
      },
      error: status === "failed" ? providerFailure(result) : null,
      updatedAt: new Date().toISOString(),
    })) ?? (await currentRow(repo, row))
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
export async function submitFireblocksTransfer(
  env: Env,
  repo: PaymentsRepository,
  row: PaymentTransferRow
): Promise<PaymentTransferRow> {
  if (!row.destination_address || !row.amount || !row.project_id || !row.custody_wallet_id)
    throw badRequest("Incomplete payment intent");
  const startedAt = new Date().toISOString();
  const claimed = await repo.claimFireblocksTransferSubmission({
    transferId: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    now: startedAt,
  });
  if (!claimed) return currentRow(repo, row);
  let submissionAttempted = false;
  try {
    const intent = intentSchema.parse(claimed.provider_data.fireblocksTransfer);
    // Preparation can precede asset discovery and durable payment/audit writes.
    // Resolve fresh custody state after those awaits; never submit captured credentials.
    const access = await new CustodyRuntimeTargets(
      getDb(env),
      env,
      new Map()
    ).getFireblocksTransferAccess({
      organizationId: row.organization_id,
      projectId: row.project_id,
      custodyWalletId: row.custody_wallet_id,
      forSubmission: true,
    });
    const expectedAsset = currentClusterScope().cluster === "mainnet-beta" ? "SOL" : "SOL_TEST";
    if (
      !access ||
      access.connectionId !== intent.connectionId ||
      access.accountFingerprint !== intent.accountFingerprint ||
      access.vaultAccountId !== intent.vaultAccountId ||
      access.publicKey !== claimed.source_address ||
      access.assetId !== expectedAsset
    )
      throw conflict("Fireblocks connection does not match the payment intent");
    await assertMoneyStartAdmitted(
      env,
      { organizationId: row.organization_id, projectId: row.project_id },
      { surface: "http", movement: "payments.transfer", subjectId: row.id },
      { custodyWalletId: row.custody_wallet_id }
    );
    submissionAttempted = true;
    const result = await createFireblocksTransfer(runtime, access, {
      operation: "TRANSFER",
      externalTxId: row.id,
      assetId: intent.assetId,
      source: { type: "VAULT_ACCOUNT", id: intent.vaultAccountId },
      destination: {
        type: "ONE_TIME_ADDRESS",
        oneTimeAddress: { address: row.destination_address },
      },
      amount: row.amount,
      treatAsGrossAmount: false,
      // SDP's memo is a payment note, not an instruction added to the chain.
      note: `SDP ${row.id}${row.memo ? `: ${row.memo}` : ""}`,
    });
    return await persistResult(repo, claimed, result, false);
  } catch (error) {
    if (!submissionAttempted) {
      // A local refusal is definitely unsent, unlike an ambiguous provider outcome.
      await repo.updateTransfer({
        transferId: row.id,
        organizationId: row.organization_id,
        projectId: row.project_id,
        expectedStatus: "processing",
        status: "failed",
        error:
          error instanceof AppError
            ? error.toResponse().error.message
            : "Fireblocks admission failed before submission",
        providerData: {
          executionFailure: { code: error instanceof AppError ? error.code : "INTERNAL_ERROR" },
        },
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }
    // A timeout, duplicate-ID conflict, invalid response, or DB failure may follow acceptance.
    // Keep the claim and recover by externalTxId; never turn uncertainty into permission to resend.
    if (error instanceof FireblocksApiError && [400, 401, 403, 422, 429].includes(error.status)) {
      return (
        (await repo.updateTransfer({
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
  repo: PaymentsRepository,
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
    (await repo.updateTransfer({
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
    })) ?? currentRow(repo, row)
  );
}

/** Dashboard and cron reconciliation. Neither path can POST or automatically resubmit. */
export async function refreshFireblocksTransfer(
  env: Env,
  repo: PaymentsRepository,
  row: PaymentTransferRow
): Promise<PaymentTransferRow> {
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
    const access = await new CustodyRuntimeTargets(
      getDb(env),
      env,
      new Map()
    ).getFireblocksTransferAccess({
      organizationId: row.organization_id,
      projectId: row.project_id,
      custodyWalletId: row.custody_wallet_id,
      forSubmission: false,
      intent: { ...intent, sourceAddress: row.source_address },
    });
    if (!access) throw conflict("Fireblocks connection does not match the payment intent");
    const result = await readFireblocksTransfer(runtime, access, row.id);
    return result
      ? await persistResult(repo, claimed, result, true)
      : await recordMissingTransaction(repo, claimed, now);
  } catch (error) {
    getLogger().warn(
      { transferId: row.id, ...describeError(error) },
      "fireblocks_transfer_status_unavailable"
    );
    return currentRow(repo, claimed);
  }
}
