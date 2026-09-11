import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import internalRpc from "@/routes/internal-rpc";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedRateLimit } from "@/test/mocks/kv";
import type { Env } from "@/types/env";

const ORG_ID = "org_internal_rpc_quota";
const ADMIN_USER_ID = "usr_internal_rpc_quota_admin";
const SESSION_ID = "ses_internal_rpc_quota";
const PROJECT_ID = "prj_internal_rpc_quota";

describe("internal RPC connectivity test quota", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);

    const db = getDb(env);
    await db.batch([
      db
        .prepare(
          "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
        )
        .bind(ORG_ID, "Internal RPC Quota Org", "internal-rpc-quota-org"),
      db
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(ADMIN_USER_ID, "internal-rpc-quota@example.com"),
      db
        .prepare(
          `INSERT INTO organization_members (id, organization_id, user_id, role, status)
           VALUES ('mem_internal_rpc_quota', ?, ?, 'admin', 'active')`
        )
        .bind(ORG_ID, ADMIN_USER_ID),
      db
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, 'Quota Project', 'quota-project', 'sandbox', 'active', ?)`
        )
        .bind(PROJECT_ID, ORG_ID, ADMIN_USER_ID),
      db
        .prepare(
          `INSERT INTO project_members (id, project_id, user_id, role)
           VALUES ('pm_internal_rpc_quota', ?, ?, 'admin')`
        )
        .bind(PROJECT_ID, ADMIN_USER_ID),
      db
        .prepare(
          `INSERT INTO sessions (id, user_id, organization_id, auth_method, expires_at)
           VALUES (?, ?, ?, 'session', '2999-01-01T00:00:00.000Z')`
        )
        .bind(SESSION_ID, ADMIN_USER_ID, ORG_ID),
    ]);
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  it("429s the connection test once the actor's shared rpc quota is exhausted", async () => {
    // The internal test dials the tenant's endpoint like the public relay
    // does, so it draws from the same `rpc` pool — an admin cannot spend what
    // `/v1/rpc` refused. The quota answers before the connection is looked
    // up, so no connection row is needed.
    await seedRateLimit(env, `metered:rpc:org:${ORG_ID}:user:${ADMIN_USER_ID}`, 100_000);

    const app = new Hono<{ Bindings: Env }>();
    app.use("*", kvStoreMiddleware());
    app.route("/", internalRpc);
    app.onError((error, c) => {
      if (error instanceof AppError) {
        return c.json(error.toResponse(), error.statusCode as 401 | 403 | 429);
      }
      throw error;
    });

    const response = await app.request(
      "/connections/rconn_any/test",
      {
        method: "POST",
        headers: { Cookie: `sdp_session=${SESSION_ID}`, "x-project-id": PROJECT_ID },
      },
      env
    );

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error.code).toBe("RATE_LIMITED");
  });
});
