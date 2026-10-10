import { address, createNoopSigner } from "@solana/kit";
import { expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import { SigningService } from "@/services/domain/signing.service";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import {
  createOrgSignerForCustodyWalletMock,
  installPaymentsRouteTestHooks,
  sendTransactionMock,
  TEST_API_KEY,
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
  seedConfigOwnedDuplicateProviderWallet,
  seedConnectionOwnedDuplicateProviderWallet,
  seedSelectedApiKeyWalletBindings,
} from "@/test/helpers/payments-transfers";

const TEST_DUPLICATE_CUSTODY_WALLET_ID = "cwlt_payments_duplicate_test";

const TEST_ALIAS_AUTHORIZED_CUSTODY_WALLET_ID = "cwlt_payments_alias_authorized_test";

async function seedExactIdProviderAliasWallet(): Promise<void> {
  const configId = "cust_cfg_payments_alias_authorized_test";
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: configId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        provider: "privy",
        configEncrypted: "test-config",
        status: "active",
      },
    ],
    wallets: [
      {
        id: TEST_ALIAS_AUTHORIZED_CUSTODY_WALLET_ID,
        owner: { kind: "config", custodyConfigId: configId },
        walletId: TEST_CUSTODY_WALLET_ID,
        publicKey: TEST_SOLANA_ADDRESSES.wallet1,
        label: "Alias-authorized wallet",
        purpose: "transfer",
        status: "active",
      },
    ],
  });
}

describe("Payments routes — transfer wallet access", () => {
  installPaymentsRouteTestHooks();
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
  it("denies a transfer when the requested exact wallet only matches an authorized Provider ID", async () => {
    await seedExactIdProviderAliasWallet();
    await seedSelectedApiKeyWalletBindings([
      {
        walletId: TEST_CUSTODY_WALLET_ID,
        custodyWalletId: TEST_ALIAS_AUTHORIZED_CUSTODY_WALLET_ID,
        permissions: ["payments:write"],
      },
    ]);
    const response = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.1",
      },
      {}
    );
    expect(response.status).toBe(403);
  });
  it("denies a completed replay when exact access only matches a Provider ID alias", async () => {
    await seedSelectedApiKeyWalletBindings([
      {
        walletId: TEST_WALLET_ID,
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
        permissions: ["payments:write"],
      },
    ]);
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Idempotency-Key": "exact-id-provider-alias-replay",
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
    await seedExactIdProviderAliasWallet();
    await seedSelectedApiKeyWalletBindings([
      {
        walletId: TEST_CUSTODY_WALLET_ID,
        custodyWalletId: TEST_ALIAS_AUTHORIZED_CUSTODY_WALLET_ID,
        permissions: ["payments:write"],
      },
    ]);
    const replay = await postTransfer(JSON.parse(body), {
      idempotencyKey: headers["Idempotency-Key"],
    });
    expect(replay.status).toBe(403);
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
    await seedSelectedApiKeyWalletBindings([
      {
        walletId: TEST_WALLET_ID,
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
        permissions: ["payments:write"],
      },
    ]);
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
  });
  it("denies a completed transfer replay for a duplicate exact wallet outside the key binding", async () => {
    await seedConfigOwnedDuplicateProviderWallet();
    createOrgSignerForCustodyWalletMock.mockResolvedValue(
      createNoopSigner(address(TEST_SOLANA_ADDRESSES.wallet3))
    );
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Idempotency-Key": "duplicate-exact-wallet-transfer-replay",
    };
    const body = JSON.stringify({
      sourceCustodyWalletId: TEST_DUPLICATE_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "0.1",
    });
    const first = await postTransfer(JSON.parse(body), {
      idempotencyKey: headers["Idempotency-Key"],
    });
    expect(first.status).toBe(200);
    await seedSelectedApiKeyWalletBindings([
      {
        walletId: TEST_WALLET_ID,
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
        permissions: ["payments:write"],
      },
    ]);
    createOrgSignerForCustodyWalletMock.mockClear();
    const replay = await postTransfer(JSON.parse(body), {
      idempotencyKey: headers["Idempotency-Key"],
    });
    expect(replay.status).toBe(403);
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
  });
  it("denies a cached selected-wallet binding after its Provider ID becomes ambiguous", async () => {
    await seedSelectedApiKeyWalletBindings([
      {
        walletId: TEST_WALLET_ID,
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
        permissions: ["payments:write"],
      },
    ]);
    await getDb(env).batch([
      getDb(env)
        .prepare(`INSERT INTO custody_configs
             (id, organization_id, project_id, provider, config_encrypted,
              encryption_version, status)
           VALUES ('cust_cfg_cached_binding_duplicate', ?, ?, 'privy', 'test-config',
                   'sdp-custody-encryption-v1', 'active')`)
        .bind(TEST_ORG.id, TEST_PROJECT.id),
      getDb(env)
        .prepare(`INSERT INTO custody_wallets
             (id, custody_config_id, wallet_id, public_key, status)
           VALUES (?, 'cust_cfg_cached_binding_duplicate', ?, ?, 'active')`)
        .bind(TEST_DUPLICATE_CUSTODY_WALLET_ID, TEST_WALLET_ID, TEST_SOLANA_ADDRESSES.wallet3),
    ]);
    const response = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.1",
      },
      {}
    );
    expect(response.status).toBe(403);
    expect(await countTransferRows()).toBe(0);
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
    expect(sendTransactionMock).not.toHaveBeenCalled();
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
      TEST_CUSTODY_WALLET_ID
    );
  });
});
