import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import { databaseIdentityBoundary } from "@/middleware/database-identity";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { setupTestAuth } from "@/test/helpers/auth";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";
import internalCustody from "./index";

const ORG = "org_connection_deactivation";
const USER = "usr_connection_deactivation";
const PROJECT = "prj_connection_deactivation";
const CONNECTION = "cconn_connection_deactivation";
const CREDENTIAL = "pcred_connection_deactivation";
const SESSION = "ses_connection_deactivation";
const ORIGINAL_PRIVY_BYOK_ENABLED = env.PRIVY_BYOK_ENABLED;

const app = new Hono<{ Bindings: Env }>();
app.use("*", databaseIdentityBoundary());
app.use("*", kvStoreMiddleware());
app.use("*", async (c, next) => {
  c.set("requestId", "req_connection_deactivation");
  await next();
});
app.route("/internal/dashboard/custody", internalCustody);
app.onError((error, c) => {
  if (error instanceof AppError) return c.json(error.toResponse(), error.statusCode as 400);
  throw error;
});

function request(
  path = `/connections/${CONNECTION}/deactivate`,
  options: { method?: "GET" | "POST"; projectId?: string; authenticated?: boolean } = {}
) {
  return app.request(
    `/internal/dashboard/custody${path}`,
    {
      method: options.method ?? "POST",
      headers: {
        ...(options.authenticated === false ? {} : { Cookie: `sdp_session=${SESSION}` }),
        "X-Project-ID": options.projectId ?? PROJECT,
      },
    },
    env
  );
}

async function seedConnection(status: "pending" | "checking" | "failed" = "pending") {
  const db = getDb(env);
  await db.execute(
    `INSERT INTO provider_credentials
       (id, organization_id, project_id, provider, label, scope, source,
        storage_backend, encrypted_secret_payload, status)
     VALUES (?, ?, ?, 'privy', 'Deactivation test', 'project', 'stored',
             'encrypted_db', 'retained-ciphertext', ?)`,
    [CREDENTIAL, ORG, PROJECT, status === "failed" ? "failed_validation" : "pending"]
  );
  await db.execute(
    `INSERT INTO custody_connections
       (id, organization_id, project_id, provider, scope, provider_credential_id,
        provider_credential_scope_key, status, last_check_status, last_check_at)
     VALUES (?, ?, ?, 'privy', 'project', ?, ?, ?, ?, ?)`,
    [
      CONNECTION,
      ORG,
      PROJECT,
      CREDENTIAL,
      PROJECT,
      status,
      status === "checking" ? "running" : status === "failed" ? "failed" : null,
      status === "pending" ? null : "2026-01-01T00:00:00.000Z",
    ]
  );
}

async function lifecycleAudits() {
  return getDb(env).queryMany(
    `SELECT action, status, metadata FROM audit_logs
     WHERE organization_id = ? AND resource_type = 'custody_connection' AND resource_id = ?`,
    [ORG, CONNECTION]
  );
}

async function seedActiveConnection(walletStatus: "active" | "inactive") {
  await seedConnection();
  const db = getDb(env);
  await db.execute("UPDATE provider_credentials SET status = 'active' WHERE id = ?", [CREDENTIAL]);
  await db.execute(
    `INSERT INTO custody_wallets (id, custody_connection_id, wallet_id, public_key, status)
     VALUES ('cwlt_connection_deactivation', ?, 'provider-wallet-deactivation', 'address-deactivation', ?)`,
    [CONNECTION, walletStatus]
  );
  await db.execute(
    `UPDATE custody_connections
     SET status = 'active', last_check_status = 'success', last_check_at = sdp_iso_now(),
         activated_at = sdp_iso_now(), provider_account_fingerprint = 'retained-fingerprint',
         default_custody_wallet_id = 'cwlt_connection_deactivation'
     WHERE id = ?`,
    [CONNECTION]
  );
  await db.execute(
    `INSERT INTO custody_scope_defaults
       (id, organization_id, project_id, default_custody_connection_id)
     VALUES ('csd_connection_deactivation', ?, ?, ?)`,
    [ORG, PROJECT, CONNECTION]
  );
}

