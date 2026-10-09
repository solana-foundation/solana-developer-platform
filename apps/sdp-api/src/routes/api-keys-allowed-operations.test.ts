import { hashString } from "@sdp/payments/hash";
import type { AllowedOperation, CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const TEST_ORG = { id: "org_allowed_ops", name: "Allowed Ops Org", slug: "allowed-ops-org" };
const TEST_PROJECT = { id: "prj_allowed_ops", slug: "allowed-ops-project" };
const TEST_USER = { id: "usr_allowed_ops", email: "allowed-ops@example.com" };

const ADMIN_KEY = {
  id: "key_allowed_ops_admin",
  raw: "sk_test_allowed_ops_admin",
  prefix: "sk_test_all",
};
const PAYMENTS_ONLY_KEY = {
  id: "key_allowed_ops_payments",
  raw: "sk_test_allowed_ops_payments",
  prefix: "sk_test_pay",
  allowedOperations: ["payment"] as AllowedOperation[],
};
const ISSUANCE_ONLY_KEY = {
  id: "key_allowed_ops_issuance",
  raw: "sk_test_allowed_ops_issuance",
  prefix: "sk_test_iss",
  allowedOperations: ["issuance"] as AllowedOperation[],
};

function cachedKey(id: string, allowedOperations: AllowedOperation[] | null): CachedApiKey {
  return {
    id,
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    role: "api_admin",
    permissions: ["*"],
    environment: "sandbox",
    rateLimitTier: "standard",
    allowedIps: null,
    allowedOperations,
    signingWalletId: null,
    status: "active",
    expiresAt: null,
  };
}

async function seedKey(
  key: { id: string; raw: string; prefix: string },
  allowedOperations: AllowedOperation[] | null
): Promise<void> {
  const keyHash = await hashString(key.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, cachedKey(key.id, allowedOperations));
  await getDb(env)
    .prepare(
      `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, allowed_operations, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      key.id,
      TEST_ORG.id,
      TEST_PROJECT.id,
      TEST_USER.id,
      key.id,
      key.prefix,
      keyHash,
      "api_admin",
      JSON.stringify(["*"]),
      allowedOperations ? JSON.stringify(allowedOperations) : null,
      "active"
    )
    .run();
}

async function seedTenant(): Promise<void> {
  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "individual", "active"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(TEST_USER.id, TEST_USER.email, 1, "active"),
  ]);
  await seedDefaultProjects(getDb(env), {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    members: [],
    ids: { sandbox: TEST_PROJECT.id, production: `${TEST_PROJECT.id}_production` },
  });
  await seedKey(ADMIN_KEY, null);
  await seedKey(PAYMENTS_ONLY_KEY, PAYMENTS_ONLY_KEY.allowedOperations);
  await seedKey(ISSUANCE_ONLY_KEY, ISSUANCE_ONLY_KEY.allowedOperations);
}

function headers(raw: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${raw}` };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

type KeyDetail = { data: { id: string; allowedOperations: AllowedOperation[] } };
type ErrorBody = { error: { code: string } };

async function createKey(raw: string, body: Record<string, unknown>): Promise<Response> {
  return app.request(
    "/v1/api-keys",
    {
      method: "POST",
      headers: headers(raw),
      body: JSON.stringify({ walletScope: "all", ...body }),
    },
    env
  );
}

async function getKey(keyId: string): Promise<KeyDetail> {
  const response = await app.request(
    `/v1/api-keys/${keyId}`,
    { method: "GET", headers: headers(ADMIN_KEY.raw) },
    env
  );
  expect(response.status).toBe(200);
  return readJson<KeyDetail>(response);
}

describe("API key allowed operations", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedTenant();
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  it("stores the list on create, returns it sorted and deduplicated, and lists it", async () => {
    const response = await createKey(ADMIN_KEY.raw, {
      name: "Payouts worker",
      allowedOperations: ["payment", "issuance_mint_execute", "payment"],
    });
    expect(response.status).toBe(201);
    const { data } = await readJson<{ data: { apiKey: { id: string } } }>(response);

    const detail = await getKey(data.apiKey.id);
    expect(detail.data.allowedOperations).toEqual(["issuance_mint_execute", "payment"]);

    const list = await app.request(
      "/v1/api-keys",
      { method: "GET", headers: headers(ADMIN_KEY.raw) },
      env
    );
    const listBody = await readJson<{
      data: { apiKeys: Array<{ id: string; allowedOperations: AllowedOperation[] }> };
    }>(list);
    const created = listBody.data.apiKeys.find((key) => key.id === data.apiKey.id);
    expect(created?.allowedOperations).toEqual(["issuance_mint_execute", "payment"]);
    const admin = listBody.data.apiKeys.find((key) => key.id === ADMIN_KEY.id);
    expect(admin?.allowedOperations).toEqual([]);
  });

  it("replaces or clears the list on update and refreshes enforcement", async () => {
    const created = await createKey(ADMIN_KEY.raw, {
      name: "Mutable",
      allowedOperations: ["ramp"],
    });
    const { data } = await readJson<{ data: { apiKey: { id: string } } }>(created);

    const widened = await app.request(
      `/v1/api-keys/${data.apiKey.id}`,
      {
        method: "PATCH",
        headers: headers(ADMIN_KEY.raw),
        body: JSON.stringify({ allowedOperations: ["ramp", "dvp_fund"] }),
      },
      env
    );
    expect(widened.status).toBe(200);
    expect((await getKey(data.apiKey.id)).data.allowedOperations).toEqual(["dvp_fund", "ramp"]);

    const cleared = await app.request(
      `/v1/api-keys/${data.apiKey.id}`,
      {
        method: "PATCH",
        headers: headers(ADMIN_KEY.raw),
        body: JSON.stringify({ allowedOperations: null }),
      },
      env
    );
    expect(cleared.status).toBe(200);
    expect((await getKey(data.apiKey.id)).data.allowedOperations).toEqual([]);
  });

  it("rejects an unknown operation", async () => {
    const response = await createKey(ADMIN_KEY.raw, {
      name: "Bad list",
      allowedOperations: ["payment", "teleport"],
    });
    expect(response.status).toBe(400);
  });

  it("refuses a value-moving call the key's list leaves out, before the body is read", async () => {
    const response = await app.request(
      "/v1/payments/transfers",
      { method: "POST", headers: headers(ISSUANCE_ONLY_KEY.raw), body: "{}" },
      env
    );
    expect(response.status).toBe(403);
    expect((await readJson<ErrorBody>(response)).error.code).toBe("OPERATION_NOT_ALLOWED");
  });

  it("lets a listed family through to the next layer", async () => {
    const response = await app.request(
      "/v1/payments/transfers",
      { method: "POST", headers: headers(PAYMENTS_ONLY_KEY.raw), body: "{}" },
      env
    );
    // The gate passed; the empty body is refused by validation, not by the list.
    expect(response.status).toBe(400);
    expect((await readJson<ErrorBody>(response)).error.code).not.toBe("OPERATION_NOT_ALLOWED");
  });

  it("does not restrict a key with no list", async () => {
    const response = await app.request(
      "/v1/payments/transfers",
      { method: "POST", headers: headers(ADMIN_KEY.raw), body: "{}" },
      env
    );
    expect(response.status).toBe(400);
  });

  it("refuses a restricted key minting a key with wider or no restrictions", async () => {
    const wider = await createKey(PAYMENTS_ONLY_KEY.raw, {
      name: "Wider",
      allowedOperations: ["issuance"],
    });
    expect(wider.status).toBe(403);
    expect((await readJson<ErrorBody>(wider)).error.code).toBe("INSUFFICIENT_PERMISSIONS");

    const unrestricted = await createKey(PAYMENTS_ONLY_KEY.raw, { name: "Unrestricted" });
    expect(unrestricted.status).toBe(403);

    const narrower = await createKey(PAYMENTS_ONLY_KEY.raw, {
      name: "Narrower",
      allowedOperations: ["payment_transfer_execute"],
    });
    expect(narrower.status).toBe(201);
  });

  it("judges a wider grant before provisioning a wallet, so a refusal leaves nothing behind", async () => {
    const walletsBefore = await getDb(env)
      .prepare("SELECT COUNT(*) AS count FROM custody_wallets")
      .first<{ count: number | string }>();

    const response = await createKey(PAYMENTS_ONLY_KEY.raw, {
      name: "Provisioned and wider",
      walletScope: "selected",
      provisionWallet: true,
      allowedOperations: ["issuance"],
    });
    expect(response.status).toBe(403);
    expect((await readJson<ErrorBody>(response)).error.code).toBe("INSUFFICIENT_PERMISSIONS");

    const walletsAfter = await getDb(env)
      .prepare("SELECT COUNT(*) AS count FROM custody_wallets")
      .first<{ count: number | string }>();
    expect(Number(walletsAfter?.count)).toBe(Number(walletsBefore?.count));
  });

  it("refuses a restricted key widening another key's list", async () => {
    const created = await createKey(ADMIN_KEY.raw, {
      name: "Target",
      allowedOperations: ["payment"],
    });
    const { data } = await readJson<{ data: { apiKey: { id: string } } }>(created);

    const response = await app.request(
      `/v1/api-keys/${data.apiKey.id}`,
      {
        method: "PATCH",
        headers: headers(PAYMENTS_ONLY_KEY.raw),
        body: JSON.stringify({ allowedOperations: ["payment", "ramp"] }),
      },
      env
    );
    expect(response.status).toBe(403);
  });

  it("carries the list onto a rotated key", async () => {
    const created = await createKey(ADMIN_KEY.raw, {
      name: "Rotating",
      allowedOperations: ["ramp"],
    });
    const { data } = await readJson<{ data: { apiKey: { id: string } } }>(created);

    const rotated = await app.request(
      `/v1/api-keys/${data.apiKey.id}/rotate`,
      { method: "POST", headers: headers(ADMIN_KEY.raw), body: JSON.stringify({}) },
      env
    );
    expect(rotated.status).toBe(201);
    const rotation = await readJson<{ data: { apiKey: { id: string } } }>(rotated);
    expect((await getKey(rotation.data.apiKey.id)).data.allowedOperations).toEqual(["ramp"]);
  });
});
