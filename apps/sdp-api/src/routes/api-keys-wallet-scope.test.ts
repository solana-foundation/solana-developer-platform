import { hashString } from "@sdp/payments/hash";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { ALL_API_KEY_GRANTS } from "@/test/fixtures/api-keys";
import { authenticateTestClerkUser, clerkHeaders } from "@/test/helpers/clerk";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { type SeededApiKey, seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const TEST_ORG = {
  id: "org_api_key_wallet_scope",
  name: "API Key Wallet Scope Org",
  slug: "api-key-wallet-scope-org",
};

const TEST_PROJECT = {
  id: "prj_test_api_key_wallet_scope",
  slug: "test-api-key-wallet-scope-project",
};

const TEST_USER = {
  id: "usr_api_key_wallet_scope",
  email: "api-key-wallet-scope@example.com",
};

const TEST_API_KEY = {
  id: "key_api_key_wallet_scope",
  raw: "sk_test_api_key_wallet_scope",
  prefix: "sk_test_api",
};

const TEST_SEEDED_API_KEY: SeededApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  grants: ALL_API_KEY_GRANTS,
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  status: "active",
  expiresAt: null,
};

const TEST_CONFIG_ID = "cust_cfg_api_key_wallet_scope";
const LIST_FAILURE_CONSTRAINT = "sdp_test_fail_api_key_signing_wallet_insert";

async function removeListFailureConstraint(): Promise<void> {
  await getDb(env)
    .prepare(
      `ALTER TABLE api_key_signing_wallets
       DROP CONSTRAINT IF EXISTS ${LIST_FAILURE_CONSTRAINT}`
    )
    .run();
}

async function installListFailureConstraint(): Promise<void> {
  await removeListFailureConstraint();
  await getDb(env)
    .prepare(
      `ALTER TABLE api_key_signing_wallets
       ADD CONSTRAINT ${LIST_FAILURE_CONSTRAINT}
       CHECK (custody_wallet_id <> 'cwlt_scope_b') NOT VALID`
    )
    .run();
}

async function seedAuthAndWallets(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedApiKeyRow(env, keyHash, TEST_SEEDED_API_KEY);

  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "individual", "active"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(TEST_USER.id, TEST_USER.email, 1, "active"),
  ]);
  ({ token: clerkToken } = await authenticateTestClerkUser(env, getDb(env), {
    userId: TEST_USER.id,
    email: TEST_USER.email,
    clerkUserId: `clerk_${TEST_USER.id}`,
    organizationId: TEST_ORG.id,
    clerkOrgId: `clerk_${TEST_ORG.id}`,
    orgSlug: TEST_ORG.slug,
    role: "admin",
  }));
  await seedDefaultProjects(getDb(env), {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    members: [TEST_USER.id],
    ids: { sandbox: TEST_PROJECT.id, production: `${TEST_PROJECT.id}_production` },
  });
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, grants, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        "Admin test key",
        TEST_API_KEY.prefix,
        keyHash,
        ALL_API_KEY_GRANTS,
        "active"
      ),
  ]);
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: TEST_CONFIG_ID,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        provider: "local",
        configEncrypted: "test-config",
        status: "active",
      },
    ],
    wallets: [
      {
        id: "cwlt_scope_a",
        owner: { kind: "config", custodyConfigId: TEST_CONFIG_ID },
        walletId: "wal_scope_a",
        publicKey: "pub_scope_a",
        label: "Wallet Scope A",
        purpose: "transfer",
        status: "active",
      },
      {
        id: "cwlt_scope_b",
        owner: { kind: "config", custodyConfigId: TEST_CONFIG_ID },
        walletId: "wal_scope_b",
        publicKey: "pub_scope_b",
        label: "Wallet Scope B",
        purpose: "transfer",
        status: "active",
      },
    ],
  });
}

/** Keys are managed by a signed-in organization admin, never by a key (HOO-2099). */
let clerkToken: string;

function authenticatedJsonHeaders() {
  return clerkHeaders(clerkToken, TEST_PROJECT.id);
}

function postKey(body: Record<string, unknown>) {
  return app.request(
    "/v1/api-keys",
    {
      method: "POST",
      headers: authenticatedJsonHeaders(),
      body: JSON.stringify({ grants: ["transfers.read"], ...body }),
    },
    env
  );
}

