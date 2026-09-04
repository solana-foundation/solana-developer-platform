import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import type { ClerkJwtPayload } from "@/lib/clerk-token";
import { AppError } from "@/lib/errors";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { createCredentialSecretStore } from "@/services/credential-secret-store";
import { getPrivyProviderAccountFingerprint } from "@/services/custody/privy-credential";
import { ProviderCredentialStore } from "@/services/stores/provider-credential.store";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";
import internalCustody from "./index";

const ORGANIZATION_ID = "org_provider_credential_lifecycle";
const USER_ID = "usr_provider_credential_lifecycle";
const PROJECT_A_ID = "prj_provider_credential_lifecycle_a";
const PROJECT_B_ID = "prj_provider_credential_lifecycle_b";
const CREDENTIAL_ID = "pcred_provider_credential_lifecycle";
const CONNECTION_A_ID = "cconn_provider_credential_lifecycle_a";
const CONNECTION_B_ID = "cconn_provider_credential_lifecycle_b";
const APP_ID = "privy-lifecycle-app";
const APP_SECRET = "privy-lifecycle-secret";
const ORIGINAL_SECRET_BACKEND = env.CREDENTIAL_SECRET_STORE_BACKEND;
const ORIGINAL_ENCRYPTION_KEY = env.CUSTODY_ENCRYPTION_KEY;
const ORIGINAL_GCP_PROJECT_ID = env.GCP_SECRET_MANAGER_PROJECT_ID;

function encodeJwtPart(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function buildApp() {
  const payload: ClerkJwtPayload = {
    sub: "clerk_provider_credential_lifecycle",
    org_id: "clerk_org_provider_credential_lifecycle",
    org_role: "org:admin",
    email: "provider-credential-lifecycle@example.com",
  };
  const token = `${encodeJwtPart({ alg: "RS256", typ: "JWT" })}.${encodeJwtPart(payload)}.signature`;
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", kvStoreMiddleware());
  app.use("*", async (c, next) => {
    c.set("verifiedClerkJwt", { token, payload });
    c.set("requestId", "req_provider_credential_lifecycle");
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

async function seedProject(id: string, suffix: string, member = true): Promise<void> {
  const db = getDb(env);
  await db
    .prepare(
      `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
       VALUES (?, ?, ?, ?, 'sandbox', 'active', ?)`
    )
    .bind(id, ORGANIZATION_ID, `Lifecycle ${suffix}`, `lifecycle-${suffix}`, USER_ID)
    .run();
  if (member) {
    await db
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role)
         VALUES (?, ?, ?, 'admin')`
      )
      .bind(`pm_lifecycle_${suffix}`, id, USER_ID)
      .run();
  }
}

async function seedActor(secondProjectMember = true): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(
        ORGANIZATION_ID,
        "Credential Lifecycle",
        "credential-lifecycle",
        "enterprise",
        "active"
      ),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER_ID, "provider-credential-lifecycle@example.com"),
    db
      .prepare(
        `INSERT INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
         VALUES (?, 'clerk', ?, ?, ?)`
      )
      .bind(
        "aui_provider_credential_lifecycle",
        "clerk_provider_credential_lifecycle",
        USER_ID,
        "provider-credential-lifecycle@example.com"
      ),
    db
      .prepare(
        `INSERT INTO auth_organization_identities
           (id, provider, provider_org_id, organization_id, slug)
         VALUES (?, 'clerk', ?, ?, ?)`
      )
      .bind(
        "aoi_provider_credential_lifecycle",
        "clerk_org_provider_credential_lifecycle",
        ORGANIZATION_ID,
        "credential-lifecycle"
      ),
    db
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES (?, ?, ?, 'admin', 'active')`
      )
      .bind("mem_provider_credential_lifecycle", ORGANIZATION_ID, USER_ID),
  ]);
  await seedProject(PROJECT_A_ID, "a");
  await seedProject(PROJECT_B_ID, "b", secondProjectMember);
}

async function seedActiveSharedCredential(): Promise<void> {
  const stored = await createCredentialSecretStore(env).write({
    orgId: ORGANIZATION_ID,
    provider: "privy",
    providerCredentialId: CREDENTIAL_ID,
    payload: { appId: APP_ID, appSecret: APP_SECRET },
  });
  const fingerprint = await getPrivyProviderAccountFingerprint(APP_ID);
  const db = getDb(env);
  await db
    .prepare(
      `INSERT INTO provider_credentials (
           id, organization_id, project_id, provider, label, scope, source,
           storage_backend, secret_ref, secret_version_ref, encrypted_secret_payload,
           display_metadata, status, credential_version, created_by, last_validated_at
         ) VALUES (
           ?, ?, NULL, 'privy', 'Shared Privy', 'organization', 'stored',
           ?, ?, ?, ?, ?::jsonb, 'active', 1, ?, sdp_iso_now()
         )`
    )
    .bind(
      CREDENTIAL_ID,
      ORGANIZATION_ID,
      stored.storageBackend,
      stored.secretRef ?? null,
      stored.secretVersionRef ?? null,
      stored.encryptedSecretPayload ?? null,
      JSON.stringify({ appIdSuffix: APP_ID.slice(-4) }),
      USER_ID
    )
    .run();
  for (const [connectionId, projectId, walletId] of [
    [CONNECTION_A_ID, PROJECT_A_ID, "cwlt_provider_credential_lifecycle_a"],
    [CONNECTION_B_ID, PROJECT_B_ID, "cwlt_provider_credential_lifecycle_b"],
  ] as const) {
    await db
      .prepare(
        `INSERT INTO custody_connections (
             id, organization_id, project_id, provider, scope, provider_credential_id,
             provider_credential_scope_key, provider_account_fingerprint, status, created_by
           ) VALUES (
             ?, ?, ?, 'privy', 'project', ?, '__organization__', ?, 'pending', ?
           )`
      )
      .bind(connectionId, ORGANIZATION_ID, projectId, CREDENTIAL_ID, fingerprint, USER_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_connection_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(walletId, connectionId, `provider-${walletId}`, `address-${walletId}`)
      .run();
    await db
      .prepare(
        `UPDATE custody_connections
         SET status = 'active', last_check_status = 'success', last_check_at = sdp_iso_now(),
             default_custody_wallet_id = ?, activated_at = sdp_iso_now()
         WHERE id = ?`
      )
      .bind(walletId, connectionId)
      .run();
  }
}

async function lifecycleRequest(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; key?: string } = {}
): Promise<Response> {
  const { app, token } = buildApp();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "X-Project-ID": PROJECT_A_ID,
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.key) headers["Idempotency-Key"] = options.key;
  return app.request(
    `/internal/dashboard/custody${path}`,
    {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    },
    env
  );
}

