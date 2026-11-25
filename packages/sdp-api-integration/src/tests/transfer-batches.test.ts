import { apiTestSupport } from "@sdp/api/test-support";
import { createRpc, getSignatureStatuses, type SolanaRpc } from "@sdp/rpc/solana";
import {
  ONCHAIN_TRANSFER_SETTLED_STATUSES,
  PAYMENT_TRANSFER_BATCH_RECIPIENT_STATUSES,
  PAYMENT_TRANSFER_BATCH_STATUSES,
  PAYMENT_TRANSFER_STATUSES,
} from "@sdp/types/payments";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import {
  type Commitment,
  generateKeyPairSigner,
  type Signature,
  signature as toSignature,
} from "@solana/kit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  cleanupIntegrationSuite,
  createFundedIntegrationWallet,
  initIntegrationSuite,
  RUN_INTEGRATION_TESTS,
  requestWithApiKey,
  resetIntegrationState,
  SOLANA_CONFIGURED,
} from "#/helpers/integration";
import { env } from "#env-impl";

const { trackPendingTransfers } = apiTestSupport;

const counterpartyResponseSchema = z.object({
  data: z.object({ counterparty: z.object({ id: z.string() }) }),
});
const counterpartyAccountResponseSchema = z.object({
  data: z.object({ account: z.object({ id: z.string() }) }),
});
const transferBatchResponseSchema = z.object({
  data: z.object({
    batch: z.object({
      id: z.string(),
      status: z.enum(PAYMENT_TRANSFER_BATCH_STATUSES),
      recipientCount: z.number(),
      transactionCount: z.number(),
    }),
    recipients: z.array(z.object({ status: z.enum(PAYMENT_TRANSFER_BATCH_RECIPIENT_STATUSES) })),
    transfers: z.array(
      z.object({ status: z.enum(PAYMENT_TRANSFER_STATUSES), signature: z.string().nullable() })
    ),
  }),
});

const RECIPIENT_COUNT = 4;
const RECIPIENT_AMOUNT_SOL = "0.002";
const RECIPIENT_AMOUNT_LAMPORTS = 2_000_000n;

function integrationRpc(): SolanaRpc {
  const solanaRpcUrl = env.SOLANA_RPC_URL;
  if (!solanaRpcUrl) {
    throw new Error("SOLANA_RPC_URL is not configured for integration tests.");
  }
  return createRpc(solanaRpcUrl);
}

/**
 * Polls surfpool for the given signatures until every one reports at least the
 * target commitment, so reconciliation observes real on-chain statuses.
 * Searches transaction history because finalization can outlive the node's
 * recent-status cache.
 */
