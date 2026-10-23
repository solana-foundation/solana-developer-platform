import type { CustodyWalletPurpose } from "@sdp/types/custody";
import { expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { AppError } from "@/lib/errors";
import { SigningService } from "@/services/domain/signing.service";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import { stubOfframpQuoteReads } from "@/test/helpers/offramp-quote";
import {
  createOrgSignerForCustodyWalletMock,
  installPaymentsRouteTestHooks,
  seedCounterparty,
  TEST_API_KEY,
  TEST_CONFIG_ID,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import {
  countTransferRows,
  postTransfer,
  readErrorResponse,
  readTransferResponse,
  readTransferRow,
  seedConnectionOwnedDuplicateProviderWallet,
  seedSelectedApiKeyWallets,
} from "@/test/helpers/payments-transfers";
import { required } from "@/test/helpers/required";

const SPECIALIZED_WALLET_ID = "cwlt_policy_specialized";

const WALLET_PURPOSE_REFUSAL = {
  error: {
    code: "FORBIDDEN",
    message: "Payments can only be sent from a transfer wallet",
    details: { reason: "wallet_purpose" },
  },
  meta: { requestId: expect.any(String) },
};

async function seedSpecializedWallet(purpose: CustodyWalletPurpose | null): Promise<void> {
  await seedTestCustodyRows(env, {
    configs: [],
    wallets: [
      {
        id: SPECIALIZED_WALLET_ID,
        owner: { kind: "config", custodyConfigId: TEST_CONFIG_ID },
        walletId: "wal_policy_specialized",
        publicKey: TEST_SOLANA_ADDRESSES.wallet3,
        label: "Specialized",
        purpose,
        status: "active",
      },
    ],
  });
}

async function postBatch(path: string, idempotencyKey: string): Promise<Response> {
  return app.request(
    path,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        sourceCustodyWalletId: SPECIALIZED_WALLET_ID,
        token: "SOL",
        recipients: [{ counterpartyAccountId: "cpacct_policy_unseeded", amount: "0.1" }],
      }),
    },
    env
  );
}

async function storedIdempotencyKeys(idempotencyKey: string): Promise<number> {
  const row = await getDb(env)
    .prepare("SELECT COUNT(*)::int AS count FROM idempotency_keys WHERE idempotency_key = ?")
    .bind(idempotencyKey)
    .first<{ count: number }>();
  return required(row).count;
}

