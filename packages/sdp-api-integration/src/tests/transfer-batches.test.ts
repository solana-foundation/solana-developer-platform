import { apiTestSupport } from "@sdp/api/test-support";
import { createRpc, getSignatureStatuses } from "@sdp/rpc/solana";
import { generateKeyPairSigner, type Signature } from "@solana/kit";
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
} from "../helpers/integration";

const { trackPendingTransfers } = apiTestSupport;

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
 * Polls surfpool for the given signatures until every one reports at least
 * confirmed commitment, so reconciliation observes real on-chain statuses.
 *
 * @param signatures - Transaction signatures returned by the batch create.
 * @param timeoutMs - How long to keep polling before failing the test.
 */
async function waitForSignaturesConfirmed(
  signatures: Signature[],
  timeoutMs: number
): Promise<void> {
  const rpc = createRpc(env);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const statuses = await getSignatureStatuses(rpc, signatures);
    const allConfirmed = statuses.every(
      (status) =>
        status !== null &&
        status.err === null &&
        (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")
    );
    if (allConfirmed) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `Timed out waiting for batch signatures to confirm on-chain after ${timeoutMs}ms`
  );
}

/**
 * Reads an address's lamport balance from the integration validator.
 *
 * @param address - Account to read.
 * @returns Balance in lamports.
 */
async function getLamports(address: string): Promise<number> {
  const response = await fetch(env.SOLANA_RPC_URL as string, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getBalance",
      params: [address, { commitment: "confirmed" }],
    }),
  });
  const payload = (await response.json()) as { result: { value: number } };
  return payload.result.value;
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

  it("executes a SOL transfer batch on-chain and reconciles it to confirmed", {
    timeout: 240_000,
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
        email: "batch-integration@example.com",
        identity: {
          firstName: "Batch",
          lastName: "Integration",
          dateOfBirth: "1990-01-01",
          phone: "+14155550100",
          address: {
            line1: "1 Integration Way",
            city: "San Francisco",
            postalCode: "94105",
            countryCode: "US",
            subdivisionCode: "CA",
          },
        },
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
        source: sourceWallet.walletId,
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

    await waitForSignaturesConfirmed(signatures, 60_000);
    await trackPendingTransfers(env);

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
  });
});
