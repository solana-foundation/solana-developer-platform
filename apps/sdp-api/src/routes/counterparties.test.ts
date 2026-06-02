import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { hashString } from "@/lib/hash";
import { createKVStoreSet } from "@/runtime/factory";
import { TEST_API_KEY, TEST_CACHED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";

const TEST_PROJECT_ID = "prj_counterparties_test";

describe("Counterparties Routes", () => {
  let apiKeyHash: string;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
    apiKeyHash = await hashString(
      TEST_API_KEY.raw,
      (env as { API_KEY_PEPPER: string }).API_KEY_PEPPER
    );
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    const kv = createKVStoreSet(env);

    const keys = await kv.rateLimits.list();
    for (const key of keys.keys) {
      await kv.rateLimits.delete(key.name);
    }

    await db
      .prepare("DELETE FROM counterparties")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM api_keys")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM project_members")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM projects")
      .run()
      .catch(() => {});

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
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Test Project', 'test-project', 'sandbox', 'active', ?)`
      )
      .bind(TEST_PROJECT_ID, TEST_ORG.id, TEST_USER.id)
      .run();

    await db
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role)
         VALUES ('pm_test_counterparty', ?, ?, 'admin')`
      )
      .bind(TEST_PROJECT_ID, TEST_USER.id)
      .run();

    await db
      .prepare(
        `INSERT OR REPLACE INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, 'Test Key', ?, ?, 'api_admin', '["*"]', 'active')`
      )
      .bind(
        TEST_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT_ID,
        TEST_USER.id,
        TEST_API_KEY.prefix,
        apiKeyHash
      )
      .run();

    await kv.apiKeys.put(
      `key:${apiKeyHash}`,
      JSON.stringify({ ...TEST_CACHED_API_KEY, projectId: TEST_PROJECT_ID })
    );
  });

  const authHeader = `Bearer ${TEST_API_KEY.raw}`;

  const createCounterparty = (body: Record<string, unknown> = {}) =>
    app.request(
      "/v1/counterparties",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          entityType: "individual",
          displayName: "Alice",
          email: "alice@example.com",
          ...body,
        }),
      },
      env
    );

  describe("POST /v1/counterparties", () => {
    it("creates a counterparty", async () => {
      const res = await createCounterparty({ externalId: "ext_001" });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.counterparty.id).toMatch(/^counterparty_/);
      expect(body.data.counterparty.organizationId).toBe(TEST_ORG.id);
      expect(body.data.counterparty.entityType).toBe("individual");
      expect(body.data.counterparty.displayName).toBe("Alice");
      expect(body.data.counterparty.externalId).toBe("ext_001");
      expect(body.data.counterparty.status).toBe("active");
      expect(body.data.counterparty.createdBy).toBe(TEST_USER.id);
    });

    it("returns 409 on duplicate externalId", async () => {
      await createCounterparty({ externalId: "dup_001" });
      const res = await createCounterparty({ externalId: "dup_001", email: "other@example.com" });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("CONFLICT");
    });

    it("returns 400 on invalid body", async () => {
      const res = await app.request(
        "/v1/counterparties",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: authHeader },
          body: JSON.stringify({ entityType: "invalid", displayName: "" }),
        },
        env
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("BAD_REQUEST");
    });

    it("returns 401 without auth", async () => {
      const res = await app.request(
        "/v1/counterparties",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entityType: "individual", displayName: "X", email: "x@x.com" }),
        },
        env
      );
      expect(res.status).toBe(401);
    });
  });

  describe("GET /v1/counterparties", () => {
    it("lists counterparties for the org", async () => {
      await createCounterparty({ externalId: "list_1", displayName: "First" });
      await createCounterparty({ externalId: "list_2", displayName: "Second" });

      const res = await app.request(
        "/v1/counterparties",
        { headers: { Authorization: authHeader } },
        env
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.total).toBe(2);
      expect(body.data.counterparties).toHaveLength(2);
      expect(body.data.page).toBe(1);
    });

    it("excludes archived by default", async () => {
      const created = await createCounterparty({ externalId: "archived_1" });
      const cp = (await created.json()).data.counterparty;
      await app.request(
        `/v1/counterparties/${cp.id}`,
        { method: "DELETE", headers: { Authorization: authHeader } },
        env
      );

      const res = await app.request(
        "/v1/counterparties",
        { headers: { Authorization: authHeader } },
        env
      );
      const body = await res.json();
      expect(body.data.total).toBe(0);
    });
  });

  describe("GET /v1/counterparties/:counterpartyId", () => {
    it("returns a counterparty", async () => {
      const created = await createCounterparty({ externalId: "get_1" });
      const cp = (await created.json()).data.counterparty;

      const res = await app.request(
        `/v1/counterparties/${cp.id}`,
        { headers: { Authorization: authHeader } },
        env
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.counterparty.id).toBe(cp.id);
    });

    it("returns 404 for unknown id", async () => {
      const res = await app.request(
        "/v1/counterparties/counterparty_does_not_exist",
        { headers: { Authorization: authHeader } },
        env
      );
      expect(res.status).toBe(404);
    });

    it("returns 404 when the counterparty belongs to a different project in the same org", async () => {
      const db = getDb(env);
      const otherProjectId = "prj_counterparties_cross_project";
      const otherCounterpartyId = "counterparty_cross_project_iso";

      await db
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, 'Other Project', 'other-project', 'sandbox', 'active', ?)`
        )
        .bind(otherProjectId, TEST_ORG.id, TEST_USER.id)
        .run();

      await db
        .prepare(
          `INSERT INTO counterparties (
             id, organization_id, project_id, external_id, entity_type,
             display_name, email, identity, provider_data, status, created_by
           ) VALUES (?, ?, ?, ?, 'individual', 'Other Project Alice', 'other@example.com', '{}', '{}', 'active', ?)`
        )
        .bind(otherCounterpartyId, TEST_ORG.id, otherProjectId, "ext_cross_project", TEST_USER.id)
        .run();

      const res = await app.request(
        `/v1/counterparties/${otherCounterpartyId}`,
        { headers: { Authorization: authHeader } },
        env
      );
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /v1/counterparties/:counterpartyId", () => {
    it("updates displayName", async () => {
      const created = await createCounterparty({ externalId: "patch_1", displayName: "Old" });
      const cp = (await created.json()).data.counterparty;

      const res = await app.request(
        `/v1/counterparties/${cp.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: authHeader },
          body: JSON.stringify({ displayName: "New" }),
        },
        env
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.counterparty.displayName).toBe("New");
    });

    it("returns 409 when changing to an externalId in use by another counterparty", async () => {
      await createCounterparty({ externalId: "taken_1", displayName: "First" });
      const other = await createCounterparty({ externalId: "free_1", displayName: "Second" });
      const otherCp = (await other.json()).data.counterparty;

      const res = await app.request(
        `/v1/counterparties/${otherCp.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: authHeader },
          body: JSON.stringify({ externalId: "taken_1" }),
        },
        env
      );
      expect(res.status).toBe(409);
    });

    it("returns 400 on empty body", async () => {
      const created = await createCounterparty({ externalId: "patch_empty" });
      const cp = (await created.json()).data.counterparty;

      const res = await app.request(
        `/v1/counterparties/${cp.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: authHeader },
          body: JSON.stringify({}),
        },
        env
      );
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /v1/counterparties/:counterpartyId", () => {
    it("archives a counterparty", async () => {
      const created = await createCounterparty({ externalId: "archive_1" });
      const cp = (await created.json()).data.counterparty;

      const res = await app.request(
        `/v1/counterparties/${cp.id}`,
        { method: "DELETE", headers: { Authorization: authHeader } },
        env
      );
      expect(res.status).toBe(204);

      const after = await app.request(
        `/v1/counterparties/${cp.id}`,
        { headers: { Authorization: authHeader } },
        env
      );
      expect(after.status).toBe(404);
    });

    it("returns 404 for unknown id", async () => {
      const res = await app.request(
        "/v1/counterparties/counterparty_does_not_exist",
        { method: "DELETE", headers: { Authorization: authHeader } },
        env
      );
      expect(res.status).toBe(404);
    });
  });
});