describe("Payments routes — transfer wallet access", () => {
  installPaymentsRouteTestHooks();
  installClusterRpcStub();
  it("describes an unknown exact source without rejecting SDP Wallet IDs", async () => {
    const response = await postTransfer(
      {
        sourceCustodyWalletId: "cwlt_missing",
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.1",
      },
      {}
    );
    expect(response.status).toBe(404);
    const body = await readErrorResponse(response);
    expect(body.error).toEqual({
      code: "NOT_FOUND",
      message: "Wallet not found. Verify the wallet identifier supplied to this endpoint.",
    });
  });
  it.each<CustodyWalletPurpose | null>([
    "root",
    null,
    "mint_authority",
    "freeze_authority",
    "fee_payer",
    "dvp_settlement_authority",
  ])("refuses a %s wallet as a transfer source before claiming the key", async (purpose) => {
    await seedSpecializedWallet(purpose);
    const idempotencyKey = crypto.randomUUID();

    const response = await postTransfer(
      {
        sourceCustodyWalletId: SPECIALIZED_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.1",
      },
      { idempotencyKey }
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(WALLET_PURPOSE_REFUSAL);
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
    expect(await countTransferRows()).toBe(0);
    expect(await storedIdempotencyKeys(idempotencyKey)).toBe(0);
  });
  it.each(["/v1/payments/transfer-batches", "/v1/payments/transfer-batches/estimate"])(
    "refuses a non-transfer source wallet on %s before reading its recipients",
    async (path) => {
      await seedSpecializedWallet("root");
      const idempotencyKey = crypto.randomUUID();

      const response = await postBatch(path, idempotencyKey);

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(WALLET_PURPOSE_REFUSAL);
      expect(await storedIdempotencyKeys(idempotencyKey)).toBe(0);
    }
  );
  it("refuses a non-transfer source wallet's off-ramp quote before quoting", async () => {
    await seedSpecializedWallet("root");
    const counterpartyId = await seedCounterparty();
    const estimate = stubOfframpQuoteReads();

    const response = await app.request(
      "/v1/payments/ramps/offramp/quote",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "moonpay",
          sourceCustodyWalletId: SPECIALIZED_WALLET_ID,
          counterpartyId,
          assetRail: "usdc.solana",
          cryptoAmount: "25",
          fiatCurrency: "USD",
        }),
      },
      env
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(WALLET_PURPOSE_REFUSAL);
    expect(estimate).not.toHaveBeenCalled();
  });
  it("refuses an out-of-scope wallet for its scope before its purpose", async () => {
    await seedSpecializedWallet("root");
    await seedSelectedApiKeyWallets([TEST_CUSTODY_WALLET_ID]);

    const response = await postBatch("/v1/payments/transfer-batches/estimate", crypto.randomUUID());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "The credential may not sign with this wallet",
        details: { reason: "wallet_out_of_scope" },
      },
      meta: { requestId: expect.any(String) },
    });
  });
  it("admits runtime execution only for new transfers", async () => {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Idempotency-Key": "runtime-admission-transfer-replay",
    };
    const body = JSON.stringify({
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "0.1",
    });
    const first = await postTransfer(JSON.parse(body), {
      idempotencyKey: headers["Idempotency-Key"],
    });
    expect(first.status).toBe(200);
    const admission = vi.spyOn(SigningService.prototype, "admitRuntimeExecution").mockRejectedValue(
      new AppError("CONFLICT", "Custody wallet is unavailable", {
        reason: "runtime_execution_unavailable",
      })
    );
    try {
      const replay = await postTransfer(JSON.parse(body), {
        idempotencyKey: headers["Idempotency-Key"],
      });
      const fresh = await postTransfer(JSON.parse(body), {});
      expect(replay.status).toBe(200);
      expect(fresh.status).toBe(409);
      expect(admission).toHaveBeenCalledOnce();
    } finally {
      admission.mockRestore();
    }
  });
  it("replays a completed transfer after its exact wallet is deactivated", async () => {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Idempotency-Key": "deactivated-wallet-transfer-replay",
    };
    const body = JSON.stringify({
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "0.1",
    });
    const first = await postTransfer(JSON.parse(body), {
      idempotencyKey: headers["Idempotency-Key"],
    });
    expect(first.status).toBe(200);
    const firstBody = await readTransferResponse(first);
    await getDb(env)
      .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE id = ?")
      .bind(TEST_CUSTODY_WALLET_ID)
      .run();
    createOrgSignerForCustodyWalletMock.mockClear();
    const replay = await postTransfer(JSON.parse(body), {
      idempotencyKey: headers["Idempotency-Key"],
    });
    expect(replay.status).toBe(200);
    const replayBody = await readTransferResponse(replay);
    expect(replayBody.data).toEqual(firstBody.data);
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();

    // New work from the deactivated wallet is refused by runtime admission.
    const fresh = await postTransfer(JSON.parse(body), {
      idempotencyKey: "deactivated-wallet-transfer-fresh",
    });
    expect(fresh.status).toBe(409);
    expect(await fresh.json()).toMatchObject({
      error: { details: { reason: "runtime_execution_unavailable" } },
    });
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
  });
  it("executes the exact Config-owned wallet when a Connection duplicates its Provider ID", async () => {
    await seedConnectionOwnedDuplicateProviderWallet();
    const response = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.1",
      },
      {}
    );
    expect(response.status).toBe(200);
    const body = await readTransferResponse(response);
    expect(body.data.transfer).toMatchObject({
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      providerWalletId: TEST_WALLET_ID,
    });
    const row = await readTransferRow(body.data.transfer.id);
    expect(row).toMatchObject({
      custody_wallet_id: TEST_CUSTODY_WALLET_ID,
      wallet_id: TEST_WALLET_ID,
      source_address: TEST_SOLANA_ADDRESSES.wallet1,
    });
    expect(createOrgSignerForCustodyWalletMock).toHaveBeenCalledOnce();
    expect(createOrgSignerForCustodyWalletMock).toHaveBeenCalledWith(
      env,
      TEST_ORG.id,
      TEST_PROJECT.id,
      TEST_CUSTODY_WALLET_ID,
      "payments.transfer"
    );
  });
});
