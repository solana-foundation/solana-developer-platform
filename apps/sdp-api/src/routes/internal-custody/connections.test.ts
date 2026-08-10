import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import type { ClerkJwtPayload } from "@/lib/clerk-token";
import { AppError } from "@/lib/errors";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";
import internalCustody from "./index";

const ORG = {
  id: "org_connections_read",
  slug: "connections-read",
  clerkId: "clerk_org_connections_read",
};
const PROJECT = { id: "prj_connections_read", slug: "connections-read-project" };
const USER = {
  id: "usr_connections_read",
  email: "connections-read@example.com",
  clerkId: "clerk_connections_read",
};
const SECRET_PAYLOAD = "encrypted-connections-read-secret";

function encodeJwtPart(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function buildApp(options: { injectJwt?: boolean } = {}) {
  const payload: ClerkJwtPayload = {
    sub: USER.clerkId,
    org_id: ORG.clerkId,
    org_role: "org:admin",
    email: USER.email,
  };
  const token = `${encodeJwtPart({ alg: "RS256", typ: "JWT" })}.${encodeJwtPart(payload)}.signature`;
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", kvStoreMiddleware());
  app.use("*", async (c, next) => {
    if (options.injectJwt !== false) {
      c.set("verifiedClerkJwt", { token, payload });
    }
    c.set("requestId", "req_connections_read");
    await next();
  });
  app.route("/internal/dashboard/custody", internalCustody);
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(
        { error: error.toResponse().error, meta: { requestId: c.get("requestId") } },
        error.statusCode as 400
      );
    }
    throw error;
  });

  return { app, token };
}