async function persistedState() {
  const db = getDb(env);
  return {
    connection: await db.queryOne("SELECT * FROM custody_connections WHERE id = ?", [CONNECTION]),
    credential: await db.queryOne("SELECT * FROM provider_credentials WHERE id = ?", [CREDENTIAL]),
    wallets: await db.queryMany("SELECT * FROM custody_wallets WHERE custody_connection_id = ?", [
      CONNECTION,
    ]),
    selection: await db.queryOne("SELECT * FROM custody_scope_defaults WHERE project_id = ?", [
      PROJECT,
    ]),
  };
}

describe("custody Connection deactivation", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await db.execute(
      `INSERT INTO organizations (id, name, slug, tier, status)
      VALUES (?, 'Deactivation', 'connection-deactivation', 'enterprise', 'active')`,
      [ORG]
    );
    await db.execute(
      `INSERT INTO users (id, email, email_verified, status)
      VALUES (?, 'connection-deactivation@example.com', 1, 'active')`,
      [USER]
    );
    await db.execute(
      `INSERT INTO organization_members (id, organization_id, user_id, role, status)
      VALUES ('mem_connection_deactivation', ?, ?, 'admin', 'active')`,
      [ORG, USER]
    );
    await db.execute(
      `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
      VALUES (?, ?, 'Deactivation', 'connection-deactivation', 'sandbox', 'active', ?)`,
      [PROJECT, ORG, USER]
    );
    await db.execute(
      `INSERT INTO project_members (id, project_id, user_id, role)
      VALUES ('pm_connection_deactivation', ?, ?, 'admin')`,
      [PROJECT, USER]
    );
    await db.execute(
      `INSERT INTO sessions (id, user_id, organization_id, auth_method, expires_at)
      VALUES (?, ?, ?, 'session', '2999-01-01T00:00:00.000Z')`,
      [SESSION, USER, ORG]
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("Unexpected Provider I/O");
      })
    );
  });

  afterEach(async () => {
    env.PRIVY_BYOK_ENABLED = ORIGINAL_PRIVY_BYOK_ENABLED;
    vi.unstubAllGlobals();
    await clearKVStores(env);
  });

  it.each(["pending", "checking"] as const)(
    "rejects unfinished %s installation without cancellation",
    async (status) => {
      await seedConnection(status);
      const persisted = await persistedState();
      const before = await (await request(`/connections/${CONNECTION}`, { method: "GET" })).json();
      const result = await request();
      expect(result.status).toBe(409);
      expect(await result.json()).toMatchObject({ error: { code: "CONFLICT" } });
      const after = await (await request(`/connections/${CONNECTION}`, { method: "GET" })).json();
      expect(after.data).toEqual(before.data);
      expect(await persistedState()).toEqual(persisted);
      expect(await lifecycleAudits()).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it("rejects a fingerprint-pinned current completion lease without delegating", async () => {
    await seedConnection("checking");
    await getDb(env).execute(
      "UPDATE custody_connections SET provider_account_fingerprint = 'pinned-account', last_check_at = sdp_iso_now() WHERE id = ?",
      [CONNECTION]
    );
    const before = await persistedState();
    const result = await request();
    expect(result.status).toBe(409);
    expect((await result.json()).error).toEqual({
      code: "CONFLICT",
      message: "Provider credential installation is unavailable",
    });
    expect(await persistedState()).toEqual(before);
    expect(await lifecycleAudits()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("deactivates a failed Connection and replays its current safe projection once", async () => {
    await seedConnection("failed");
    const result = await request();
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body.data).toEqual({
      custodyConnection: {
        id: CONNECTION,
        provider: "privy",
        label: "Deactivation test",
        status: "deactivated",
        completion: null,
        isDefault: false,
        canComplete: false,
        canReplaceCredentials: false,
        canCancel: false,
      },
    });
    const replay = await request();
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toEqual(body.data);
    const read = await request(`/connections/${CONNECTION}`, { method: "GET" });
    expect((await read.json()).data.connection).toEqual(body.data.custodyConnection);
    expect(await lifecycleAudits()).toMatchObject([{ action: "deactivate", status: "success" }]);
    expect(
      await getDb(env).queryOne(
        "SELECT status, encrypted_secret_payload FROM provider_credentials WHERE id = ?",
        [CREDENTIAL]
      )
    ).toEqual({ status: "failed_validation", encrypted_secret_payload: "retained-ciphertext" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks active owned wallets without changing the Connection, Credential, wallets, or default", async () => {
    await seedActiveConnection("active");
    const before = await persistedState();
    const result = await request();
    expect(result.status).toBe(409);
    expect((await result.json()).error).toEqual({
      code: "CONFLICT",
      message: "Connection cannot be deactivated while it has active wallets",
    });
    expect(await persistedState()).toEqual(before);
    expect(await lifecycleAudits()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves inactive wallets, the current Credential, and the selected default while runtime is off", async () => {
    await seedActiveConnection("inactive");
    env.PRIVY_BYOK_ENABLED = "false";
    await getDb(env).execute("UPDATE organizations SET settings = ?::jsonb WHERE id = ?", [
      JSON.stringify({ providerOverrides: { custody: { privy: false } } }),
      ORG,
    ]);
    const before = await persistedState();
    const result = await request();
    expect(result.status).toBe(200);
    expect((await result.json()).data.custodyConnection).toMatchObject({
      id: CONNECTION,
      status: "deactivated",
      canComplete: false,
      canCancel: false,
      canReplaceCredentials: false,
    });
    const after = await persistedState();
    expect(after.credential).toEqual(before.credential);
    expect(after.wallets).toEqual(before.wallets);
    expect(after.selection).toEqual(before.selection);
    expect(after.connection).toMatchObject({
      ...before.connection,
      status: "deactivated",
      deactivated_at: expect.any(String),
      updated_at: expect.any(String),
    });
    expect(await lifecycleAudits()).toMatchObject([{ action: "deactivate", status: "success" }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("serializes simultaneous requests to one transition and one lifecycle audit", async () => {
    await seedConnection("failed");
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies[0].data).toEqual(bodies[1].data);
    expect(await lifecycleAudits()).toMatchObject([{ action: "deactivate", status: "success" }]);
  });

  it("restores the Connection and preserves related state when its deactivation transaction fails", async () => {
    await seedActiveConnection("inactive");
    const persisted = await persistedState();
    const before = await request(`/connections/${CONNECTION}`, { method: "GET" });
    expect(before.status).toBe(200);
    const beforeBody = await before.json();
    const db = getDb(env);
    const runTransaction = db.transaction.bind(db);
    let updatedConnection: unknown;
    const transaction = vi.spyOn(db, "transaction").mockImplementationOnce((callback) =>
      runTransaction(async (tx) => {
        await callback(tx);
        updatedConnection = await tx.queryOne(
          "SELECT status, deactivated_at FROM custody_connections WHERE id = ?",
          [CONNECTION]
        );
        await tx.execute("SELECT 1 / 0");
      })
    );
    try {
      const response = await request();
      expect(response.status).toBe(503);
      expect((await response.json()).error).toEqual({
        code: "PROVIDER_UNAVAILABLE",
        message: "Connection deactivation outcome is temporarily unknown",
      });
      expect(updatedConnection).toEqual({
        status: "deactivated",
        deactivated_at: expect.any(String),
      });
    } finally {
      transaction.mockRestore();
    }
    const after = await request(`/connections/${CONNECTION}`, { method: "GET" });
    expect(after.status).toBe(200);
    expect((await after.json()).data).toEqual(beforeBody.data);
    expect(await persistedState()).toEqual(persisted);
    expect(await lifecycleAudits()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rechecks an active wallet persisted after the initial walletless check", async () => {
    await seedActiveConnection("inactive");
    let signalLocked: () => void = () => undefined;
    let releaseWalletCreation: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseWalletCreation = resolve;
    });
    const walletCreation = getDb(env).transaction(async (tx) => {
      await tx.queryOne("SELECT id FROM projects WHERE id = ? FOR UPDATE", [PROJECT]);
      signalLocked();
      await released;
      await tx.execute(
        `INSERT INTO custody_wallets (id, custody_connection_id, wallet_id, public_key, status)
         VALUES ('cwlt_racing_creation', ?, 'racing-provider-wallet', 'racing-address', 'active')`,
        [CONNECTION]
      );
    });
    await locked;
    const response = request();
    try {
      await vi.waitFor(
        async () => {
          expect(
            await getDb(env).queryOne(
              `SELECT id FROM audit_logs WHERE organization_id = ?
           AND metadata::jsonb -> 'target' ->> 'resourceId' = ?`,
              [ORG, CONNECTION]
            )
          ).not.toBeNull();
        },
        { timeout: 5000 }
      );
    } finally {
      releaseWalletCreation();
      await walletCreation;
    }
    const result = await response;
    expect(result.status).toBe(409);
    expect((await result.json()).error).toEqual({
      code: "CONFLICT",
      message: "Connection cannot be deactivated while it has active wallets",
    });
    expect((await persistedState()).connection).toMatchObject({
      status: "active",
      deactivated_at: null,
    });
    expect(await lifecycleAudits()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["unauthenticated", { authenticated: false }, 401],
    ["missing Project", { projectId: "" }, 400],
    ["inaccessible Project", { projectId: "prj_foreign" }, 403],
  ] as const)("rejects %s requests before target mutation", async (_name, options, status) => {
    await seedConnection("failed");
    const before = await persistedState();
    expect((await request(undefined, options)).status).toBe(status);
    expect(await persistedState()).toEqual(before);
    expect(await lifecycleAudits()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires custody administration even for a completed replay", async () => {
    await seedConnection("failed");
    await getDb(env).execute(
      "UPDATE custody_connections SET status = 'deactivated', deactivated_at = sdp_iso_now() WHERE id = ?",
      [CONNECTION]
    );
    await getDb(env).execute("UPDATE organization_members SET role = 'member' WHERE user_id = ?", [
      USER,
    ]);
    const before = await persistedState();
    expect((await request()).status).toBe(403);
    expect(await persistedState()).toEqual(before);
    expect(await lifecycleAudits()).toEqual([]);
  });

  it("rejects API keys before resource mutation", async () => {
    await seedConnection("failed");
    const before = await persistedState();
    const { header } = await setupTestAuth(env);
    const response = await app.request(
      `/internal/dashboard/custody/connections/${CONNECTION}/deactivate`,
      { method: "POST", headers: { Authorization: header, "X-Project-ID": PROJECT } },
      env
    );
    expect(response.status).toBe(403);
    expect(await persistedState()).toEqual(before);
    expect(await lifecycleAudits()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("hides a Connection outside the authorized Project just like an unknown target", async () => {
    await seedConnection("failed");
    const db = getDb(env);
    await db.execute(
      `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
      VALUES ('prj_other_deactivation', ?, 'Other', 'other', 'sandbox', 'active', ?)`,
      [ORG, USER]
    );
    await db.execute(
      `INSERT INTO project_members (id, project_id, user_id, role)
      VALUES ('pm_other_deactivation', 'prj_other_deactivation', ?, 'admin')`,
      [USER]
    );
    const before = await persistedState();
    const foreign = await request(undefined, { projectId: "prj_other_deactivation" });
    const unknown = await request("/connections/cconn_unknown/deactivate", {
      projectId: "prj_other_deactivation",
    });
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect((await foreign.json()).error).toEqual((await unknown.json()).error);
    expect(await persistedState()).toEqual(before);
    expect(await lifecycleAudits()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
