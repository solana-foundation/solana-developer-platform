import { TEST_SOLANA_ADDRESSES } from "@sdp/api-test/fixtures/tokens";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  KORA_CONFIGURED,
  RUN_INTEGRATION_TESTS,
  SOLANA_CONFIGURED,
  TEST_ORG,
  TEST_PROJECT,
  cleanupIntegrationSuite,
  env,
  initIntegrationSuite,
  requestWithApiKey,
  resetIntegrationState,
} from "../helpers/integration";

const TEST_CONFIG_ID = "cust_cfg_payments_integration";
const TEST_CUSTODY_WALLET_ID = "cwlt_payments_integration";
const TEST_WALLET_ID = "wal_payments_integration";

async function seedPaymentsWalletScope(): Promise<void> {
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare("DELETE FROM payment_wallet_policies"),
    env.DB.prepare("DELETE FROM payment_transfers"),
    env.DB.prepare(
      `INSERT INTO custody_configs
         (id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      TEST_CONFIG_ID,
      TEST_ORG.id,
      TEST_PROJECT.id,
      "local",
      "test-config",
      "sdp-custody-encryption-v1",
      TEST_WALLET_ID,
      "active",
      now,
      now
    ),
    env.DB.prepare(
      `INSERT INTO custody_wallets
         (id, custody_config_id, wallet_id, public_key, label, purpose, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      TEST_CUSTODY_WALLET_ID,
      TEST_CONFIG_ID,
      TEST_WALLET_ID,
      TEST_SOLANA_ADDRESSES.wallet1,
      "Payments Integration Wallet",
      "transfer",
      "active",
      now
    ),
  ]);
}

describe.skipIf(!KORA_CONFIGURED || !SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)(
  "Payments integration (devnet)",
  () => {
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
      await seedPaymentsWalletScope();
    });

    it("lists transfers against real devnet RPC", async () => {
      const res = await request(
        `/v1/payments/transfers?wallet=${TEST_WALLET_ID}&page=1&pageSize=5`,
        {
          method: "GET",
        }
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: unknown[];
        meta: { page: number; pageSize: number; total: number; hasMore: boolean };
      };

      expect(Array.isArray(body.data)).toBe(true);
      expect(body.meta.page).toBe(1);
      expect(body.meta.pageSize).toBe(5);
      expect(typeof body.meta.total).toBe("number");
      expect(typeof body.meta.hasMore).toBe("boolean");
    });

    it("returns NOT_FOUND for a devnet signature outside authenticated wallet scope", async () => {
      const rpcUrl = env.SOLANA_RPC_URL;
      expect(rpcUrl).toBeDefined();

      const rpcRes = await fetch(String(rpcUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "sig_fetch",
          method: ["get", "Signatures", "ForAddress"].join(""),
          params: [
            "1".repeat(32),
            {
              commitment: "confirmed",
              limit: 1,
            },
          ],
        }),
      });

      expect(rpcRes.ok).toBe(true);
      const rpcJson = (await rpcRes.json()) as {
        result?: Array<{ signature?: string }>;
      };
      const signature = rpcJson.result?.[0]?.signature;
      expect(signature).toBeTruthy();

      const res = await request(`/v1/payments/transfers/${String(signature)}`, {
        method: "GET",
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_FOUND");
    });
  }
);