async function waitForSignatureCommitment(
  signatures: Signature[],
  target: Exclude<Commitment, "processed">,
  timeoutMs: number
): Promise<void> {
  const rpc = integrationRpc();
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const statuses = await getSignatureStatuses(rpc, signatures, {
      searchTransactionHistory: true,
    });
    const allReached = statuses.every(
      (status) =>
        status !== null &&
        status.err === null &&
        (status.confirmationStatus === target || status.confirmationStatus === "finalized")
    );
    if (allReached) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `Timed out waiting for batch signatures to reach ${target} on-chain after ${timeoutMs}ms`
  );
}

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("Transfer Batches On-Chain", () => {
  let apiKeyHash: string;
  const request = requestWithApiKey();

  beforeAll(async () => {
    const init = await initIntegrationSuite();
    apiKeyHash = init.apiKeyHash;
  });

  afterAll(async () => {
    await cleanupIntegrationSuite();
  });

  beforeEach(async () => {
    await resetIntegrationState(apiKeyHash);
  });

  it("executes a SOL transfer batch on-chain and reconciles it to confirmed, then finalized", {
    timeout: 300_000,
  }, async () => {
    const sourceWallet = await createFundedIntegrationWallet({
      label: "Batch Source Wallet",
      fundLamports: 50_000_000,
    });

    const counterpartyRes = await request("/v1/counterparties", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityType: "individual",
        displayName: "Batch Integration Counterparty",
        externalId: `batch-integration-${Date.now()}`,
      }),
    });
    expect(counterpartyRes.status).toBe(201);
    const counterpartyId = counterpartyResponseSchema.parse(await counterpartyRes.json()).data
      .counterparty.id;

    const destinationSigners = await Promise.all(
      Array.from({ length: RECIPIENT_COUNT }, () => generateKeyPairSigner())
    );
    const accountIds: string[] = [];
    for (const destinationSigner of destinationSigners) {
      const accountRes = await request(`/v1/counterparties/${counterpartyId}/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountKind: "crypto_wallet",
          label: "Batch integration destination",
          details: { network: "solana", address: destinationSigner.address },
        }),
      });
      expect(accountRes.status).toBe(201);
      accountIds.push(
        counterpartyAccountResponseSchema.parse(await accountRes.json()).data.account.id
      );
    }

    const createRes = await request("/v1/payments/transfer-batches/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        externalId: `batch-integration-run-${Date.now()}`,
        sourceCustodyWalletId: sourceWallet.id,
        token: WELL_KNOWN_TOKENS.SOL.symbol,
        recipients: accountIds.map((counterpartyAccountId, index) => ({
          externalId: `batch-integration-recipient-${index}`,
          counterpartyId,
          counterpartyAccountId,
          amount: RECIPIENT_AMOUNT_SOL,
        })),
      }),
    });

    expect(createRes.status).toBe(200);
    const created = transferBatchResponseSchema.parse(await createRes.json()).data;
    expect(created.batch).toMatchObject({
      status: "processing",
      recipientCount: RECIPIENT_COUNT,
      transactionCount: 1,
    });
    expect(created.recipients.map((recipient) => recipient.status)).toEqual(
      Array.from({ length: RECIPIENT_COUNT }, () => "processing")
    );
    expect(created.transfers.map((transfer) => transfer.status)).toEqual(["processing"]);
    const signatures = created.transfers.map((transfer) => {
      if (transfer.signature === null) {
        throw new Error("A processing batch chunk answered without its signature");
      }
      return toSignature(transfer.signature);
    });

    await waitForSignatureCommitment(signatures, "confirmed", 60_000);
    await trackPendingTransfers(env);

    const detailRes = await request(`/v1/payments/transfer-batches/${created.batch.id}`);
    expect(detailRes.status).toBe(200);
    const settled = transferBatchResponseSchema.parse(await detailRes.json()).data;
    expect(settled.batch.status).toBe("confirmed");
    expect(settled.recipients.map((recipient) => recipient.status)).toEqual(
      Array.from({ length: RECIPIENT_COUNT }, () => "confirmed")
    );
    // The chain may finalize the chunk before reconciliation reads it.
    for (const transfer of settled.transfers) {
      expect(ONCHAIN_TRANSFER_SETTLED_STATUSES).toContain(transfer.status);
    }

    const rpc = integrationRpc();
    for (const destinationSigner of destinationSigners) {
      const { value } = await rpc
        .getBalance(destinationSigner.address, { commitment: "confirmed" })
        .send();
      expect(value).toBe(RECIPIENT_AMOUNT_LAMPORTS);
    }

    await waitForSignatureCommitment(signatures, "finalized", 120_000);
    await trackPendingTransfers(env);

    const finalizedRes = await request(`/v1/payments/transfer-batches/${created.batch.id}`);
    expect(finalizedRes.status).toBe(200);
    const finalized = transferBatchResponseSchema.parse(await finalizedRes.json()).data;
    expect(finalized.transfers.map((transfer) => transfer.status)).toEqual(["finalized"]);
    expect(finalized.batch.status).toBe("confirmed");
    expect(finalized.recipients.map((recipient) => recipient.status)).toEqual(
      Array.from({ length: RECIPIENT_COUNT }, () => "confirmed")
    );
  });
});
