import { apiTestSupport } from "@sdp/api/test-support";
import { runInClusterScope } from "@sdp/rpc/scope";
import { getSignatureStatuses } from "@sdp/rpc/solana";
import { address, type Commitment, generateKeyPairSigner, type Signature } from "@solana/kit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupIntegrationSuite,
  createFundedIntegrationWallet,
  env,
  initIntegrationSuite,
  RUN_INTEGRATION_TESTS,
  requestWithApiKey,
  resetIntegrationState,
  SOLANA_CONFIGURED,
  TEST_PROJECT,
} from "../helpers/integration";
import { requireIntegrationLaneRpc } from "../helpers/kora-lane";

const { trackPendingTransfers } = apiTestSupport;

function trackTestProjectTransfers(): Promise<void> {
  return runInClusterScope({ projectId: null, environment: TEST_PROJECT.environment }, () =>
    trackPendingTransfers(env)
  );
}

type CounterpartyApiResponse = {
  data: { counterparty: { id: string } };
};

type CounterpartyAccountApiResponse = {
  data: { account: { id: string } };
};

type TransferBatchApiResponse = {
  data: {
    batch: { id: string; status: string; recipientCount: number; transactionCount: number };
    recipients: Array<{ status: string; transferId: string | null; destination: string }>;
    transfers: Array<{ id: string; status: string; signature: string | null }>;
  };
};

const RECIPIENT_COUNT = 4;
const RECIPIENT_AMOUNT_SOL = "0.002";
const RECIPIENT_AMOUNT_LAMPORTS = 2_000_000;

/**
 * Polls surfpool for the given signatures until every one reports at least the
 * target commitment, so reconciliation observes real on-chain statuses.
 * Searches transaction history because finalization can outlive the node's
 * recent-status cache.
 *
 * @param signatures - Transaction signatures returned by the batch create.
 * @param target - Commitment level every signature must reach.
 * @param timeoutMs - How long to keep polling before failing the test.
 */
async function waitForSignatureCommitment(
  signatures: Signature[],
  target: Exclude<Commitment, "processed">,
  timeoutMs: number
): Promise<void> {
  const rpc = requireIntegrationLaneRpc();
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

/**
 * Reads an address's lamport balance from the integration validator.
 *
 * @param accountAddress - Account to read.
 * @returns Balance in lamports.
 */
async function getLamports(accountAddress: string): Promise<number> {
  const { value } = await requireIntegrationLaneRpc()
    .getBalance(address(accountAddress), { commitment: "confirmed" })
    .send();
  return Number(value);
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
    const counterparty = (await counterpartyRes.json()) as CounterpartyApiResponse;
    const counterpartyId = counterparty.data.counterparty.id;

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
      const account = (await accountRes.json()) as CounterpartyAccountApiResponse;
      accountIds.push(account.data.account.id);
    }

    const createRes = await request("/v1/payments/transfer-batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceCustodyWalletId: sourceWallet.id,
        token: "SOL",
        recipients: accountIds.map((counterpartyAccountId, index) => ({
          externalId: `batch-integration-recipient-${index}`,
          counterpartyId,
          counterpartyAccountId,
          amount: RECIPIENT_AMOUNT_SOL,
        })),
        options: { maxRecipientsPerTransaction: 2 },
      }),
    });

    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as TransferBatchApiResponse;
    expect(created.data.batch.status).toBe("processing");
    expect(created.data.batch.recipientCount).toBe(RECIPIENT_COUNT);
    expect(created.data.batch.transactionCount).toBe(2);
    expect(created.data.transfers).toHaveLength(2);
    expect(created.data.recipients.every((r) => r.status === "processing")).toBe(true);

    const signatures = created.data.transfers.map((transfer) => {
      expect(transfer.status).toBe("processing");
      expect(transfer.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
      return transfer.signature as Signature;
    });
    expect(new Set(signatures).size).toBe(2);

    await waitForSignatureCommitment(signatures, "confirmed", 60_000);
    await trackTestProjectTransfers();

    const detailRes = await request(`/v1/payments/transfer-batches/${created.data.batch.id}`);
    expect(detailRes.status).toBe(200);
    const settled = (await detailRes.json()) as TransferBatchApiResponse;
    expect(settled.data.batch.status).toBe("confirmed");
    expect(settled.data.recipients).toHaveLength(RECIPIENT_COUNT);
    expect(settled.data.recipients.every((r) => r.status === "confirmed")).toBe(true);
    expect(
      settled.data.transfers.every(
        (transfer) => transfer.status === "confirmed" || transfer.status === "finalized"
      )
    ).toBe(true);

    for (const destinationSigner of destinationSigners) {
      expect(await getLamports(destinationSigner.address)).toBe(RECIPIENT_AMOUNT_LAMPORTS);
    }

    await waitForSignatureCommitment(signatures, "finalized", 120_000);
    await trackTestProjectTransfers();

    const finalizedRes = await request(`/v1/payments/transfer-batches/${created.data.batch.id}`);
    expect(finalizedRes.status).toBe(200);
    const finalized = (await finalizedRes.json()) as TransferBatchApiResponse;
    expect(finalized.data.transfers.every((transfer) => transfer.status === "finalized")).toBe(
      true
    );
    expect(finalized.data.batch.status).toBe("confirmed");
    expect(finalized.data.recipients.every((r) => r.status === "confirmed")).toBe(true);
  });
});
