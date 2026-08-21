import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { createHeliusRingsWalletRepository } from "@/db/repositories";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const TEST_ORG = { id: "org_hr_route", name: "Rings Route Org", slug: "rings-route-org" };
const TEST_PROJECT = { id: "prj_hr_route", slug: "rings-route-project" };
const TEST_USER = { id: "usr_hr_route", email: "rings-route@example.com" };
const TEST_API_KEY = { id: "key_hr_route", raw: "sk_test_helius_rings", prefix: "sk_test_hr" };

const TEST_CACHED_API_KEY: CachedApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  role: "api_admin",
  permissions: ["*"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};

let originalFlag: string | undefined;
let ringsWalletId: string;

async function seedAuth(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);
  const db = getDb(env);
  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "enterprise", "active"),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(TEST_USER.id, TEST_USER.email, 1, "active"),
    db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_PROJECT.id,
        TEST_ORG.id,
        "Rings Route Project",
        TEST_PROJECT.slug,
        "sandbox",
        "active",
        TEST_USER.id
      ),
    db
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        "Rings Route Key",
        TEST_API_KEY.prefix,
        keyHash,
        "api_admin",
        JSON.stringify(["*"]),
        "active"
      ),
  ]);

  // Policy enforcement requires the operation's wallet to be an active
  // custody wallet owned by the tenant.
  await db.batch([
    db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES ('cfg_hr_route', ?, ?, 'privy', 'test-encrypted', 'active')`
      )
      .bind(TEST_ORG.id, TEST_PROJECT.id),
    db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES ('cw_hr_route', 'cfg_hr_route', 'wal_hr_route', 'HrRouteTestPublicKey111111111111111111111111', 'active')`
      )
      .bind(),
  ]);

  const wallet = await createHeliusRingsWalletRepository(env).createWallet({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    sdpWalletId: "wal_hr_route",
    name: "Treasury",
    materialTag: "simulated",
  });
  if (!wallet) throw new Error("rings wallet fixture was not created");
  ringsWalletId = wallet.id;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${TEST_API_KEY.raw}`,
    "Content-Type": "application/json",
  };
}

function post(path: string, body: unknown) {
  return app.request(
    path,
    { method: "POST", headers: authHeaders(), body: JSON.stringify(body) },
    env
  );
}

describe("Helius Rings routes", () => {
  beforeEach(async () => {
    originalFlag = env.HELIUS_RINGS_ENABLED;
    env.HELIUS_RINGS_ENABLED = "true";
    await seedTestDatabase(env);
    await seedAuth();
  });

  afterEach(async () => {
    env.HELIUS_RINGS_ENABLED = originalFlag;
    await clearKVStores(env);
  });

  it("returns 403 when the feature flag is off", async () => {
    env.HELIUS_RINGS_ENABLED = undefined;
    const res = await app.request("/v1/helius-rings/wallets", { headers: authHeaders() }, env);
    expect(res.status).toBe(403);
  });

  it("GET /health reports the unimplemented gateway red", async () => {
    const res = await app.request("/v1/helius-rings/health", { headers: authHeaders() }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { health: Record<string, string> } };
    expect(body.data.health.gateway).toBe("red");
  });

  it("GET /wallets lists the project's rings wallets", async () => {
    const res = await app.request("/v1/helius-rings/wallets", { headers: authHeaders() }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { wallets: Array<{ id: string; status: string }> } };
    expect(body.data.wallets).toHaveLength(1);
    expect(body.data.wallets[0]).toMatchObject({ id: ringsWalletId, status: "pending" });
  });

  it("POST /wallets 404s for an unknown custody wallet", async () => {
    const res = await post("/v1/helius-rings/wallets", { walletId: "wal_missing", name: "Ops" });
    expect(res.status).toBe(404);
  });

  it("zone create and list round-trips, idempotently", async () => {
    const created = await post(`/v1/helius-rings/wallets/${ringsWalletId}/zones`, {
      name: "Payroll",
      kind: "treasury",
    });
    expect(created.status).toBe(201);
    const replay = await post(`/v1/helius-rings/wallets/${ringsWalletId}/zones`, {
      name: "Payroll",
      kind: "treasury",
    });
    expect(replay.status).toBe(201);

    const listed = await app.request(
      `/v1/helius-rings/wallets/${ringsWalletId}/zones`,
      { headers: authHeaders() },
      env
    );
    const body = (await listed.json()) as { data: { zones: Array<{ name: string }> } };
    expect(body.data.zones).toHaveLength(1);
    expect(body.data.zones[0]?.name).toBe("Payroll");
  });

  it("prepares an operation through real policy and fails honestly at the port", async () => {
    const res = await post("/v1/helius-rings/operations", {
      walletId: ringsWalletId,
      opType: "shield",
      asset: { mint: "So11111111111111111111111111111111111111112", amountRaw: "1000000" },
      clientNonce: "route-nonce-1",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: {
        operation: {
          id: string;
          state: string;
          failure: { code: string; message: string } | null;
        };
      };
    };

    // Default policy is implicit allow, so the operation advances until the
    // port call — which the NotImplemented gateway refuses.
    expect(body.data.operation.state).toBe("failed");
    expect(body.data.operation.failure, body.data.operation.failure?.message).toMatchObject({
      code: "gateway_unavailable",
    });
  });

  it("replays a prepare idempotently and serves detail with the timeline", async () => {
    const input = {
      walletId: ringsWalletId,
      opType: "shield",
      clientNonce: "route-nonce-2",
    };
    const first = (await (await post("/v1/helius-rings/operations", input)).json()) as {
      data: { operation: { id: string } };
    };
    const replay = (await (await post("/v1/helius-rings/operations", input)).json()) as {
      data: { operation: { id: string } };
    };
    expect(replay.data.operation.id).toBe(first.data.operation.id);

    const detail = await app.request(
      `/v1/helius-rings/operations/${first.data.operation.id}`,
      { headers: authHeaders() },
      env
    );
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      data: { operation: { events: Array<{ kind: string }> } };
    };
    const kinds = detailBody.data.operation.events.map((event) => event.kind);
    expect(kinds).toContain("operation.created");
    expect(kinds).toContain("operation.failed");
  });

  it("retries a failed operation with lineage and lists the activity feed", async () => {
    const failed = (await (
      await post("/v1/helius-rings/operations", {
        walletId: ringsWalletId,
        opType: "shield",
        clientNonce: "route-nonce-3",
      })
    ).json()) as { data: { operation: { id: string } } };

    const retried = await post(`/v1/helius-rings/operations/${failed.data.operation.id}/retry`, {
      clientNonce: "route-nonce-3-retry",
    });
    expect(retried.status).toBe(201);
    const retryBody = (await retried.json()) as { data: { operation: { id: string } } };
    expect(retryBody.data.operation.id).not.toBe(failed.data.operation.id);

    const list = await app.request("/v1/helius-rings/operations", { headers: authHeaders() }, env);
    const listBody = (await list.json()) as { data: { operations: Array<{ id: string }> } };
    expect(listBody.data.operations.length).toBeGreaterThanOrEqual(2);
  });

  it("execute is a no-op on a terminal operation", async () => {
    const failed = (await (
      await post("/v1/helius-rings/operations", {
        walletId: ringsWalletId,
        opType: "shield",
        clientNonce: "route-nonce-4",
      })
    ).json()) as { data: { operation: { id: string; state: string } } };

    const executed = await post(
      `/v1/helius-rings/operations/${failed.data.operation.id}/execute`,
      {}
    );
    expect(executed.status).toBe(200);
    const body = (await executed.json()) as { data: { operation: { state: string } } };
    expect(body.data.operation.state).toBe("failed");
  });

  it("rejects an invalid operation body", async () => {
    const res = await post("/v1/helius-rings/operations", {
      walletId: ringsWalletId,
      opType: "not-a-real-op",
      clientNonce: "route-nonce-5",
    });
    expect(res.status).toBe(400);
  });
});
