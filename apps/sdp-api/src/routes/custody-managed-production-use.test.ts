import type { SdpEnvironment } from "@sdp/types/api-keys";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { createSigningService } from "@/services/domain/signing.service";
import { ALL_API_KEY_GRANTS } from "@/test/fixtures/api-keys";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { seedProjectApiKey, type TestApiKeyMaterial } from "@/test/helpers/api-keys";
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
const API_KEYS = {
  sandbox: {
    id: "key_managed_production_use_sandbox",
    raw: "sk_test_managed_production_use",
    prefix: "sk_test_mpu",
  },
  production: {
    id: "key_managed_production_use_production",
    raw: "sk_live_managed_production_use",
    prefix: "sk_live_mpu",
  },
} as const satisfies Record<SdpEnvironment, TestApiKeyMaterial>;
const WALLET_RECORD_IDS = {
  sandbox: "cwlt_managed_production_use_sandbox",
  production: "cwlt_managed_production_use_production",
} as const satisfies Record<SdpEnvironment, string>;
const PUBLIC_KEYS = {
  sandbox: TEST_SOLANA_ADDRESSES.wallet1,
  production: TEST_SOLANA_ADDRESSES.wallet2,
} as const satisfies Record<SdpEnvironment, string>;

const originalPrivy = { appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET };

// Production is BYOK only (ADR 0006). Setup refuses a Managed config there, but
// a config that predates the rule must still be refused wherever it is used,
// and the wallet list must report what that gate decides.
describe("Managed custody use by project environment", () => {
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

  it("refuses runtime execution of a Managed wallet in a Production project and admits it in a Sandbox project", async () => {
    const signing = createSigningService(env);

    await expect(
      signing.admitRuntimeExecution(
        ORGANIZATION_ID,
        PROJECT_IDS.production,
        WALLET_RECORD_IDS.production
      )
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Privy Managed custody is not allowed in a production project.",
      details: { reason: "custody_mode_not_allowed" },
    });
    await expect(
      signing.admitRuntimeExecution(ORGANIZATION_ID, PROJECT_IDS.sandbox, WALLET_RECORD_IDS.sandbox)
    ).resolves.toBeUndefined();
  });

  it("answers a Sandbox project's Managed wallet public key", async () => {
    env.PRIVY_APP_ID = "managed-production-use-app";
    env.PRIVY_APP_SECRET = "managed-production-use-secret";

    const response = await app.request(
      "/v1/wallets/public-key?walletId=privy_managed_production_use_sandbox",
      { headers: { Authorization: `Bearer ${API_KEYS.sandbox.raw}` } },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { publicKey: TEST_SOLANA_ADDRESSES.wallet1 },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
  });

  it.each([
    ["production", false],
    ["sandbox", true],
  ] as const)(
    "lists a %s project's Managed wallet with isRuntimeExecutionAllowed %s",
    async (environment, isRuntimeExecutionAllowed) => {
      const response = await app.request(
        "/v1/wallets",
        { headers: { Authorization: `Bearer ${API_KEYS[environment].raw}` } },
        env
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        data: {
          wallets: [
            {
              id: WALLET_RECORD_IDS[environment],
              custodyConfigId: `cust_managed_production_use_${environment}`,
              provider: "privy",
              isRuntimeExecutionAllowed,
              walletId: `privy_managed_production_use_${environment}`,
              publicKey: PUBLIC_KEYS[environment],
              label: null,
              purpose: null,
              status: "active",
              createdAt: expect.any(String),
            },
          ],
        },
        meta: { requestId: expect.any(String), timestamp: expect.any(String) },
      });
    }
  );
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
  for (const environment of ["sandbox", "production"] as const) {
    const keyHash = await seedProjectApiKey(db, env, {
      key: API_KEYS[environment],
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_IDS[environment],
      createdBy: USER_ID,
      grants: ALL_API_KEY_GRANTS,
    });
    await seedApiKeyRow(env, keyHash, {
      id: API_KEYS[environment].id,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_IDS[environment],
      grants: ALL_API_KEY_GRANTS,
      environment,
      rateLimitTier: "standard",
      allowedIps: null,
      status: "active",
      expiresAt: null,
    });
    const configId = `cust_managed_production_use_${environment}`;
    await seedTestCustodyRows(env, {
      configs: [
        {
          id: configId,
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_IDS[environment],
          provider: "privy",
          configEncrypted: JSON.stringify({ provider: "privy" }),
          status: "active",
        },
      ],
      wallets: [
        {
          id: WALLET_RECORD_IDS[environment],
          owner: { kind: "config", custodyConfigId: configId },
          walletId: `privy_managed_production_use_${environment}`,
          publicKey: PUBLIC_KEYS[environment],
          label: null,
          purpose: null,
          status: "active",
        },
      ],
    });
  }
}
