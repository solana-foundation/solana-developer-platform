import { expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { AppError } from "@/lib/errors";
import { SigningService } from "@/services/domain/signing.service";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import {
  createOrgSignerForCustodyWalletMock,
  installPaymentsRouteTestHooks,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import {
  postTransfer,
  readErrorResponse,
  readTransferResponse,
  readTransferRow,
  seedConnectionOwnedDuplicateProviderWallet,
} from "@/test/helpers/payments-transfers";

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
