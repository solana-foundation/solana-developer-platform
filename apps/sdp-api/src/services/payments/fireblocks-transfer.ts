import {
  type CustodyProvisioningRuntime,
  createFireblocksTransfer,
  FireblocksApiError,
  type FireblocksTransferResult,
  readFireblocksTransfer,
  resolveFireblocksTransferAsset,
} from "@sdp/custody/provisioning";
import { getSolanaConfig } from "@sdp/rpc";
import { parseDecimalAmount } from "@sdp/solana/amount";
import { wellKnownMint } from "@sdp/types";
import { assertIsSignature } from "@solana/kit";
import { z } from "zod";
import { getDb } from "@/db";
import type { PaymentsRepository, PaymentTransferRow } from "@/db/repositories/payments.repository";
import { badRequest, conflict } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
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
type Access = NonNullable<
  Awaited<ReturnType<CustodyRuntimeTargets["getFireblocksTransferAccess"]>>
>;
export interface PreparedFireblocksTransfer {
  access: Access;
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
  const network = getSolanaConfig(env).network;
  const expectedAsset =
    network === "mainnet-beta" ? "SOL" : network === "devnet" ? "SOL_TEST" : null;
  if (!expectedAsset || access.assetId !== expectedAsset)
    throw badRequest("Fireblocks connection does not match the Solana network");
  const native = isNativePaymentToken(operation.token);
  if (!native && operation.token !== wellKnownMint("USDC", network))
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
    access,
    intent: {
      connectionId: access.connectionId,
      accountFingerprint: access.accountFingerprint,
      vaultAccountId: access.vaultAccountId,
      assetId: asset.id,
    },
  };
}

const failed = new Set(["FAILED", "REJECTED", "CANCELLED", "CANCELED", "BLOCKED"]);
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
  const status = failed.has(result.status) ? "failed" : completed ? "confirmed" : "processing";
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
  repo: PaymentsRepository,
  row: PaymentTransferRow,
  prepared: PreparedFireblocksTransfer
): Promise<PaymentTransferRow> {
  if (!row.destination_address || !row.amount) throw badRequest("Incomplete payment intent");
  const startedAt = new Date().toISOString();
  const claimed = await repo.claimTransferProviderData({
    transferId: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    expectedStatus: "processing",
    // biome-ignore lint/security/noSecrets: Durable database field name.
    claimPath: ["fireblocksSubmissionStartedAt"],
    providerData: { fireblocksSubmissionStartedAt: startedAt },
    updatedAt: startedAt,
  });
  if (!claimed) return currentRow(repo, row);
  try {
    const result = await createFireblocksTransfer(runtime, prepared.access, {
      operation: "TRANSFER",
      externalTxId: row.id,
      assetId: prepared.intent.assetId,
      source: { type: "VAULT_ACCOUNT", id: prepared.intent.vaultAccountId },
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
    // A timeout, duplicate-ID conflict, invalid response, or DB failure may follow acceptance.
    // Keep the claim and recover by externalTxId; never turn uncertainty into permission to resend.
    if (error instanceof FireblocksApiError && [400, 401, 403, 422].includes(error.status)) {
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
    getLogger().warn({ transferId: row.id }, "fireblocks_transfer_submission_outcome_unknown");
    return currentRow(repo, claimed);
  }
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
    });
    if (
      !access ||
      access.connectionId !== intent.connectionId ||
      access.accountFingerprint !== intent.accountFingerprint ||
      access.vaultAccountId !== intent.vaultAccountId ||
      access.publicKey !== row.source_address
    )
      throw conflict("Fireblocks connection does not match the payment intent");
    const result = await readFireblocksTransfer(runtime, access, row.id);
    return result ? await persistResult(repo, claimed, result, true) : claimed;
  } catch {
    getLogger().warn({ transferId: row.id }, "fireblocks_transfer_status_unavailable");
    return currentRow(repo, claimed);
  }
}
