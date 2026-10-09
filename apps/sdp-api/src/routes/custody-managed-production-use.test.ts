import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import * as custodyProvisioning from "@/services/custody/provisioning";
import { createSigningService } from "@/services/domain/signing.service";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const provisionPrivyWalletMock = vi.spyOn(custodyProvisioning, "provisionPrivyWallet");

const ORGANIZATION_ID = "org_managed_production_use";
const USER_ID = "usr_managed_production_use";
const PROJECT_ID = "prj_managed_production_use_sandbox";
const API_KEY = {
  id: "key_managed_production_use_sandbox",
  raw: "sk_test_managed_production_use",
  prefix: "sk_test_mpu",
};
const CACHED_API_KEY: CachedApiKey = {
  id: API_KEY.id,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  role: "api_admin",
  permissions: ["*"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};
const CONFIG_ID = "cust_managed_production_use_sandbox";
const WALLET_RECORD_ID = "cwlt_managed_production_use_sandbox";
const WALLET_ID = "privy_managed_production_use_sandbox";
const PUBLIC_KEY = "11111111111111111111111111111111";
const CREATED_PUBLIC_KEY = "Vote111111111111111111111111111111111111111";

const original = {
  encryptionKey: env.CUSTODY_ENCRYPTION_KEY,
  privyAppId: env.PRIVY_APP_ID,
  privyAppSecret: env.PRIVY_APP_SECRET,
};

describe("Managed custody use by project environment", () => {
  beforeEach(async () => {
    provisionPrivyWalletMock.mockReset();
    env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 29).toString("base64");
    env.PRIVY_APP_ID = "managed-production-use-app";
    env.PRIVY_APP_SECRET = "managed-production-use-secret";
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedFixture();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    env.CUSTODY_ENCRYPTION_KEY = original.encryptionKey;
    env.PRIVY_APP_ID = original.privyAppId;
    env.PRIVY_APP_SECRET = original.privyAppSecret;
    await clearKVStores(env);
  });

  it("creates, admits and reads Managed wallets in a Sandbox project", async () => {
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: "managed_production_use_created",
      address: CREATED_PUBLIC_KEY,
    });

    const created = await app.request(
      "/v1/wallets",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY.raw}`, "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "privy" }),
      },
      env
    );

    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      data: {
        wallet: {
          id: expect.any(String),
          custodyConfigId: CONFIG_ID,
          isRuntimeExecutionAllowed: true,
          walletId: "privy_managed_production_use_created",
          publicKey: CREATED_PUBLIC_KEY,
          label: null,
          purpose: null,
          status: "active",
          createdAt: expect.any(String),
        },
      },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
    expect(provisionPrivyWalletMock).toHaveBeenCalledOnce();
    await expect(
      createSigningService(env).admitRuntimeExecution(ORGANIZATION_ID, PROJECT_ID, WALLET_RECORD_ID)
    ).resolves.toBeUndefined();
    const publicKey = await app.request(
      `/v1/wallets/public-key?walletId=${WALLET_ID}`,
      { headers: { Authorization: `Bearer ${API_KEY.raw}` } },
      env
    );
    expect(publicKey.status).toBe(200);
    expect(await publicKey.json()).toEqual({
      data: { publicKey: PUBLIC_KEY },
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
    ids: { sandbox: PROJECT_ID, production: "prj_managed_production_use_production" },
  });
  const keyHash = await seedProjectApiKey(db, env, {
    key: API_KEY,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    createdBy: USER_ID,
    role: "api_admin",
    permissions: ["*"],
  });
  await seedCachedApiKey(env, keyHash, CACHED_API_KEY);
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: CONFIG_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
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
        publicKey: PUBLIC_KEY,
        label: null,
        purpose: null,
        status: "active",
      },
    ],
  });
}
