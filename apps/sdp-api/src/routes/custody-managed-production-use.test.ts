import type { SdpEnvironment } from "@sdp/types/api-keys";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { createSigningService } from "@/services/custody/signing.service";
import { ALL_API_KEY_GRANTS } from "@/test/fixtures/api-keys";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const ORGANIZATION_ID = "org_managed_production_use";
const USER_ID = "usr_managed_production_use";
const PROJECT_IDS = {
  sandbox: "prj_managed_production_use_sandbox",
  production: "prj_managed_production_use_production",
} as const satisfies Record<SdpEnvironment, string>;
const API_KEY = {
  id: "key_managed_production_use_sandbox",
  raw: "sk_test_managed_production_use",
  prefix: "sk_test_mpu",
};
const CONFIG_ID = "cust_managed_production_use_sandbox";
const WALLET_RECORD_ID = "cwlt_managed_production_use_sandbox";
const WALLET_ID = "privy_managed_production_use_sandbox";

const originalPrivy = { appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET };

// Production is BYOK only (ADR 0006), and the schema keeps Managed configs in
// Sandbox projects. These cases keep a Sandbox project's Managed wallet usable.
describe("Managed custody use in a Sandbox project", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedFixture();
  });

  afterEach(async () => {
    env.PRIVY_APP_ID = originalPrivy.appId;
    env.PRIVY_APP_SECRET = originalPrivy.appSecret;
    await clearKVStores(env);
  });

  it("admits a Sandbox project's Managed wallet for runtime execution", async () => {
    await expect(
      createSigningService(env).admitRuntimeExecution(
        ORGANIZATION_ID,
        PROJECT_IDS.sandbox,
        WALLET_RECORD_ID
      )
    ).resolves.toBeUndefined();
  });

  it("answers a Sandbox project's Managed wallet public key", async () => {
    env.PRIVY_APP_ID = "managed-production-use-app";
    env.PRIVY_APP_SECRET = "managed-production-use-secret";

    const response = await app.request(
      `/v1/wallets/public-key?walletId=${WALLET_ID}`,
      { headers: { Authorization: `Bearer ${API_KEY.raw}` } },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { publicKey: TEST_SOLANA_ADDRESSES.wallet1 },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
  });

  it("lists a Sandbox project's Managed wallet as runtime-executable", async () => {
    const response = await app.request(
      "/v1/wallets",
      { headers: { Authorization: `Bearer ${API_KEY.raw}` } },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        wallets: [
          {
            id: WALLET_RECORD_ID,
            custodyConfigId: CONFIG_ID,
            provider: "privy",
            isRuntimeExecutionAllowed: true,
            walletId: WALLET_ID,
            publicKey: TEST_SOLANA_ADDRESSES.wallet1,
            label: null,
            purpose: null,
            status: "active",
            createdAt: expect.any(String),
          },
        ],
      },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
  });
});

async function seedFixture(): Promise<void> {
  const db = getDb(env);
  await db.execute(
    `INSERT INTO organizations (id, name, slug, tier, status)
     VALUES (?, 'Managed production use', 'managed-production-use', 'enterprise', 'active')`,
    [ORGANIZATION_ID]
  );
  await db.execute(
    `INSERT INTO users (id, email, email_verified, status)
     VALUES (?, 'managed-production-use@example.com', 1, 'active')`,
    [USER_ID]
  );
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [],
    ids: PROJECT_IDS,
  });
  const keyHash = await seedProjectApiKey(db, env, {
    key: API_KEY,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_IDS.sandbox,
    createdBy: USER_ID,
    grants: ALL_API_KEY_GRANTS,
  });
  await seedApiKeyRow(env, keyHash, {
    id: API_KEY.id,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_IDS.sandbox,
    grants: ALL_API_KEY_GRANTS,
    environment: "sandbox",
    rateLimitTier: "standard",
    allowedIps: null,
    status: "active",
    expiresAt: null,
  });
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: CONFIG_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_IDS.sandbox,
        provider: "privy",
        configEncrypted: JSON.stringify({ provider: "privy" }),
        status: "active",
      },
    ],
    wallets: [
      {
        id: WALLET_RECORD_ID,
        owner: { kind: "config", custodyConfigId: CONFIG_ID },
        walletId: WALLET_ID,
        publicKey: TEST_SOLANA_ADDRESSES.wallet1,
        label: null,
        purpose: null,
        status: "active",
      },
    ],
  });
}
