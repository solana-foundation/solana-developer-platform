/**
 * Webhook endpoint registry, exercised through the real route stack.
 *
 * Pins the contracts the dashboard and API callers depend on: the signing secret
 * appears exactly once (create/rotate) and never again on any read path, the
 * webhooks:read / webhooks:write permission split, rotation grace, soft delete,
 * the delivery log, manual redelivery, and the save-time endpointId validation on
 * workflow rules.
 */

import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PROJECT } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";

// Create/rotate write the signing secret through the credential secret store; the
// encrypted_db backend is the only one a test container can satisfy.
const secretEnv = {
  ...env,
  CREDENTIAL_SECRET_STORE_BACKEND: "encrypted_db",
  CUSTODY_ENCRYPTION_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
};

const TOKEN_ID = "tok_webhook_registry_test";

// Two principals differing only in `webhooks:write` — the read/write permission split.
// The write key also carries tokens:* so it can author send_webhook rules.
const READ_KEY = { id: "key_wh_read", raw: "sk_test_wh_read", prefix: "sk_test_wh_r" };
const WRITE_KEY = { id: "key_wh_write", raw: "sk_test_wh_write", prefix: "sk_test_wh_w" };

const READ_PERMISSIONS = ["webhooks:read", "tokens:read"];
const WRITE_PERMISSIONS = ["webhooks:read", "webhooks:write", "tokens:read", "tokens:write"];

function cachedKey(id: string, permissions: string[]): CachedApiKey {
  return {
    id,
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    role: "api_admin",
    permissions,
    environment: "sandbox",
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: null,
    status: "active",
    expiresAt: null,
    rotationDeadline: null,
  } as CachedApiKey;
}

