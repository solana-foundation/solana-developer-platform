import type { MovementId } from "@sdp/types/movements";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { createRecurringPayment } from "@/services/payments/recurring-payments/create";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { inSandboxScope, installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import {
  createOrgSignerForCustodyWalletMock,
  DEVNET_USDC_MINT,
  installPaymentsRouteTestHooks,
  seedCounterparty,
  TEST_API_KEY,
  TEST_ORG,
  TEST_PROJECT,
  TEST_USER,
} from "@/test/helpers/payments-routes";
import {
  countTransferRows,
  postTransfer,
  readErrorResponse,
} from "@/test/helpers/payments-transfers";
import { required } from "@/test/helpers/required";

/**
 * PRO-2435 D1: a Fireblocks wallet the organization connected (BYOK) can wait
 * for a human approval, which every path but a direct payment cannot hold
 * for. Each such path refuses the wallet in its authorize step: nothing is
 * written, no Idempotency-Key is claimed, and no signer is built.
 */

const FIREBLOCKS_WALLET_ID = "cwlt_payments_fireblocks_gate";
const CONNECTION_ID = "cconn_payments_fireblocks_gate";

async function seedFireblocksByokWallet(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(`INSERT INTO provider_credentials (
      id, organization_id, project_id, provider, label, scope, source, storage_backend,
      encrypted_secret_payload, status, credential_version, created_by
    ) VALUES ('pcred_payments_fireblocks_gate', ?, ?, 'fireblocks', 'Fireblocks', 'project',
      'stored', 'encrypted_db', 'not-read', 'active', 1, ?)`)
      .bind(TEST_ORG.id, TEST_PROJECT.id, TEST_USER.id),
    db
      .prepare(`INSERT INTO custody_connections (
      id, organization_id, project_id, provider, scope, provider_credential_id,
      provider_credential_scope_key, status, created_by
    ) VALUES (?, ?, ?, 'fireblocks', 'project', 'pcred_payments_fireblocks_gate', ?, 'pending', ?)`)
      .bind(CONNECTION_ID, TEST_ORG.id, TEST_PROJECT.id, TEST_PROJECT.id, TEST_USER.id),
    db
      .prepare(`INSERT INTO custody_wallets
      (id, custody_connection_id, wallet_id, public_key, label, purpose, status)
      VALUES (?, ?, '0', ?, 'Fireblocks vault', 'transfer', 'active')`)
      .bind(FIREBLOCKS_WALLET_ID, CONNECTION_ID, TEST_SOLANA_ADDRESSES.wallet3),
    db
      .prepare(`UPDATE custody_connections SET default_custody_wallet_id = ?,
      provider_account_fingerprint = 'sha256:payments-fireblocks-gate', status = 'active',
      last_check_status = 'success', last_check_at = sdp_iso_now(),
      activated_at = sdp_iso_now(), updated_at = sdp_iso_now()
      WHERE id = ?`)
      .bind(FIREBLOCKS_WALLET_ID, CONNECTION_ID),
  ]);
}

async function countRows(table: string): Promise<number> {
  const row = await getDb(env)
    .prepare(`SELECT COUNT(*)::int AS count FROM ${table}`)
    .first<{ count: number }>();
  return required(row).count;
}

async function storedIdempotencyKeys(idempotencyKey: string): Promise<number> {
  const row = await getDb(env)
    .prepare("SELECT COUNT(*)::int AS count FROM idempotency_keys WHERE idempotency_key = ?")
    .bind(idempotencyKey)
    .first<{ count: number }>();
  return required(row).count;
}

function postJson(path: string, body: Record<string, unknown>, idempotencyKey: string) {
  return app.request(
    path,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    },
    env
  );
}

function refusal(movement: MovementId) {
  return {
    code: "CUSTODY_PROVIDER_UNSUPPORTED_OPERATION",
    message:
      "Fireblocks wallets your organization connected cannot start this operation yet. They send direct payments only for now. Choose a wallet on another custody provider.",
    details: { provider: "fireblocks", mode: "byok", movement },
  };
}

