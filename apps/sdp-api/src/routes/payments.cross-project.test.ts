import type { PolicyRule } from "@sdp/types";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { seedTestPrivyConnection } from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import {
  installPaymentsRouteTestHooks,
  TEST_API_KEY,
  TEST_ORG,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import { countTransferRows, postTransfer } from "@/test/helpers/payments-transfers";

const OTHER_PROJECT_ID = `${TEST_PROJECT.id}_production`;
const OTHER_PROJECT_CONNECTION_ID = "cconn_payments_other_project";
const OTHER_PROJECT_WALLET = {
  id: "cwlt_payments_other_project",
  walletId: "wal_payments_other_project",
};
const DENY_ALL_RULES: PolicyRule[] = [{ id: "deny-everything", kind: "always", action: "deny" }];
const WALLET_NOT_FOUND_BODY = {
  error: {
    code: "NOT_FOUND",
    message: "Wallet not found. Verify the wallet identifier supplied to this endpoint.",
  },
  meta: { requestId: expect.any(String) },
};

function readOtherProjectState() {
  return getDb(env).queryMany(
    `SELECT w.*, c.status AS connection_status
       FROM custody_wallets w
       JOIN custody_connections c ON c.id = w.custody_connection_id
      WHERE c.id = ?`,
    [OTHER_PROJECT_CONNECTION_ID]
  );
}

function requestWalletPolicy(walletId: string, init: { method: string; body?: unknown }) {
  return app.request(
    `/v1/payments/wallets/${walletId}/policies`,
    {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    env
  );
}

describe("Payments routes — custody wallets of another project", () => {
  installPaymentsRouteTestHooks();

  beforeEach(async () => {
    await getDb(env).transaction((tx) =>
      seedTestPrivyConnection(tx, {
        organizationId: TEST_ORG.id,
        projectId: OTHER_PROJECT_ID,
        connectionId: OTHER_PROJECT_CONNECTION_ID,
        credentialId: "pcred_payments_other_project",
        createdBy: TEST_USER.id,
        stored: { storageBackend: "encrypted_db", encryptedSecretPayload: "not-read" },
        providerAccountFingerprint: "sha256:payments-other-project",
        lastCheckStatus: "success",
        wallets: [
          {
            id: OTHER_PROJECT_WALLET.id,
            walletId: OTHER_PROJECT_WALLET.walletId,
            publicKey: TEST_SOLANA_ADDRESSES.wallet3,
            label: "Other project wallet",
            purpose: "transfer",
            status: "active",
          },
        ],
        defaultCustodyWalletId: OTHER_PROJECT_WALLET.id,
      })
    );
  });

  it("does not retain another project's wallet as an idempotent transfer source", async () => {
    const before = await readOtherProjectState();

    const response = await postTransfer(
      {
        sourceCustodyWalletId: OTHER_PROJECT_WALLET.id,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.001",
      },
      { idempotencyKey: "payments-other-project-retained" }
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(WALLET_NOT_FOUND_BODY);
    expect(await countTransferRows()).toBe(0);
    expect(await readOtherProjectState()).toEqual(before);
  });

  it("reads and writes wallet policies only for the project's own wallets", async () => {
    const before = await readOtherProjectState();

    expect((await requestWalletPolicy(TEST_WALLET_ID, { method: "GET" })).status).toBe(200);

    const read = await requestWalletPolicy(OTHER_PROJECT_WALLET.walletId, { method: "GET" });
    expect(read.status).toBe(404);
    expect(await read.json()).toEqual(WALLET_NOT_FOUND_BODY);

    const write = await requestWalletPolicy(OTHER_PROJECT_WALLET.walletId, {
      method: "PUT",
      body: { defaultAction: "deny", rules: DENY_ALL_RULES },
    });
    expect(write.status).toBe(404);
    expect(await write.json()).toEqual(WALLET_NOT_FOUND_BODY);

    expect(
      await getDb(env).queryMany(
        "SELECT id FROM wallet_control_profiles WHERE custody_wallet_id = ?",
        [OTHER_PROJECT_WALLET.id]
      )
    ).toEqual([]);
    expect(await readOtherProjectState()).toEqual(before);
  });
});