function request(
  key: { raw: string },
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
) {
  return app.request(
    path,
    {
      method,
      headers: {
        Authorization: `Bearer ${key.raw}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    secretEnv
  );
}

async function createEndpoint(overrides: Record<string, unknown> = {}) {
  const res = await request(WRITE_KEY, "POST", "/v1/webhook-endpoints", {
    url: "https://example.com/hooks/sdp",
    label: "Registry test endpoint",
    ...overrides,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as {
    data: { endpoint: { id: string; secretVersion: number }; secret: string };
  };
}

async function seedDelivery(
  endpointId: string,
  fields: { id: string; requestBody?: string; requestBodyTruncated?: boolean }
) {
  await getDb(env)
    .prepare(
      `INSERT INTO webhook_deliveries
         (id, organization_id, project_id, endpoint_id, trigger_type, attempt,
          request_body, request_body_truncated, status, response_status, error)
       VALUES (?, ?, ?, ?, 'kyc_approved', 1, ?, ?, 'failed', 502, 'HTTP_502')`
    )
    .bind(
      fields.id,
      TEST_ORG.id,
      TEST_PROJECT.id,
      endpointId,
      fields.requestBody ?? JSON.stringify({ type: "kyc_approved", executionId: "exec_x" }),
      fields.requestBodyTruncated ?? false
    )
    .run();
}

describe("webhook endpoint registry (routes)", () => {
  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    const db = getDb(env);
    const kv = createKVStoreSet(env);

    // Clear rate-limit KV so repeated requests across tests don't 429.
    const rateLimitKeys = await kv.rateLimits.list();
    for (const key of rateLimitKeys.keys) {
      await kv.rateLimits.delete(key.name);
    }

    await db.prepare("DELETE FROM webhook_deliveries").run();
    await db.prepare("DELETE FROM webhook_endpoints").run();
    await db.prepare("DELETE FROM workflow_executions").run();
    await db.prepare("DELETE FROM asset_workflows").run();
    await db.prepare("DELETE FROM issued_tokens").run();
    await db.prepare("DELETE FROM api_keys WHERE project_id IS NOT NULL").run();
    await db.prepare("DELETE FROM projects").run();

    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await db
      .prepare(
        `INSERT OR REPLACE INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_PROJECT.id,
        TEST_ORG.id,
        TEST_PROJECT.name,
        TEST_PROJECT.slug,
        TEST_PROJECT.environment,
        "active",
        TEST_USER.id
      )
      .run();

    // A deployed token so the save-time endpointId tests can author send_webhook rules.
    await db
      .prepare(
        `INSERT OR REPLACE INTO issued_tokens
           (id, project_id, organization_id, created_by, mint_address, mint_authority,
            abl_list_address, name, symbol, decimals, template, is_mintable,
            allowlist_enabled, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Registry Test', 'WHREG', 6, 'stablecoin', 1, 1, 'active')`
      )
      .bind(
        TOKEN_ID,
        TEST_PROJECT.id,
        TEST_ORG.id,
        TEST_USER.id,
        "So11111111111111111111111111111111111111112",
        "So11111111111111111111111111111111111111112",
        "So11111111111111111111111111111111111111112"
      )
      .run();

    for (const [key, permissions] of [
      [READ_KEY, READ_PERMISSIONS],
      [WRITE_KEY, WRITE_PERMISSIONS],
    ] as const) {
      const hash = await hashString(key.raw, (env as { API_KEY_PEPPER: string }).API_KEY_PEPPER);
      await db
        .prepare(
          `INSERT OR REPLACE INTO api_keys
             (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
           VALUES (?, ?, ?, ?, 'wh registry key', ?, ?, 'api_admin', ?, 'active')`
        )
        .bind(
          key.id,
          TEST_ORG.id,
          TEST_PROJECT.id,
          TEST_USER.id,
          key.prefix,
          hash,
          JSON.stringify(permissions)
        )
        .run();
      await kv.apiKeys.put(`key:${hash}`, JSON.stringify(cachedKey(key.id, [...permissions])));
    }
  });

  it("returns the whsec_ secret exactly once and never on a read path", async () => {
    const created = await createEndpoint();
    expect(created.data.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(created.data.endpoint.secretVersion).toBe(1);
    expect(JSON.stringify(created.data.endpoint)).not.toContain("whsec_");
    expect(JSON.stringify(created.data.endpoint)).not.toContain("secret_storage");

    const list = await request(READ_KEY, "GET", "/v1/webhook-endpoints");
    expect(list.status).toBe(200);
    expect(await list.text()).not.toContain("whsec_");

    const detail = await request(
      READ_KEY,
      "GET",
      `/v1/webhook-endpoints/${created.data.endpoint.id}`
    );
    expect(detail.status).toBe(200);
    const detailText = await detail.text();
    expect(detailText).not.toContain("whsec_");
    expect(detailText).not.toContain("secretRef");
    expect(detailText).not.toContain("encryptedSecretPayload");
  });

  it("rejects an insecure or private endpoint URL at create", async () => {
    for (const url of ["http://example.com/hook", "https://10.1.2.3/hook", "not-a-url"]) {
      const res = await request(WRITE_KEY, "POST", "/v1/webhook-endpoints", {
        url,
        label: "bad",
      });
      expect(res.status).toBe(400);
    }
  });

  it("refuses every mutation to a webhooks:read principal", async () => {
    const { data } = await createEndpoint();
    const id = data.endpoint.id;
    await seedDelivery(id, { id: "webhook_delivery_perm_test" });

    const attempts: Array<[typeof READ_KEY, "POST" | "PATCH" | "DELETE", string, unknown?]> = [
      [READ_KEY, "POST", "/v1/webhook-endpoints", { url: "https://example.com/x", label: "x" }],
      [READ_KEY, "PATCH", `/v1/webhook-endpoints/${id}`, { label: "renamed" }],
      [READ_KEY, "DELETE", `/v1/webhook-endpoints/${id}`],
      [READ_KEY, "POST", `/v1/webhook-endpoints/${id}/rotate-secret`, {}],
      [
        READ_KEY,
        "POST",
        `/v1/webhook-endpoints/${id}/deliveries/webhook_delivery_perm_test/redeliver`,
      ],
    ];
    for (const [key, method, path, body] of attempts) {
      const res = await request(key, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }

    // Reads stay open to the read key.
    expect((await request(READ_KEY, "GET", "/v1/webhook-endpoints")).status).toBe(200);
    expect((await request(READ_KEY, "GET", `/v1/webhook-endpoints/${id}/deliveries`)).status).toBe(
      200
    );
  });

  it("rotates in place: new secret, bumped version, 24h default grace", async () => {
    const { data } = await createEndpoint();

    const res = await request(
      WRITE_KEY,
      "POST",
      `/v1/webhook-endpoints/${data.endpoint.id}/rotate-secret`
    );
    expect(res.status).toBe(200);
    const rotated = (await res.json()) as {
      data: {
        endpoint: { id: string; secretVersion: number };
        secret: string;
        previousSecretExpiresAt: string | null;
      };
    };

    expect(rotated.data.secret).toMatch(/^whsec_/);
    expect(rotated.data.secret).not.toBe(data.secret);
    expect(rotated.data.endpoint.id).toBe(data.endpoint.id);
    expect(rotated.data.endpoint.secretVersion).toBe(2);
    const expires = Date.parse(rotated.data.previousSecretExpiresAt ?? "");
    expect(expires).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(expires).toBeLessThan(Date.now() + 25 * 3_600_000);
  });

  it("honors gracePeriodHours: 0 (immediate cutover, no previous key)", async () => {
    const { data } = await createEndpoint();
    const res = await request(
      WRITE_KEY,
      "POST",
      `/v1/webhook-endpoints/${data.endpoint.id}/rotate-secret`,
      { gracePeriodHours: 0 }
    );
    expect(res.status).toBe(200);
    const rotated = (await res.json()) as {
      data: { previousSecretExpiresAt: string | null };
    };
    expect(rotated.data.previousSecretExpiresAt).toBeNull();
  });

  it("soft deletes: gone from reads, deliveries stay readable, referencing rules counted", async () => {
    const { data } = await createEndpoint();
    const id = data.endpoint.id;
    await seedDelivery(id, { id: "webhook_delivery_softdel_test" });

    // An enabled rule referencing the endpoint, so the delete response can warn.
    const rule = await request(WRITE_KEY, "POST", `/v1/issuance/tokens/${TOKEN_ID}/workflows`, {
      triggerType: "kyc_approved",
      actionType: "send_webhook",
      actionParams: { endpointId: id },
    });
    expect(rule.status).toBe(201);

    const deleted = await request(WRITE_KEY, "DELETE", `/v1/webhook-endpoints/${id}`);
    expect(deleted.status).toBe(200);
    const body = (await deleted.json()) as {
      data: { deleted: boolean; referencingWorkflows: number };
    };
    expect(body.data).toEqual({ deleted: true, referencingWorkflows: 1 });

    expect((await request(READ_KEY, "GET", `/v1/webhook-endpoints/${id}`)).status).toBe(404);
    const list = (await (await request(READ_KEY, "GET", "/v1/webhook-endpoints")).json()) as {
      data: unknown[];
    };
    expect(list.data).toHaveLength(0);

    // The delivery log is the point of soft delete — history stays readable.
    const deliveries = await request(READ_KEY, "GET", `/v1/webhook-endpoints/${id}/deliveries`);
    expect(deliveries.status).toBe(200);
    const deliveriesBody = (await deliveries.json()) as { data: unknown[] };
    expect(deliveriesBody.data).toHaveLength(1);

    // And redelivery to a deleted endpoint is refused.
    const redeliver = await request(
      WRITE_KEY,
      "POST",
      `/v1/webhook-endpoints/${id}/deliveries/webhook_delivery_softdel_test/redeliver`
    );
    expect(redeliver.status).toBe(409);
  });

  it("redelivers byte-identically as a new manual row without touching executions", async () => {
    const { data } = await createEndpoint();
    const id = data.endpoint.id;
    const requestBody = JSON.stringify({ type: "kyc_approved", executionId: "exec_original" });
    await seedDelivery(id, { id: "webhook_delivery_redeliver_test", requestBody });

    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(
      WRITE_KEY,
      "POST",
      `/v1/webhook-endpoints/${id}/deliveries/webhook_delivery_redeliver_test/redeliver`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        delivery: {
          id: string;
          manual: boolean;
          redeliveryOf: string;
          status: string;
          responseStatus: number;
          requestBody: string;
        };
      };
    };
    expect(body.data.delivery).toMatchObject({
      manual: true,
      redeliveryOf: "webhook_delivery_redeliver_test",
      status: "succeeded",
      responseStatus: 200,
      requestBody,
    });

    // The wire request used the stored body byte-identically, with v2 headers signed
    // by the endpoint's current secret.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(init.body)).toBe(requestBody);
    const headers = init.headers as Record<string, string>;
    expect(headers["x-sdp-delivery"]).toBe(body.data.delivery.id);
    expect(headers["x-sdp-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    // A debugging tool, not a retry: workflow_executions is untouched.
    const executions = await getDb(env)
      .prepare("SELECT COUNT(*) AS count FROM workflow_executions")
      .first<{ count: number }>();
    expect(Number(executions?.count ?? 0)).toBe(0);

    // Both rows are in the log now, the manual one first.
    const log = (await (
      await request(READ_KEY, "GET", `/v1/webhook-endpoints/${id}/deliveries`)
    ).json()) as { data: Array<{ id: string }>; meta: { total: number } };
    expect(log.meta.total).toBe(2);
  });

  it("refuses redelivery of a truncated body and of a disabled endpoint", async () => {
    const { data } = await createEndpoint();
    const id = data.endpoint.id;
    await seedDelivery(id, { id: "webhook_delivery_trunc_test", requestBodyTruncated: true });

    const truncated = await request(
      WRITE_KEY,
      "POST",
      `/v1/webhook-endpoints/${id}/deliveries/webhook_delivery_trunc_test/redeliver`
    );
    expect(truncated.status).toBe(409);

    await seedDelivery(id, { id: "webhook_delivery_disabled_test" });
    const disable = await request(WRITE_KEY, "PATCH", `/v1/webhook-endpoints/${id}`, {
      status: "disabled",
    });
    expect(disable.status).toBe(200);

    const onDisabled = await request(
      WRITE_KEY,
      "POST",
      `/v1/webhook-endpoints/${id}/deliveries/webhook_delivery_disabled_test/redeliver`
    );
    expect(onDisabled.status).toBe(409);
  });

  it("validates the endpointId reference when a send_webhook rule is saved", async () => {
    const { data } = await createEndpoint();
    const base = `/v1/issuance/tokens/${TOKEN_ID}/workflows`;

    // Registry mode with a real endpoint.
    const valid = await request(WRITE_KEY, "POST", base, {
      triggerType: "kyc_approved",
      actionType: "send_webhook",
      actionParams: { endpointId: data.endpoint.id },
    });
    expect(valid.status).toBe(201);

    // An id that doesn't exist in this project.
    const unknown = await request(WRITE_KEY, "POST", base, {
      triggerType: "kyc_approved",
      actionType: "send_webhook",
      actionParams: { endpointId: "webhook_endpoint_00000000-0000-4000-8000-000000000000" },
    });
    expect(unknown.status).toBe(400);

    // The two shapes are XOR: url + endpointId together matches neither union arm.
    const both = await request(WRITE_KEY, "POST", base, {
      triggerType: "kyc_approved",
      actionType: "send_webhook",
      actionParams: { endpointId: data.endpoint.id, url: "https://example.com/hook" },
    });
    expect(both.status).toBe(400);

    // The legacy inline-url shape still saves.
    const legacy = await request(WRITE_KEY, "POST", base, {
      triggerType: "kyc_approved",
      actionType: "send_webhook",
      actionParams: { url: "https://example.com/hook", secret: "legacy-secret" },
    });
    expect(legacy.status).toBe(201);
  });

  it("never returns another org's endpoint", async () => {
    const db = getDb(env);
    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES ('org_other_wh', 'Other', 'other-wh', 'individual', 'active')"
      )
      .run();
    await db
      .prepare(
        `INSERT OR REPLACE INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES ('prj_other_wh', 'org_other_wh', 'Other', 'other-wh', 'sandbox', 'active', ?)`
      )
      .bind(TEST_USER.id)
      .run();
    const foreignId = "webhook_endpoint_11111111-2222-4333-8444-555555555555";
    await db
      .prepare(
        `INSERT INTO webhook_endpoints (id, organization_id, project_id, url, label, secret_storage)
         VALUES (?, 'org_other_wh', 'prj_other_wh', 'https://example.com/foreign', 'Foreign', '{"storageBackend":"encrypted_db","encryptedSecretPayload":"x"}'::jsonb)`
      )
      .bind(foreignId)
      .run();

    expect((await request(READ_KEY, "GET", `/v1/webhook-endpoints/${foreignId}`)).status).toBe(404);
    expect(
      (await request(WRITE_KEY, "PATCH", `/v1/webhook-endpoints/${foreignId}`, { label: "x" }))
        .status
    ).toBe(404);
  });
});