describe("Payments routes: Fireblocks BYOK sources outside direct payments (PRO-2435 D1)", () => {
  installPaymentsRouteTestHooks();
  installClusterRpcStub();

  it("refuses a Fireblocks BYOK wallet funding an off-ramp deposit before the key is claimed", async () => {
    await seedFireblocksByokWallet();
    const idempotencyKey = crypto.randomUUID();
    const transfersBefore = await countTransferRows();

    const response = await postTransfer(
      {
        sourceCustodyWalletId: FIREBLOCKS_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.1",
        transferId: "transfer_unseeded_offramp_deposit",
      },
      { idempotencyKey }
    );

    expect(response.status).toBe(400);
    expect((await readErrorResponse(response)).error).toEqual(refusal("ramps.offramp_quote"));
    expect(await countTransferRows()).toBe(transfersBefore);
    expect(await storedIdempotencyKeys(idempotencyKey)).toBe(0);
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
  });

  it("does not refuse a direct payment from the same wallet on this rule", async () => {
    await seedFireblocksByokWallet();

    const response = await postTransfer(
      {
        sourceCustodyWalletId: FIREBLOCKS_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.1",
      },
      { idempotencyKey: crypto.randomUUID() }
    );

    // The proposer runs next and may refuse for its own reasons (the test
    // credential is unreadable); the per-path table never does.
    if (response.status !== 200) {
      const body = await readErrorResponse(response);
      expect(body.error.code).not.toBe("CUSTODY_PROVIDER_UNSUPPORTED_OPERATION");
    }
  });

  it("refuses a Fireblocks BYOK source for a transfer batch, writing no batch or key", async () => {
    await seedFireblocksByokWallet();
    const idempotencyKey = crypto.randomUUID();

    const response = await postJson(
      "/v1/payments/transfer-batches/execute",
      {
        externalId: "fireblocks-gate-run",
        sourceCustodyWalletId: FIREBLOCKS_WALLET_ID,
        token: "SOL",
        recipients: [{ counterpartyAccountId: "cpacct_fireblocks_gate_unseeded", amount: "0.1" }],
      },
      idempotencyKey
    );

    expect(response.status).toBe(400);
    expect((await readErrorResponse(response)).error).toEqual(refusal("payments.transfer_batch"));
    expect(await countRows("payment_transfer_batches")).toBe(0);
    expect(await storedIdempotencyKeys(idempotencyKey)).toBe(0);
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
  });

  it("refuses a Fireblocks BYOK source for a recurring payment, writing no schedule or key", async () => {
    await seedFireblocksByokWallet();
    const idempotencyKey = crypto.randomUUID();

    const response = await postJson(
      "/v1/payments/recurring-payments",
      {
        sourceCustodyWalletId: FIREBLOCKS_WALLET_ID,
        counterpartyId: "cp_fireblocks_gate_unseeded",
        counterpartyAccountId: "cpacct_fireblocks_gate_unseeded",
        token: "SOL",
        amount: "0.1",
        periodHours: 24,
      },
      idempotencyKey
    );

    expect(response.status).toBe(400);
    expect((await readErrorResponse(response)).error).toEqual(refusal("recurring.activate"));
    expect(await countRows("payment_recurring_payments")).toBe(0);
    expect(await storedIdempotencyKeys(idempotencyKey)).toBe(0);
  });

  it("refuses activating a schedule pinned to a Fireblocks BYOK wallet before the key is claimed", async () => {
    await seedFireblocksByokWallet();
    const counterpartyId = await seedCounterparty();
    const counterpartyAccountId = "cpacct_fireblocks_gate_pinned";
    const now = new Date().toISOString();
    await getDb(env)
      .prepare(
        `INSERT INTO counterparty_accounts (
           id, organization_id, project_id, counterparty_id, account_kind, label,
           details, provider_account_data, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'crypto_wallet', 'Pinned schedule wallet', ?, '{}', 'active', ?, ?)`
      )
      .bind(
        counterpartyAccountId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        counterpartyId,
        JSON.stringify({ network: "solana", address: TEST_SOLANA_ADDRESSES.wallet2 }),
        now,
        now
      )
      .run();
    // A schedule created before the gate: written by the service, not the route.
    const pinned = await inSandboxScope(() =>
      createRecurringPayment({
        env,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        sourceWallet: {
          id: FIREBLOCKS_WALLET_ID,
          walletId: "0",
          publicKey: TEST_SOLANA_ADDRESSES.wallet3,
          label: "Fireblocks vault",
          purpose: "transfer",
          status: "active",
          createdAt: now,
          custodyConnectionId: CONNECTION_ID,
        },
        counterpartyId,
        counterpartyAccountId,
        token: DEVNET_USDC_MINT,
        amount: "1",
        periodHours: 24,
        firstCollectionAt: null,
        metadataUri: null,
        idempotency: null,
        createdBy: TEST_USER.id,
      })
    );
    const idempotencyKey = crypto.randomUUID();

    const response = await postJson(
      `/v1/payments/recurring-payments/${pinned.id}/activate`,
      {},
      idempotencyKey
    );

    expect(response.status).toBe(400);
    expect((await readErrorResponse(response)).error).toEqual(refusal("recurring.activate"));
    expect(await countRows("payment_recurring_payment_activation_attempts")).toBe(0);
    expect(await storedIdempotencyKeys(idempotencyKey)).toBe(0);
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
  });

  it("refuses a Fireblocks BYOK source for an off-ramp quote before the provider is asked", async () => {
    await seedFireblocksByokWallet();
    const counterpartyId = await seedCounterparty();
    const transfersBefore = await countTransferRows();

    const response = await app.request(
      "/v1/payments/ramps/offramp/start",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "moonpay",
          sourceCustodyWalletId: FIREBLOCKS_WALLET_ID,
          counterpartyId,
          assetRail: "usdc.solana",
          cryptoAmount: "25",
          fiatCurrency: "USD",
        }),
      },
      env
    );

    expect(response.status).toBe(400);
    expect((await readErrorResponse(response)).error).toEqual(refusal("ramps.offramp_quote"));
    expect(await countTransferRows()).toBe(transfersBefore);
  });
});
