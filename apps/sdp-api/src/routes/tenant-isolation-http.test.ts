/**
 * Cross-tenant access through the full HTTP stack under the plain
 * NOSUPERUSER/NOBYPASSRLS runtime role: API-key resolution runs under the
 * system database identity, the request narrows to the key's organization,
 * and row-level security (migration 0067) keeps one tenant's key from
 * reading another tenant's records even if a handler forgot its scoping.
 */

import { hashString } from "@sdp/payments/hash";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

const TENANTS = [
  {
    org: "org_http_isolation_a",
    project: "prj_http_isolation_a",
    keyId: "key_http_isolation_a",
    rawKey: "sk_test_http_isolation_tenant_a",
    counterparty: "ctp_http_isolation_a",
    displayName: "Alice A",
  },
  {
    org: "org_http_isolation_b",
    project: "prj_http_isolation_b",
    keyId: "key_http_isolation_b",
    rawKey: "sk_test_http_isolation_tenant_b",
    counterparty: "ctp_http_isolation_b",
    displayName: "Bob B",
  },
] as const;

const USER_ID = "usr_http_isolation";

describe("tenant isolation through the HTTP stack", () => {
  const keyHashes = new Map<string, string>();

  beforeAll(async () => {
    for (const tenant of TENANTS) {
      keyHashes.set(tenant.keyId, await hashString(tenant.rawKey, env.API_KEY_PEPPER));
    }
  });

  beforeEach(async () => {
    await seedTestDatabase(env);

    // API-key lookups may be served from the KV cache; drop any stale entries
    // so each run resolves keys through the database path under test.
    const kv = createKVStoreSet(env);
    const cached = await kv.apiKeys.list();
    for (const key of cached.keys) {
      await kv.apiKeys.delete(key.name);
    }

    const db = getDb(env);
    await db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, 'http-isolation@example.com', 1, 'active')`
      )
      .bind(USER_ID)
      .run();

    for (const tenant of TENANTS) {
      await db.batch([
        db
          .prepare(
            `INSERT INTO organizations (id, name, slug, tier, status)
             VALUES (?, ?, ?, 'individual', 'active')`
          )
          .bind(tenant.org, tenant.org, tenant.org.replaceAll("_", "-")),
        db
          .prepare(
            `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
             VALUES (?, ?, 'HTTP isolation', ?, 'sandbox', 'active', ?)`
          )
          .bind(tenant.project, tenant.org, tenant.project.replaceAll("_", "-"), USER_ID),
        db
          .prepare(
            `INSERT INTO api_keys
               (id, organization_id, project_id, created_by, name, key_prefix, key_hash,
                role, permissions, status)
             VALUES (?, ?, ?, ?, 'HTTP isolation', 'sk_test_htt', ?, 'api_admin', '["*"]', 'active')`
          )
          .bind(tenant.keyId, tenant.org, tenant.project, USER_ID, keyHashes.get(tenant.keyId)),
        db
          .prepare(
            `INSERT INTO counterparties
               (id, organization_id, project_id, entity_type, display_name, email, status)
             VALUES (?, ?, ?, 'individual', ?, 'holder@example.com', 'active')`
          )
          .bind(tenant.counterparty, tenant.org, tenant.project, tenant.displayName),
      ]);
    }
  });

  const getCounterparty = (rawKey: string, counterpartyId: string) =>
    app.request(
      `/v1/counterparties/${counterpartyId}`,
      { headers: { Authorization: `Bearer ${rawKey}` } },
      env
    );

  it("serves each tenant its own records", async () => {
    for (const tenant of TENANTS) {
      const res = await getCounterparty(tenant.rawKey, tenant.counterparty);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data?: { displayName?: string } };
      expect(JSON.stringify(body)).toContain(tenant.displayName);
    }
  });

  it("denies one tenant's key access to another tenant's record", async () => {
    const [tenantA, tenantB] = TENANTS;

    const crossRead = await getCounterparty(tenantA.rawKey, tenantB.counterparty);
    expect(crossRead.status).toBe(404);

    const reverse = await getCounterparty(tenantB.rawKey, tenantA.counterparty);
    expect(reverse.status).toBe(404);
  });

  it("keeps tenant listings disjoint", async () => {
    const [tenantA, tenantB] = TENANTS;
    const res = await app.request(
      "/v1/counterparties",
      { headers: { Authorization: `Bearer ${tenantA.rawKey}` } },
      env
    );
    expect(res.status).toBe(200);
    const body = JSON.stringify(await res.json());
    expect(body).toContain(tenantA.displayName);
    expect(body).not.toContain(tenantB.displayName);
  });
});