function patchKey(keyId: string, body: Record<string, unknown>) {
  return app.request(
    `/v1/api-keys/${keyId}`,
    { method: "PATCH", headers: authenticatedJsonHeaders(), body: JSON.stringify(body) },
    env
  );
}

const errorMessageSchema = z.object({ error: z.object({ message: z.string() }) });

async function readKey(keyId: string) {
  const response = await app.request(
    `/v1/api-keys/${keyId}`,
    { headers: authenticatedJsonHeaders() },
    env
  );
  expect(response.status).toBe(200);
  const body = z
    .object({
      data: z.object({
        name: z.string(),
        walletScope: z.enum(["all", "selected"]),
        walletIds: z.array(z.string()),
      }),
    })
    .parse(await response.json());
  return body.data;
}

async function createKey(body: Record<string, unknown>): Promise<string> {
  const response = await postKey({ name: "Scoped key", ...body });
  expect(response.status).toBe(201);
  return z
    .object({ data: z.object({ apiKey: z.object({ id: z.string() }) }) })
    .parse(await response.json()).data.apiKey.id;
}

// HOO-2099: a key's wallet scope is explicit, and a selected key lists exact
// custody wallet ids (APE-390). The list decides which wallets it may sign
// with, at the custody signer, and narrows only its wallet list and detail.
describe("API key wallet scope routes", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedAuthAndWallets();
  });

  afterEach(async () => {
    await removeListFailureConstraint();
    await clearKVStores(env);
  });

  it("rejects create requests without walletScope", async () => {
    const response = await postKey({ name: "Missing wallet scope" });
    expect(response.status).toBe(400);
  });

  it("rejects walletIds on an all-wallets key", async () => {
    const response = await postKey({
      name: "Conflicting all-wallet key",
      walletScope: "all",
      walletIds: ["cwlt_scope_a"],
    });

    expect(response.status).toBe(400);
    const body = errorMessageSchema.parse(await response.json());
    expect(body.error.message).toContain("walletScope 'all'");
  });

  it("rejects the retired wallet-binding fields instead of ignoring them", async () => {
    const response = await postKey({
      name: "Legacy fields",
      walletScope: "selected",
      signingWalletIds: ["wal_scope_a"],
    });
    expect(response.status).toBe(400);
  });

  it("creates a selected key listing exact custody wallet ids", async () => {
    const keyId = await createKey({
      walletScope: "selected",
      walletIds: ["cwlt_scope_b", "cwlt_scope_a"],
    });

    expect(await readKey(keyId)).toMatchObject({
      walletScope: "selected",
      walletIds: ["cwlt_scope_a", "cwlt_scope_b"],
    });
    expect(
      await getDb(env).queryOne("SELECT wallet_scope FROM api_keys WHERE id = ?", [keyId])
    ).toEqual({ wallet_scope: "selected" });
  });

  it("keeps a selected key with no wallets selected, never widening it to all", async () => {
    const keyId = await createKey({ walletScope: "selected" });

    expect(await readKey(keyId)).toMatchObject({ walletScope: "selected", walletIds: [] });
  });

  it("refuses a provider wallet id: a key lists custody wallet rows only (APE-390)", async () => {
    const response = await postKey({
      name: "Provider id key",
      walletScope: "selected",
      walletIds: ["wal_scope_a"],
    });

    expect(response.status).toBe(400);
    const body = errorMessageSchema.parse(await response.json());
    expect(body.error.message).toBe("Unknown wallet ids for this project: wal_scope_a");
  });

  it("rolls back API key creation when its wallet list cannot be written", async () => {
    await installListFailureConstraint();

    const response = await postKey({
      name: "Rollback key",
      walletScope: "selected",
      walletIds: ["cwlt_scope_a", "cwlt_scope_b"],
    });

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(
      await getDb(env).queryMany("SELECT id FROM api_keys WHERE name = ?", ["Rollback key"])
    ).toEqual([]);
  });

  it("refuses to delete a custody wallet a key lists", async () => {
    await createKey({ walletScope: "selected", walletIds: ["cwlt_scope_a"] });

    await expect(
      getDb(env).prepare("DELETE FROM custody_wallets WHERE id = 'cwlt_scope_a'").run()
    ).rejects.toThrow(/api_key_signing_wallets/);
  });

  it("requires walletScope when updating walletIds", async () => {
    const keyId = await createKey({ walletScope: "all" });

    const response = await patchKey(keyId, { walletIds: ["cwlt_scope_a"] });

    expect(response.status).toBe(400);
    expect(await readKey(keyId)).toMatchObject({ walletScope: "all", walletIds: [] });
  });

  it("replaces the list, archiving what it drops and reviving what it lists again", async () => {
    const keyId = await createKey({ walletScope: "selected", walletIds: ["cwlt_scope_a"] });

    expect(
      (await patchKey(keyId, { walletScope: "selected", walletIds: ["cwlt_scope_b"] })).status
    ).toBe(200);
    expect(await readKey(keyId)).toMatchObject({
      walletScope: "selected",
      walletIds: ["cwlt_scope_b"],
    });

    expect((await patchKey(keyId, { walletScope: "all" })).status).toBe(200);
    expect(await readKey(keyId)).toMatchObject({ walletScope: "all", walletIds: [] });
    // Taken off the list, not deleted: the row stays, archived.
    expect(
      await getDb(env).queryMany(
        `SELECT custody_wallet_id, status FROM api_key_signing_wallets
          WHERE api_key_id = ? ORDER BY custody_wallet_id`,
        [keyId]
      )
    ).toEqual([
      { custody_wallet_id: "cwlt_scope_a", status: "archived" },
      { custody_wallet_id: "cwlt_scope_b", status: "archived" },
    ]);

    expect(
      (await patchKey(keyId, { walletScope: "selected", walletIds: ["cwlt_scope_b"] })).status
    ).toBe(200);
    expect(await readKey(keyId)).toMatchObject({
      walletScope: "selected",
      walletIds: ["cwlt_scope_b"],
    });
  });

  it("keeps the key unchanged when its new wallet list cannot be written", async () => {
    const keyId = await createKey({ walletScope: "selected", walletIds: ["cwlt_scope_a"] });
    await installListFailureConstraint();

    const response = await patchKey(keyId, {
      name: "Renamed",
      walletScope: "selected",
      walletIds: ["cwlt_scope_b"],
    });

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await readKey(keyId)).toMatchObject({
      name: "Scoped key",
      walletScope: "selected",
      walletIds: ["cwlt_scope_a"],
    });
  });

  it("narrows a selected key's wallet list and wallet detail, read fresh", async () => {
    const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
    const asKey = (path: string) =>
      app.request(path, { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } }, env);
    const listed = async () => {
      const response = await asKey("/v1/wallets?view=summary");
      expect(response.status).toBe(200);
      const body = z
        .object({ data: z.object({ wallets: z.array(z.object({ id: z.string() })) }) })
        .parse(await response.json());
      return body.data.wallets.map((wallet) => wallet.id).sort();
    };

    expect(await listed()).toEqual(["cwlt_scope_a", "cwlt_scope_b"]);

    await seedApiKeyRow(env, keyHash, {
      ...TEST_SEEDED_API_KEY,
      walletScope: "selected",
      walletIds: ["cwlt_scope_a"],
    });
    expect(await listed()).toEqual(["cwlt_scope_a"]);
    expect((await asKey("/v1/wallets/wal_scope_b?includeBalance=false")).status).toBe(404);
    expect((await asKey("/v1/wallets/wal_scope_a?includeBalance=false")).status).toBe(200);

    await seedApiKeyRow(env, keyHash, {
      ...TEST_SEEDED_API_KEY,
      walletScope: "selected",
      walletIds: [],
    });
    expect(await listed()).toEqual([]);
  });

  it("hides API keys outside the authenticated organization", async () => {
    await getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(
        "org_other_api_key_policy",
        "Other Organization",
        "other-api-key-policy",
        "individual",
        "active"
      )
      .run();
    await seedDefaultProjects(getDb(env), {
      organizationId: "org_other_api_key_policy",
      createdBy: TEST_USER.id,
      members: [],
      ids: {
        sandbox: "prj_other_org_api_key_policy",
        production: "prj_other_org_api_key_policy_production",
      },
    });
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO api_keys
             (id, organization_id, project_id, created_by, name, key_prefix, key_hash, grants, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          "key_other_org_policy",
          "org_other_api_key_policy",
          "prj_other_org_api_key_policy",
          TEST_USER.id,
          "Other organization key",
          "sk_other_org",
          "hash_other_org_policy",
          ALL_API_KEY_GRANTS,
          "active"
        ),
    ]);

    const response = await app.request(
      "/v1/api-keys/key_other_org_policy",
      { headers: authenticatedJsonHeaders() },
      env
    );

    expect(response.status).toBe(404);
  });
});
