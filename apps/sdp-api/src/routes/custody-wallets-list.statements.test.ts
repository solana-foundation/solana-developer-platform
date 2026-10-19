import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import app from "@/index";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { recordStatements } from "@/test/helpers/statement-log";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

/**
 * `GET /v1/wallets` reads the organization once. Authentication already read
 * the organization row (status, settings, tier), so the wallet projection's
 * provider entitlements come from that read instead of a second statement.
 */

const ORGANIZATION_ID = "org_wallets_list_statements";
const PROJECT_ID = "prj_wallets_list_statements";
const USER_ID = "usr_wallets_list_statements";
const CONFIG_ID = "cust_cfg_wallets_list_statements";
const API_KEY = {
  id: "key_wallets_list_statements",
  raw: "sk_test_wallets_list_statements",
  prefix: "sk_test_wls",
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

const originalEncryptionKey = env.CUSTODY_ENCRYPTION_KEY;
const originalPrivyAppId = env.PRIVY_APP_ID;
const originalPrivyAppSecret = env.PRIVY_APP_SECRET;

async function seedFixture(): Promise<void> {
  const keyHash = await hashString(API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, CACHED_API_KEY);
  await getDb(env).batch([
    getDb(env)
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'enterprise', 'active')"
      )
      .bind(ORGANIZATION_ID, "Wallets list", "wallets-list-statements"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER_ID, "wallets-list-statements@example.com"),
  ]);
  await seedDefaultProjects(getDb(env), {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [],
    ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
  });
  await getDb(env).execute(
    `INSERT INTO api_keys (
       id, organization_id, project_id, created_by, name, key_prefix,
       key_hash, role, permissions, status
     ) VALUES (?, ?, ?, ?, 'Test', ?, ?, 'api_admin', '["*"]', 'active')`,
    [API_KEY.id, ORGANIZATION_ID, PROJECT_ID, USER_ID, API_KEY.prefix, keyHash]
  );
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
        id: "cwlt_wallets_list_statements",
        owner: { kind: "config", custodyConfigId: CONFIG_ID },
        walletId: "privy_wallets_list_statements",
        publicKey: "11111111111111111111111111111111",
        label: "Managed",
        purpose: "root",
        status: "active",
      },
    ],
  });
}

async function listWallets(): Promise<Response> {
  return await app.request(
    "/v1/wallets",
    { method: "GET", headers: { Authorization: `Bearer ${API_KEY.raw}` } },
    env
  );
}

const walletsBodySchema = z.object({
  data: z.object({
    wallets: z.array(z.object({ id: z.string(), isRuntimeExecutionAllowed: z.boolean() })),
  }),
});

describe("GET /v1/wallets statements", () => {
  beforeEach(async () => {
    env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString("base64");
    env.PRIVY_APP_ID = "wallets-list-app";
    env.PRIVY_APP_SECRET = "wallets-list-secret";
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedFixture();
  });

  afterEach(async () => {
    env.CUSTODY_ENCRYPTION_KEY = originalEncryptionKey;
    env.PRIVY_APP_ID = originalPrivyAppId;
    env.PRIVY_APP_SECRET = originalPrivyAppSecret;
    await clearKVStores(env);
  });

  it("reads the organization row once, in the authentication statement", async () => {
    const { result: response, statements } = await recordStatements(env, listWallets);

    expect(response.status).toBe(200);
    const organizationReads = statements.filter((sql) => /\bFROM organizations\b/.test(sql));
    expect(organizationReads).toHaveLength(1);
    expect(organizationReads[0]).toContain("api_keys");
  });

  it("answers from the organization row of this request, not an earlier one", async () => {
    const first = await listWallets();
    expect(first.status).toBe(200);
    const firstBody = walletsBodySchema.parse(await first.json());
    expect(firstBody.data.wallets.map((wallet) => wallet.isRuntimeExecutionAllowed)).toEqual([
      true,
    ]);

    await getDb(env)
      .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ providerOverrides: { custody: { privy: false } } }), ORGANIZATION_ID)
      .run();

    const second = await listWallets();
    expect(second.status).toBe(200);
    const secondBody = walletsBodySchema.parse(await second.json());
    expect(secondBody.data.wallets.map((wallet) => wallet.isRuntimeExecutionAllowed)).toEqual([
      false,
    ]);
  });
});
