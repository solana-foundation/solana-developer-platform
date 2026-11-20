import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { HUMAN_SESSION_REQUIRED_MESSAGE } from "@/middleware/human-session";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { clerkAdminHeaders } from "@/test/helpers/clerk-member";
import {
  installClusterRpcResponder,
  type StubSignatureStatus,
  signatureStatusesReply,
} from "@/test/helpers/cluster-rpc";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import { syntheticSignature } from "@/test/helpers/parsed-transactions";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const ORGANIZATION_ID = "org_custody_wallet_faucet";
const USER_ID = "usr_custody_wallet_faucet";
const SANDBOX_PROJECT_ID = "prj_custody_wallet_faucet_sandbox";
const PRODUCTION_PROJECT_ID = `${SANDBOX_PROJECT_ID}_production`;
const CUSTODY_CONFIG_ID = "cust_cfg_custody_wallet_faucet";
const CUSTODY_WALLET_ID = "cwlt_custody_wallet_faucet";
const OTHER_PROJECT_WALLET_ID = "cwlt_custody_wallet_faucet_other_project";
const AIRDROP_SIGNATURE = syntheticSignature(1);
const CONFIRMED_STATUS = {
  slot: 101,
  confirmations: 1,
  confirmationStatus: "confirmed",
  err: null,
} as const satisfies StubSignatureStatus;
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
    ids: { sandbox: SANDBOX_PROJECT_ID, production: PRODUCTION_PROJECT_ID },
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
      {
        id: `${CUSTODY_CONFIG_ID}_other_project`,
        organizationId: ORGANIZATION_ID,
        projectId: PRODUCTION_PROJECT_ID,
        provider: "privy",
        configEncrypted: "test-config",
        status: "active",
      },
    ],
    wallets: [
      {
        id: OTHER_PROJECT_WALLET_ID,
        owner: { kind: "config", custodyConfigId: `${CUSTODY_CONFIG_ID}_other_project` },
        walletId: "privy_wallet_custody_wallet_faucet_other_project",
        publicKey: TEST_SOLANA_ADDRESSES.wallet2,
        label: "Other project wallet",
        purpose: "root",
        status: "active",
      },
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
  const rpc = installClusterRpcResponder();

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

  async function requestFaucetAsMember(walletId: string): Promise<Response> {
    const headers = await clerkAdminHeaders(env, getDb(env), {
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      projectId: SANDBOX_PROJECT_ID,
    });
    return app.request(
      `/internal/dashboard/wallets/${walletId}/faucet`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      env
    );
  }

  function airdropRequests() {
    return rpc.requests
      .filter((request) => request.method === "requestAirdrop")
      .map((request) => ({ cluster: request.cluster, recipient: request.params[0] }));
  }

  it("answers 404 for another project's wallet without requesting an airdrop", async () => {
    const response = await requestFaucetAsMember(OTHER_PROJECT_WALLET_ID);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Wallet not found" },
      meta: { requestId: expect.any(String) },
    });
    expect(airdropRequests()).toEqual([]);
  });

  it("airdrops devnet SOL to the named wallet's own address", async () => {
    rpc.answer("requestAirdrop", AIRDROP_SIGNATURE);
    rpc.respond("getSignatureStatuses", () => signatureStatusesReply([CONFIRMED_STATUS]));

    const response = await requestFaucetAsMember(CUSTODY_WALLET_ID);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { signature: AIRDROP_SIGNATURE, status: "confirmed", lamports: "1000000000" },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
    expect(airdropRequests()).toEqual([
      { cluster: "devnet", recipient: TEST_SOLANA_ADDRESSES.wallet1 },
    ]);
  });
});