async function seedScope(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG.id, "Connections Read", ORG.slug, "enterprise", "active"),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(USER.id, USER.email, 1, "active"),
    db
      .prepare(
        `INSERT INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
         VALUES (?, 'clerk', ?, ?, ?)`
      )
      .bind("aui_connections_read", USER.clerkId, USER.id, USER.email),
    db
      .prepare(
        `INSERT INTO auth_organization_identities (id, provider, provider_org_id, organization_id, slug)
         VALUES (?, 'clerk', ?, ?, ?)`
      )
      .bind("aoi_connections_read", ORG.clerkId, ORG.id, ORG.slug),
    db
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES (?, ?, ?, 'admin', 'active')`
      )
      .bind("mem_connections_read", ORG.id, USER.id),
    db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, 'sandbox', 'active', ?)`
      )
      .bind(PROJECT.id, ORG.id, "Connections Read", PROJECT.slug, USER.id),
    db
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role)
         VALUES (?, ?, ?, 'admin')`
      )
      .bind("pm_connections_read", PROJECT.id, USER.id),
  ]);
}

async function seedCredentialAndConnection(input: {
  credentialId: string;
  connectionId: string;
  status: string;
  createdAt: string;
  failureCode?: string;
  pendingWalletLabel?: string;
}): Promise<void> {
  const db = getDb(env);
  await db
    .prepare(
      `INSERT INTO provider_credentials
         (id, organization_id, project_id, provider, label, scope, source, storage_backend,
          encrypted_secret_payload, status)
       VALUES (?, ?, ?, 'privy', ?, 'project', 'stored', 'encrypted_db', ?, 'active')`
    )
    .bind(input.credentialId, ORG.id, PROJECT.id, `Label ${input.credentialId}`, SECRET_PAYLOAD)
    .run();
  await db
    .prepare(
      `INSERT INTO custody_connections
         (id, organization_id, project_id, provider, scope, provider_credential_id,
          provider_credential_scope_key, status, setup_metadata,
          last_check_status, last_check_failure_code, activated_at, created_at)
       VALUES (?, ?, ?, 'privy', 'project', ?, ?, ?, ?::jsonb, ?, ?, ?, ?)`
    )
    .bind(
      input.connectionId,
      ORG.id,
      PROJECT.id,
      input.credentialId,
      PROJECT.id,
      input.status,
      JSON.stringify(
        input.pendingWalletLabel ? { pendingWalletLabel: input.pendingWalletLabel } : {}
      ),
      input.failureCode ? "failed" : null,
      input.failureCode ?? null,
      input.status === "active" ? input.createdAt : null,
      input.createdAt
    )
    .run();
}

async function listConnections(query = ""): Promise<{
  connections: Array<Record<string, unknown>>;
  pagination: { limit: number; offset: number; total: number };
}> {
  const { app, token } = buildApp();
  const response = await app.request(
    `/internal/dashboard/custody/connections${query}`,
    { headers: { Authorization: `Bearer ${token}`, "X-Project-ID": PROJECT.id } },
    env
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: never };
  return body.data;
}

describe("internal custody connections", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedScope();
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  it("refuses a caller with no dashboard session", async () => {
    const { app } = buildApp({ injectJwt: false });
    const response = await app.request(
      "/internal/dashboard/custody/connections",
      { headers: { "X-Project-ID": PROJECT.id } },
      env
    );
    expect(response.status).toBeGreaterThanOrEqual(401);
  });

  it("lists the scope's connections newest first with lifecycle and safe credential fields", async () => {
    await seedCredentialAndConnection({
      credentialId: "pcred_read_a",
      connectionId: "ccon_read_a",
      status: "failed",
      createdAt: "2026-08-01T00:00:00.000Z",
      failureCode: "invalid_credentials",
    });
    await seedCredentialAndConnection({
      credentialId: "pcred_read_b",
      connectionId: "ccon_read_b",
      status: "pending",
      createdAt: "2026-08-02T00:00:00.000Z",
      pendingWalletLabel: "Treasury wallet",
    });

    const data = await listConnections();

    expect(data.pagination.total).toBe(2);
    expect(data.connections.map((c) => c.id)).toEqual(["ccon_read_b", "ccon_read_a"]);

    const pending = data.connections[0] as Record<string, unknown>;
    expect(pending.status).toBe("pending");
    expect(pending.pendingWalletLabel).toBe("Treasury wallet");
    expect((pending.providerCredential as Record<string, unknown>).label).toBe(
      "Label pcred_read_b"
    );

    const failed = data.connections[1] as Record<string, unknown>;
    expect((failed.lastCheck as Record<string, unknown>).failureCode).toBe("invalid_credentials");
  });

  it("never returns secret material in any field", async () => {
    await seedCredentialAndConnection({
      credentialId: "pcred_read_secret",
      connectionId: "ccon_read_secret",
      status: "pending",
      createdAt: "2026-08-01T00:00:00.000Z",
    });

    const data = await listConnections();
    expect(JSON.stringify(data)).not.toContain(SECRET_PAYLOAD);
    expect(JSON.stringify(data)).not.toContain("encrypted_secret_payload");
  });

  it("bounds the page size and honors offsets", async () => {
    for (let index = 0; index < 3; index += 1) {
      await seedCredentialAndConnection({
        credentialId: `pcred_read_p${index}`,
        connectionId: `ccon_read_p${index}`,
        status: "pending",
        createdAt: `2026-08-0${index + 1}T00:00:00.000Z`,
      });
    }

    const page = await listConnections("?limit=2&offset=1");
    expect(page.connections).toHaveLength(2);
    expect(page.pagination).toEqual({ limit: 2, offset: 1, total: 3 });

    const clamped = await listConnections("?limit=9999");
    expect(clamped.pagination.limit).toBe(50);

    // Fractional values must be truncated before they reach PostgreSQL.
    const fractional = await listConnections("?limit=1.5&offset=1.9");
    expect(fractional.pagination).toEqual({ limit: 1, offset: 1, total: 3 });

    // Infinity survives `|| 0` and must not reach the SQL OFFSET.
    const infinite = await listConnections("?limit=Infinity&offset=1e309");
    expect(infinite.pagination).toEqual({ limit: 50, offset: 0, total: 3 });

    // A finite offset past MAX_SAFE_INTEGER would overflow the bigint the SQL
    // OFFSET binds to; the clamp turns it into an empty page instead of a 500.
    const oversized = await listConnections("?offset=1e308");
    expect(oversized.pagination).toEqual({
      limit: 20,
      offset: Number.MAX_SAFE_INTEGER,
      total: 3,
    });
    expect(oversized.connections).toHaveLength(0);
  });

  it("does not leak another project's connections", async () => {
    const db = getDb(env);
    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES ('prj_conn_other', ?, 'Other', 'connections-other', 'sandbox', 'active', ?)`
      )
      .bind(ORG.id, USER.id)
      .run();
    await db
      .prepare(
        `INSERT INTO provider_credentials
           (id, organization_id, project_id, provider, label, scope, source, storage_backend,
            encrypted_secret_payload, status)
         VALUES ('pcred_other', ?, 'prj_conn_other', 'privy', 'Other', 'project', 'stored',
                 'encrypted_db', 'x', 'active')`
      )
      .bind(ORG.id)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_connections
           (id, organization_id, project_id, provider, scope, provider_credential_id,
            provider_credential_scope_key, status)
         VALUES ('ccon_other', ?, 'prj_conn_other', 'privy', 'project', 'pcred_other',
                 'prj_conn_other', 'pending')`
      )
      .bind(ORG.id)
      .run();

    const data = await listConnections();
    expect(data.pagination.total).toBe(0);
  });
});