describe("provider credential lifecycle", () => {
  beforeEach(async () => {
    env.CREDENTIAL_SECRET_STORE_BACKEND = "encrypted_db";
    env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
    await seedTestDatabase(env);
    await seedActor();
    await seedActiveSharedCredential();
  });

  afterEach(async () => {
    env.CREDENTIAL_SECRET_STORE_BACKEND = ORIGINAL_SECRET_BACKEND;
    env.CUSTODY_ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
    env.GCP_SECRET_MANAGER_PROJECT_ID = ORIGINAL_GCP_PROJECT_ID;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await clearKVStores(env);
  });

  it("returns the exact credential and complete authorized impact", async () => {
    const response = await lifecycleRequest(`/connections/${CONNECTION_A_ID}/provider-credential`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      providerCredential: { id: CREDENTIAL_ID, status: "active", source: "stored" },
      rotationCandidate: null,
      impact: {
        projects: [
          { id: PROJECT_A_ID, name: "Lifecycle a" },
          { id: PROJECT_B_ID, name: "Lifecycle b" },
        ],
        connections: [
          { id: CONNECTION_A_ID, projectId: PROJECT_A_ID },
          { id: CONNECTION_B_ID, projectId: PROJECT_B_ID },
        ],
      },
      rollback: null,
    });
    expect(JSON.stringify(body)).not.toContain(APP_SECRET);
  });

  it("denies shared impact before disclosure when one project is inaccessible", async () => {
    await getDb(env)
      .prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
      .bind(PROJECT_B_ID, USER_ID)
      .run();

    const response = await lifecycleRequest(`/connections/${CONNECTION_A_ID}/provider-credential`);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "FORBIDDEN", message: "Requested project is not accessible" },
    });
  });

  it("exposes runtime credentials as deployment-managed state and rejects rotation", async () => {
    await getDb(env)
      .prepare(
        `UPDATE provider_credentials
         SET source = 'runtime', storage_backend = 'runtime_env', encrypted_secret_payload = NULL
         WHERE id = ?`
      )
      .bind(CREDENTIAL_ID)
      .run();

    const read = await lifecycleRequest(`/connections/${CONNECTION_A_ID}/provider-credential`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      data: { providerCredential: { id: CREDENTIAL_ID, source: "runtime" } },
    });

    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    const rotate = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-runtime-credential",
      body: { fields: { appId: APP_ID, appSecret: "new-secret" } },
    });
    expect(rotate.status).toBe(409);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("hides a foreign-project credential before inspecting its lifecycle", async () => {
    const credentialId = "pcred_foreign_project_root";
    await getDb(env)
      .prepare(
        `INSERT INTO provider_credentials (
           id, organization_id, project_id, provider, label, scope, source,
           storage_backend, status, credential_version, created_by
         ) VALUES (?, ?, ?, 'privy', 'Foreign Privy', 'project', 'runtime',
                   'runtime_env', 'active', 1, ?)`
      )
      .bind(credentialId, ORGANIZATION_ID, PROJECT_B_ID, USER_ID)
      .run();
    const secretLookup = vi.spyOn(
      ProviderCredentialStore.prototype,
      "findLifecycleCredentialWithSecret"
    );
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);

    const response = await lifecycleRequest(
      `/provider-credentials/${credentialId}/complete-rotation`,
      { method: "POST" }
    );

    expect(response.status).toBe(404);
    expect(secretLookup).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("rotates every referencing connection after one continuity check", async () => {
    const providerFetch = vi.fn().mockResolvedValue(Response.json({ data: [] }));
    vi.stubGlobal("fetch", providerFetch);

    const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-shared-credential",
      body: { fields: { appId: `  ${APP_ID}  `, appSecret: "new-secret" } },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { providerCredential: { id: string; status: string }; rotation: { status: string } };
    };
    expect(body.data).toMatchObject({
      providerCredential: { status: "active" },
      rotation: { status: "success" },
    });
    expect(body.data.providerCredential.id).not.toBe(CREDENTIAL_ID);
    expect(providerFetch).toHaveBeenCalledTimes(1);

    const rows = await getDb(env).queryMany<{
      id: string;
      status: string;
      secret_retention_expires_at: string | null;
    }>(
      `SELECT id, status, secret_retention_expires_at
       FROM provider_credentials
       ORDER BY credential_version, id`
    );
    expect(rows).toEqual([
      expect.objectContaining({
        id: CREDENTIAL_ID,
        status: "retired",
        secret_retention_expires_at: expect.any(String),
      }),
      expect.objectContaining({
        id: body.data.providerCredential.id,
        status: "active",
        secret_retention_expires_at: null,
      }),
    ]);
    expect(
      await getDb(env).queryMany<{ provider_credential_id: string }>(
        `SELECT provider_credential_id FROM custody_connections ORDER BY id`
      )
    ).toEqual([
      { provider_credential_id: body.data.providerCredential.id },
      { provider_credential_id: body.data.providerCredential.id },
    ]);
  });

  it("rejects only the candidate when Privy rejects the new credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

    const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-invalid-credential",
      body: { fields: { appId: APP_ID, appSecret: "invalid-secret" } },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        providerCredential: { status: "failed_validation" },
        rotation: { status: "failed", code: "invalid_credentials" },
      },
    });
    expect(
      await getDb(env).queryMany<{ id: string; status: string }>(
        "SELECT id, status FROM provider_credentials ORDER BY credential_version, id"
      )
    ).toEqual([
      { id: CREDENTIAL_ID, status: "active" },
      expect.objectContaining({ status: "failed_validation" }),
    ]);
    expect(
      await getDb(env).queryMany<{ provider_credential_id: string }>(
        "SELECT provider_credential_id FROM custody_connections ORDER BY id"
      )
    ).toEqual([
      { provider_credential_id: CREDENTIAL_ID },
      { provider_credential_id: CREDENTIAL_ID },
    ]);
  });

  it("persists an uncertain candidate and resumes it without another secret submission", async () => {
    const providerFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    vi.stubGlobal("fetch", providerFetch);

    const first = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-retry-unknown",
      body: { fields: { appId: APP_ID, appSecret: "new-secret" } },
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      data: { providerCredential: { id: string; status: string }; rotation: { status: string } };
    };
    expect(firstBody.data).toMatchObject({
      providerCredential: { status: "pending" },
      rotation: { status: "retry_unknown", code: "provider_response_unknown" },
    });

    const completed = await lifecycleRequest(
      `/provider-credentials/${firstBody.data.providerCredential.id}/complete-rotation`,
      { method: "POST" }
    );
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      data: {
        providerCredential: { id: firstBody.data.providerCredential.id, status: "active" },
        rotation: { status: "success" },
      },
    });
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it("returns a conflict when cancellation wins before candidate secret access", async () => {
    const providerFetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", providerFetch);
    const rotated = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-before-secret-access-cancel",
      body: { fields: { appId: APP_ID, appSecret: "new-secret" } },
    });
    const rotatedBody = (await rotated.json()) as {
      data: { providerCredential: { id: string } };
    };
    const candidateId = rotatedBody.data.providerCredential.id;
    const findWithSecret = ProviderCredentialStore.prototype.findLifecycleCredentialWithSecret;
    let releaseSecretLookup: () => void = () => undefined;
    let markSecretLookupStarted: () => void = () => undefined;
    const secretLookupStarted = new Promise<void>((resolve) => {
      markSecretLookupStarted = resolve;
    });
    const secretLookupReleased = new Promise<void>((resolve) => {
      releaseSecretLookup = resolve;
    });
    let blocked = false;
    vi.spyOn(
      ProviderCredentialStore.prototype,
      "findLifecycleCredentialWithSecret"
    ).mockImplementation(async function (this: ProviderCredentialStore, organizationId, id) {
      if (!blocked && id === candidateId) {
        blocked = true;
        markSecretLookupStarted();
        await secretLookupReleased;
      }
      return findWithSecret.call(this, organizationId, id);
    });

    const completion = lifecycleRequest(`/provider-credentials/${candidateId}/complete-rotation`, {
      method: "POST",
    });
    await secretLookupStarted;
    const cancellation = await lifecycleRequest(`/provider-credentials/${candidateId}/deactivate`, {
      method: "POST",
    });
    releaseSecretLookup();

    expect(cancellation.status).toBe(200);
    expect((await completion).status).toBe(409);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("replays a completed rotation by idempotency key without another provider call", async () => {
    const providerFetch = vi.fn().mockResolvedValue(Response.json({ data: [] }));
    vi.stubGlobal("fetch", providerFetch);
    const request = {
      method: "POST" as const,
      key: "rotate-replay",
      body: { fields: { appId: APP_ID, appSecret: "new-secret" } },
    };

    const first = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, request);
    const firstBody = (await first.json()) as {
      data: { providerCredential: { id: string }; rotation: { status: string } };
    };
    const replay = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, request);

    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      data: {
        providerCredential: { id: firstBody.data.providerCredential.id, status: "active" },
        rotation: { status: "success" },
      },
    });
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("replays the exact successful rotation after a later rotation", async () => {
    const providerFetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(Response.json({ data: [] })));
    vi.stubGlobal("fetch", providerFetch);
    const firstRequest = {
      method: "POST" as const,
      key: "rotate-historical-replay",
      body: { fields: { appId: APP_ID, appSecret: "first-new-secret" } },
    };
    const first = await lifecycleRequest(
      `/provider-credentials/${CREDENTIAL_ID}/rotate`,
      firstRequest
    );
    const firstBody = (await first.json()) as {
      data: { providerCredential: { id: string } };
    };
    const firstCandidateId = firstBody.data.providerCredential.id;

    const second = await lifecycleRequest(`/provider-credentials/${firstCandidateId}/rotate`, {
      method: "POST",
      key: "rotate-after-historical-replay",
      body: { fields: { appId: APP_ID, appSecret: "second-new-secret" } },
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      data: { providerCredential: { status: "active" }, rotation: { status: "success" } },
    });

    const replay = await lifecycleRequest(
      `/provider-credentials/${CREDENTIAL_ID}/rotate`,
      firstRequest
    );

    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      data: {
        providerCredential: { id: firstCandidateId, status: "retired" },
        rotation: { status: "success" },
      },
    });
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(
      await getDb(env).queryOne<{ count: number }>(
        "SELECT COUNT(*) AS count FROM provider_credentials"
      )
    ).toEqual({ count: 3 });
  });

  it("reauthorizes the active result before reporting an idempotency mismatch", async () => {
    const providerFetch = vi.fn().mockResolvedValue(Response.json({ data: [] }));
    vi.stubGlobal("fetch", providerFetch);
    await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-before-membership-loss",
      body: { fields: { appId: APP_ID, appSecret: "new-secret" } },
    });
    await getDb(env)
      .prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
      .bind(PROJECT_B_ID, USER_ID)
      .run();

    const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-before-membership-loss",
      body: { fields: { appId: APP_ID, appSecret: "different-secret" } },
    });

    expect(response.status).toBe(403);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("rolls every connection back to the retained immediate predecessor", async () => {
    const providerFetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(Response.json({ data: [] })));
    vi.stubGlobal("fetch", providerFetch);
    const rotated = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-before-rollback",
      body: { fields: { appId: APP_ID, appSecret: "new-secret" } },
    });
    const rotatedBody = (await rotated.json()) as {
      data: { providerCredential: { id: string } };
    };

    const rollback = await lifecycleRequest(
      `/provider-credentials/${rotatedBody.data.providerCredential.id}/rollback`,
      { method: "POST" }
    );

    expect(rollback.status).toBe(200);
    expect(await rollback.json()).toMatchObject({
      data: { providerCredential: { id: CREDENTIAL_ID, status: "active" } },
    });
    expect(
      await getDb(env).queryMany<{ provider_credential_id: string }>(
        "SELECT provider_credential_id FROM custody_connections ORDER BY id"
      )
    ).toEqual([
      { provider_credential_id: CREDENTIAL_ID },
      { provider_credential_id: CREDENTIAL_ID },
    ]);
    const rolledBackFrom = await getDb(env).queryOne<{
      status: string;
      secret_retention_expires_at: string | null;
    }>(`SELECT status, secret_retention_expires_at FROM provider_credentials WHERE id = ?`, [
      rotatedBody.data.providerCredential.id,
    ]);
    expect(rolledBackFrom).toMatchObject({
      status: "retired",
      secret_retention_expires_at: expect.any(String),
    });
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it("returns a conflict when retention cleanup wins before rollback secret access", async () => {
    const providerFetch = vi.fn().mockResolvedValue(Response.json({ data: [] }));
    vi.stubGlobal("fetch", providerFetch);
    const rotated = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-before-rollback-cleanup",
      body: { fields: { appId: APP_ID, appSecret: "new-secret" } },
    });
    const rotatedBody = (await rotated.json()) as {
      data: { providerCredential: { id: string } };
    };
    const findWithSecret = ProviderCredentialStore.prototype.findLifecycleCredentialWithSecret;
    let releaseSecretLookup: () => void = () => undefined;
    let markSecretLookupStarted: () => void = () => undefined;
    const secretLookupStarted = new Promise<void>((resolve) => {
      markSecretLookupStarted = resolve;
    });
    const secretLookupReleased = new Promise<void>((resolve) => {
      releaseSecretLookup = resolve;
    });
    let blocked = false;
    vi.spyOn(
      ProviderCredentialStore.prototype,
      "findLifecycleCredentialWithSecret"
    ).mockImplementation(async function (this: ProviderCredentialStore, organizationId, id) {
      if (!blocked && id === CREDENTIAL_ID) {
        blocked = true;
        markSecretLookupStarted();
        await secretLookupReleased;
      }
      return findWithSecret.call(this, organizationId, id);
    });

    const rollback = lifecycleRequest(
      `/provider-credentials/${rotatedBody.data.providerCredential.id}/rollback`,
      { method: "POST" }
    );
    await secretLookupStarted;
    await getDb(env)
      .prepare(
        `UPDATE provider_credentials
         SET encrypted_secret_payload = NULL, secret_retention_expires_at = NULL
         WHERE id = ?`
      )
      .bind(CREDENTIAL_ID)
      .run();
    releaseSecretLookup();

    expect((await rollback).status).toBe(409);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("cancels an unreferenced pending candidate without a fallible post-commit read", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    const rotated = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-before-cancel",
      body: { fields: { appId: APP_ID, appSecret: "new-secret" } },
    });
    const rotatedBody = (await rotated.json()) as {
      data: { providerCredential: { id: string } };
    };
    const candidateId = rotatedBody.data.providerCredential.id;
    const findLifecycleCredential = ProviderCredentialStore.prototype.findLifecycleCredential;
    vi.spyOn(ProviderCredentialStore.prototype, "findLifecycleCredential").mockImplementation(
      async function (this: ProviderCredentialStore, organizationId, credentialId, options) {
        const credential = await findLifecycleCredential.call(
          this,
          organizationId,
          credentialId,
          options
        );
        if (credential?.id === candidateId && credential.status === "deactivated") {
          throw new Error("post-commit reads are unavailable");
        }
        return credential;
      }
    );

    const canceled = await lifecycleRequest(`/provider-credentials/${candidateId}/deactivate`, {
      method: "POST",
    });

    expect(canceled.status).toBe(200);
    expect(await canceled.json()).toMatchObject({
      data: {
        providerCredential: { id: candidateId, status: "deactivated" },
      },
    });
    expect(
      await getDb(env).queryMany<{ provider_credential_id: string }>(
        "SELECT provider_credential_id FROM custody_connections ORDER BY id"
      )
    ).toEqual([
      { provider_credential_id: CREDENTIAL_ID },
      { provider_credential_id: CREDENTIAL_ID },
    ]);
    expect(
      await getDb(env).queryOne<{ encrypted_secret_payload: string | null }>(
        "SELECT encrypted_secret_payload FROM provider_credentials WHERE id = ?",
        [candidateId]
      )
    ).toEqual({ encrypted_secret_payload: null });
  });

  it("keeps a committed GCP candidate cancellation successful when cleanup cannot start", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    const rotated = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-gcp-cancel",
      body: { fields: { appId: APP_ID, appSecret: "new-secret" } },
    });
    const rotatedBody = (await rotated.json()) as {
      data: { providerCredential: { id: string } };
    };
    await getDb(env)
      .prepare(
        `UPDATE provider_credentials
         SET storage_backend = 'gcp_secret_manager', encrypted_secret_payload = NULL,
             secret_ref = 'projects/123/secrets/sdp-provider-credentials-test',
             secret_version_ref = 'projects/123/secrets/sdp-provider-credentials-test/versions/1'
         WHERE id = ?`
      )
      .bind(rotatedBody.data.providerCredential.id)
      .run();
    env.GCP_SECRET_MANAGER_PROJECT_ID = undefined;

    const canceled = await lifecycleRequest(
      `/provider-credentials/${rotatedBody.data.providerCredential.id}/deactivate`,
      { method: "POST" }
    );

    expect(canceled.status).toBe(200);
    expect(await canceled.json()).toMatchObject({
      data: { providerCredential: { status: "deactivated" } },
    });
  });

  it("reauthorizes a canceled candidate replay against current lineage references", async () => {
    const providerFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    vi.stubGlobal("fetch", providerFetch);
    const first = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-before-canceled-lineage-replay",
      body: { fields: { appId: APP_ID, appSecret: "candidate-secret" } },
    });
    const firstBody = (await first.json()) as {
      data: { providerCredential: { id: string } };
    };
    const canceledCandidateId = firstBody.data.providerCredential.id;
    expect(
      await lifecycleRequest(`/provider-credentials/${canceledCandidateId}/deactivate`, {
        method: "POST",
      })
    ).toMatchObject({ status: 200 });
    expect(
      await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
        method: "POST",
        key: "rotate-after-canceled-lineage-replay",
        body: { fields: { appId: APP_ID, appSecret: "replacement-secret" } },
      })
    ).toMatchObject({ status: 200 });

    await getDb(env)
      .prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
      .bind(PROJECT_B_ID, USER_ID)
      .run();
    const secretLookup = vi.spyOn(
      ProviderCredentialStore.prototype,
      "findLifecycleCredentialWithSecret"
    );
    const denied = await lifecycleRequest(
      `/provider-credentials/${canceledCandidateId}/deactivate`,
      { method: "POST" }
    );
    expect(denied.status).toBe(403);
    expect(secretLookup).not.toHaveBeenCalled();

    await getDb(env)
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role)
         VALUES ('pm_lifecycle_b', ?, ?, 'admin')`
      )
      .bind(PROJECT_B_ID, USER_ID)
      .run();
    const replay = await lifecycleRequest(
      `/provider-credentials/${canceledCandidateId}/deactivate`,
      { method: "POST" }
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      data: { providerCredential: { id: canceledCandidateId, status: "deactivated" } },
    });
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it("blocks cancellation when an invariant-breach reference owns an active wallet", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    const rotated = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-before-invariant-breach",
      body: { fields: { appId: APP_ID, appSecret: "new-secret" } },
    });
    const rotatedBody = (await rotated.json()) as {
      data: { providerCredential: { id: string } };
    };
    const candidateId = rotatedBody.data.providerCredential.id;
    const db = getDb(env);
    await db.batch([
      db
        .prepare(
          `INSERT INTO custody_connections (
             id, organization_id, project_id, provider, scope, provider_credential_id,
             provider_credential_scope_key, status, deactivated_at, created_by
           ) VALUES (
             'cconn_candidate_invariant', ?, ?, 'privy', 'project', ?,
             '__organization__', 'deactivated', sdp_iso_now(), ?
           )`
        )
        .bind(ORGANIZATION_ID, PROJECT_A_ID, candidateId, USER_ID),
      db.prepare(
        `INSERT INTO custody_wallets
           (id, custody_connection_id, wallet_id, public_key, status)
         VALUES (
           'cwlt_candidate_invariant', 'cconn_candidate_invariant',
           'provider-candidate-invariant', 'address-candidate-invariant', 'active'
         )`
      ),
    ]);

    const canceled = await lifecycleRequest(`/provider-credentials/${candidateId}/deactivate`, {
      method: "POST",
    });

    expect(canceled.status).toBe(409);
    expect(
      await db.queryOne<{ status: string }>(
        "SELECT status FROM provider_credentials WHERE id = ?",
        [candidateId]
      )
    ).toEqual({ status: "pending" });
  });

  it("returns 503 when a retryable Provider outcome cannot be persisted", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    vi.spyOn(ProviderCredentialStore.prototype, "recordRotationRetryUnknown").mockRejectedValueOnce(
      new Error("database unavailable")
    );

    const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-unpersisted-outcome",
      body: { fields: { appId: APP_ID, appSecret: "new-secret" } },
    });

    expect(response.status).toBe(503);
  });

  it("rejects malformed rotation input before writing a candidate", async () => {
    const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-unknown-field",
      body: {
        fields: { appId: APP_ID, appSecret: "new-secret" },
        connectionIds: [CONNECTION_A_ID],
      },
    });

    expect(response.status).toBe(400);
    expect(
      await getDb(env).queryOne<{ count: number }>(
        "SELECT COUNT(*) AS count FROM provider_credentials"
      )
    ).toEqual({ count: 1 });
  });

  it("rejects rotation before Provider I/O when any affected project is inaccessible", async () => {
    await getDb(env)
      .prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
      .bind(PROJECT_B_ID, USER_ID)
      .run();
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);

    const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-inaccessible-impact",
      body: { fields: { appId: APP_ID, appSecret: "new-secret" } },
    });

    expect(response.status).toBe(403);
    expect(providerFetch).not.toHaveBeenCalled();
    expect(
      await getDb(env).queryOne<{ count: number }>(
        "SELECT COUNT(*) AS count FROM provider_credentials"
      )
    ).toEqual({ count: 1 });
  });

  it("rejects an orphan rotation target before Provider I/O", async () => {
    await getDb(env)
      .prepare(
        `UPDATE custody_connections
         SET status = 'deactivated', deactivated_at = sdp_iso_now()
         WHERE provider_credential_id = ?`
      )
      .bind(CREDENTIAL_ID)
      .run();
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);

    const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-orphan",
      body: { fields: { appId: APP_ID, appSecret: "new-secret" } },
    });

    expect(response.status).toBe(409);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("blocks rollback while a retryable direct child is pending", async () => {
    const providerFetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", providerFetch);
    await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-pending-before-rollback",
      body: { fields: { appId: APP_ID, appSecret: "new-secret" } },
    });

    const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rollback`, {
      method: "POST",
    });

    expect(response.status).toBe(409);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the active version unchanged when rollback Provider state is uncertain", async () => {
    const providerFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", providerFetch);
    const rotated = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-before-uncertain-rollback",
      body: { fields: { appId: APP_ID, appSecret: "new-secret" } },
    });
    const rotatedBody = (await rotated.json()) as {
      data: { providerCredential: { id: string } };
    };

    const response = await lifecycleRequest(
      `/provider-credentials/${rotatedBody.data.providerCredential.id}/rollback`,
      { method: "POST" }
    );

    expect(response.status).toBe(503);
    expect(
      await getDb(env).queryMany<{ provider_credential_id: string }>(
        "SELECT provider_credential_id FROM custody_connections ORDER BY id"
      )
    ).toEqual([
      { provider_credential_id: rotatedBody.data.providerCredential.id },
      { provider_credential_id: rotatedBody.data.providerCredential.id },
    ]);
  });
});
