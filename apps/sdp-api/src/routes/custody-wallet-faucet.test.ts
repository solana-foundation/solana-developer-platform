import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { HUMAN_SESSION_REQUIRED_MESSAGE } from "@/middleware/human-session";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const ORGANIZATION_ID = "org_custody_wallet_faucet";
const USER_ID = "usr_custody_wallet_faucet";
const SANDBOX_PROJECT_ID = "prj_custody_wallet_faucet_sandbox";
const CUSTODY_CONFIG_ID = "cust_cfg_custody_wallet_faucet";
const CUSTODY_WALLET_ID = "cwlt_custody_wallet_faucet";
const API_KEY = {
  id: "key_custody_wallet_faucet",
  raw: "sk_test_custody_wallet_faucet",
  prefix: "sk_test_cwf",
};

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

async function seedSandboxWalletAndApiKey(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(
        ORGANIZATION_ID,
        "Custody Wallet Faucet Org",
        "custody-wallet-faucet",
        "enterprise",
        "active"
      ),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(USER_ID, "custody-wallet-faucet@example.com", 1, "active"),
  ]);
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [USER_ID],
    ids: { sandbox: SANDBOX_PROJECT_ID, production: `${SANDBOX_PROJECT_ID}_production` },
  });
  await seedProjectApiKey(db, env, {
    key: API_KEY,
    organizationId: ORGANIZATION_ID,
    projectId: SANDBOX_PROJECT_ID,
    createdBy: USER_ID,
    grants: ["wallets.execute"],
  });
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: CUSTODY_CONFIG_ID,
        organizationId: ORGANIZATION_ID,
        projectId: SANDBOX_PROJECT_ID,
        provider: "privy",
        configEncrypted: "test-config",
        status: "active",
      },
    ],
    wallets: [
      {
        id: CUSTODY_WALLET_ID,
        owner: { kind: "config", custodyConfigId: CUSTODY_CONFIG_ID },
        walletId: "privy_wallet_custody_wallet_faucet",
        publicKey: TEST_SOLANA_ADDRESSES.wallet1,
        label: "Faucet wallet",
        purpose: "root",
        status: "active",
      },
    ],
  });
}

describe("POST /internal/dashboard/wallets/:walletId/faucet", () => {
  const rpc = installClusterRpcStub();

  beforeEach(async () => {
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedSandboxWalletAndApiKey();
  });

  it("refuses an API key holding wallets.execute on its own sandbox wallet, before any RPC call", async () => {
    const response = await app.request(
      `/internal/dashboard/wallets/${CUSTODY_WALLET_ID}/faucet`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY.raw}`,
        },
        body: JSON.stringify({}),
      },
      env
    );

    expect(response.status).toBe(403);
    expect(errorSchema.parse(await response.json()).error).toEqual({
      code: "FORBIDDEN",
      message: HUMAN_SESSION_REQUIRED_MESSAGE,
    });
    expect(rpc.calls).toEqual([]);
  });
});
