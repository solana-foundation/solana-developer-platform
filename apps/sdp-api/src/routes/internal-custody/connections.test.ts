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
const ORIGINAL_PRIVY_BYOK_ENABLED = env.PRIVY_BYOK_ENABLED;

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
  label?: string;
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
    .bind(
      input.credentialId,
      ORG.id,
      PROJECT.id,
      input.label ?? `Label ${input.credentialId}`,
      SECRET_PAYLOAD
    )
    .run();
  await db
    .prepare(
      `INSERT INTO custody_connections
         (id, organization_id, project_id, provider, scope, provider_credential_id,
          provider_credential_scope_key, status, setup_metadata,
          last_check_status, last_check_at, last_check_failure_code, activated_at, created_at)
       VALUES (?, ?, ?, 'privy', 'project', ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)`
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
      input.failureCode ? input.createdAt : null,
      input.failureCode ?? null,
      input.status === "active" ? input.createdAt : null,
      input.createdAt
    )
    .run();
}

async function makeConnectionRuntimeReady(
  connectionId: string,
  custodyWalletId: string
): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_connection_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(
        custodyWalletId,
        connectionId,
        `provider-${custodyWalletId}`,
        `address-${custodyWalletId}`
      ),
    db
      .prepare(
        `UPDATE custody_connections
         SET status = 'active', last_check_status = 'success',
             last_check_at = sdp_iso_now(), provider_account_fingerprint = ?,
             default_custody_wallet_id = ?, activated_at = sdp_iso_now()
         WHERE id = ?`
      )
      .bind(`fingerprint-${connectionId}`, custodyWalletId, connectionId),
  ]);
}

async function selectConnection(connectionId: string): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO custody_scope_defaults
         (id, organization_id, project_id, default_custody_connection_id)
       VALUES ('csd_connections_read', ?, ?, ?)`
    )
    .bind(ORG.id, PROJECT.id, connectionId)
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
    env.PRIVY_BYOK_ENABLED = ORIGINAL_PRIVY_BYOK_ENABLED;
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

  it("lists the scope's connections newest first through the safe Connection contract", async () => {
    await seedCredentialAndConnection({
      credentialId: "pcred_read_a",
      connectionId: "ccon_read_a",
      label: "Failed treasury",
      status: "failed",
      createdAt: "2026-08-01T00:00:00.000Z",
      failureCode: "invalid_credentials",
    });
    await seedCredentialAndConnection({
      credentialId: "pcred_read_b",
      connectionId: "ccon_read_b",
      label: "Pending treasury",
      status: "pending",
      createdAt: "2026-08-02T00:00:00.000Z",
      pendingWalletLabel: "Treasury wallet",
    });

    const data = await listConnections();

    expect(data).toEqual({
      connections: [
        {
          id: "ccon_read_b",
          provider: "privy",
          label: "Pending treasury",
          status: "pending",
          isDefault: false,
          isRuntimeExecutionAllowed: false,
          defaultCustodyWalletId: null,
          createdAt: "2026-08-02T00:00:00.000Z",
          activatedAt: null,
          lastCheck: null,
          pendingWalletLabel: "Treasury wallet",
        },
        {
          id: "ccon_read_a",
          provider: "privy",
          label: "Failed treasury",
          status: "failed",
          isDefault: false,
          isRuntimeExecutionAllowed: false,
          defaultCustodyWalletId: null,
          createdAt: "2026-08-01T00:00:00.000Z",
          activatedAt: null,
          lastCheck: {
            status: "failed",
            at: "2026-08-01T00:00:00.000Z",
            failureCode: "invalid_credentials",
          },
          pendingWalletLabel: null,
        },
      ],
      pagination: { limit: 20, offset: 0, total: 2 },
    });
    expect(JSON.stringify(data)).not.toContain("pcred_read_");
    expect(JSON.stringify(data)).not.toContain("providerCredential");
  });

  it("never returns secret material or unknown failure codes", async () => {
    await seedCredentialAndConnection({
      credentialId: "pcred_read_secret",
      connectionId: "ccon_read_secret",
      status: "failed",
      createdAt: "2026-08-01T00:00:00.000Z",
      failureCode: "raw_provider_stack",
    });

    const data = await listConnections();
    expect(JSON.stringify(data)).not.toContain(SECRET_PAYLOAD);
    expect(JSON.stringify(data)).not.toContain("encrypted_secret_payload");
    expect(JSON.stringify(data)).not.toContain("raw_provider_stack");
    expect(data.connections[0]?.lastCheck).toMatchObject({ failureCode: null });
  });

  it("separates effective default selection from runtime eligibility", async () => {
    env.PRIVY_BYOK_ENABLED = "true";
    await seedCredentialAndConnection({
      credentialId: "pcred_read_selected",
      connectionId: "ccon_read_selected",
      label: "Shared label",
      status: "pending",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    await makeConnectionRuntimeReady("ccon_read_selected", "cwlt_read_selected");
    await seedCredentialAndConnection({
      credentialId: "pcred_read_unselected",
      connectionId: "ccon_read_unselected",
      label: "Shared label",
      status: "pending",
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    await makeConnectionRuntimeReady("ccon_read_unselected", "cwlt_read_unselected");
    await selectConnection("ccon_read_selected");

    const data = await listConnections();
    const selected = data.connections.find((connection) => connection.id === "ccon_read_selected");
    const unselected = data.connections.find(
      (connection) => connection.id === "ccon_read_unselected"
    );

    expect(selected).toMatchObject({
      label: "Shared label",
      status: "active",
      isDefault: true,
      isRuntimeExecutionAllowed: true,
      defaultCustodyWalletId: "cwlt_read_selected",
    });
    expect(unselected).toMatchObject({
      label: "Shared label",
      status: "active",
      isDefault: false,
      isRuntimeExecutionAllowed: true,
      defaultCustodyWalletId: "cwlt_read_unselected",
    });

    await getDb(env)
      .prepare(
        `UPDATE custody_wallets SET status = 'inactive'
         WHERE id = 'cwlt_read_selected'`
      )
      .run();
    const unavailableDefault = (await listConnections()).connections.find(
      (connection) => connection.id === "ccon_read_selected"
    );
    expect(unavailableDefault).toMatchObject({
      isDefault: true,
      isRuntimeExecutionAllowed: false,
    });
  });

  it("keeps Connections visible but runtime-disabled while BYOK is off", async () => {
    env.PRIVY_BYOK_ENABLED = "false";
    await seedCredentialAndConnection({
      credentialId: "pcred_read_flag_off",
      connectionId: "ccon_read_flag_off",
      label: "Dormant treasury",
      status: "pending",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    await makeConnectionRuntimeReady("ccon_read_flag_off", "cwlt_read_flag_off");
    await selectConnection("ccon_read_flag_off");

    expect((await listConnections()).connections).toEqual([
      expect.objectContaining({
        id: "ccon_read_flag_off",
        label: "Dormant treasury",
        status: "active",
        isDefault: false,
        isRuntimeExecutionAllowed: false,
        defaultCustodyWalletId: "cwlt_read_flag_off",
      }),
    ]);
  });

  it("bounds the page size and honors offsets", async () => {
    for (let index = 0; index < 3; index += 1) {
      await seedCredentialAndConnection({
        credentialId: `pcred_read_p${index}`,
        connectionId: `ccon_read_p${index}`,
        status: "failed",
        createdAt: `2026-08-0${index + 1}T00:00:00.000Z`,
        failureCode: "pagination_fixture",
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
