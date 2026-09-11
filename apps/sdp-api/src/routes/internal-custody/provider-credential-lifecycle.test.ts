import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import type { ClerkJwtPayload } from "@/lib/clerk-token";
import { AppError } from "@/lib/errors";
import { databaseIdentityBoundary } from "@/middleware/database-identity";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { RedisKVStore } from "@/runtime/kv-redis";
import { getLogger } from "@/runtime/logger";
import { createCredentialSecretStore } from "@/services/credential-secret-store";
import { getPrivyProviderAccountFingerprint } from "@/services/custody/privy-credential";
import { cleanupRetiredProviderCredentialSecrets } from "@/services/jobs/cleanup-provider-credential-secrets";
import { scanGcpCredentialContainers } from "@/services/jobs/provider-credential-container-cleanup";
import { ProviderCredentialStore } from "@/services/stores/provider-credential.store";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedRateLimit } from "@/test/mocks/kv";
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
const ORIGINAL_GCP_PREFIX = env.GCP_SECRET_MANAGER_SECRET_PREFIX;
const ORIGINAL_GCP_API_BASE_URL = env.GCP_SECRET_MANAGER_API_BASE_URL;
const credentialResponseSchema = z.object({
  data: z.object({ providerCredential: z.object({ id: z.string().min(1) }) }),
});

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

  app.use("*", databaseIdentityBoundary());
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

async function seedActor(): Promise<void> {
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
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [USER_ID],
    ids: { sandbox: PROJECT_A_ID, production: PROJECT_B_ID },
  });
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

async function rotationFailureEvents() {
  return getDb(env).queryMany<{
    resource_id: string;
    status: string;
    failure_code: string;
  }>(
    `SELECT resource_id, status, metadata::jsonb ->> 'failureCode' AS failure_code
     FROM audit_logs
     WHERE organization_id = ? AND action = 'rotate'
       AND metadata::jsonb ->> 'event' = 'provider_credential_rotation_rejected'`,
    [ORGANIZATION_ID]
  );
}

function mockGcpRotation(
  options: {
    beforeAddResponse?: () => Promise<void>;
    inventory?: (secretRef: string) => Response | Promise<Response>;
    destroyFailure?: boolean;
    writeFailure?: "create" | "lost_response";
    privyStatus?: number;
  } = {}
) {
  env.CREDENTIAL_SECRET_STORE_BACKEND = "gcp_secret_manager";
  env.GCP_SECRET_MANAGER_PROJECT_ID = "sdp-lifecycle-test";
  env.GCP_SECRET_MANAGER_SECRET_PREFIX = "sdp-provider-credentials";
  env.GCP_SECRET_MANAGER_API_BASE_URL = "https://gcp-lifecycle.test";
  const requests: Array<{ url: string; method: string }> = [];
  const versions = new Map<string, string>();
  const destroyedVersions = new Set<string>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url: url.href, method: init?.method ?? "GET" });
    if (url.hostname === "metadata.google.internal") {
      return url.pathname.endsWith("/numeric-project-id")
        ? new Response("1234567890")
        : Response.json({ access_token: "gcp-test-token", expires_in: 300 });
    }
    if (url.hostname === "api.privy.io") {
      return Response.json({ data: [] }, { status: options.privyStatus ?? 200 });
    }
    if (url.hostname !== "gcp-lifecycle.test") throw new Error("Unexpected provider request");
    // Accept either project spelling while GCP responses and inventory stay canonical.
    const resourceRef = url.pathname
      .slice(4)
      .replace("projects/sdp-lifecycle-test/", "projects/1234567890/");
    const secretId = url.searchParams.get("secretId");
    if (secretId) {
      if (options.writeFailure === "create") return new Response(null, { status: 503 });
      return Response.json({ name: `projects/1234567890/secrets/${secretId}` });
    }
    if (url.pathname.endsWith(":addVersion")) {
      const parent = resourceRef.slice(0, -":addVersion".length);
      const priorVersions = [...versions.keys()]
        .filter((ref) => ref.startsWith(`${parent}/versions/`))
        .map((ref) => Number(ref.split("/").at(-1)));
      const versionRef = `${parent}/versions/${Math.max(6, ...priorVersions) + 1}`;
      const body = JSON.parse(String(init?.body)) as { payload: { data: string } };
      versions.set(versionRef, body.payload.data);
      await options.beforeAddResponse?.();
      if (options.writeFailure === "lost_response") throw new Error("Lost GCP response");
      return Response.json({ name: versionRef });
    }
    if (url.pathname.endsWith(":access")) {
      const versionRef = resourceRef.slice(0, -":access".length);
      return Response.json({ payload: { data: versions.get(versionRef) } });
    }
    if (url.pathname.endsWith("/versions")) {
      const secretRef = resourceRef.slice(0, -"/versions".length);
      if (options.inventory) return options.inventory(secretRef);
      return Response.json({
        versions: [...versions.keys()]
          .filter((name) => name.startsWith(`${secretRef}/versions/`))
          .filter((name) => !url.searchParams.has("filter") || !destroyedVersions.has(name))
          .map((name) => ({ name, state: destroyedVersions.has(name) ? "DESTROYED" : "ENABLED" })),
      });
    }
    if (url.pathname.endsWith(":destroy")) {
      if (options.destroyFailure) return new Response(null, { status: 503 });
      const versionRef = resourceRef.slice(0, -":destroy".length);
      destroyedVersions.add(versionRef);
      return Response.json({ name: versionRef, state: "DESTROYED" });
    }
    if (versions.has(resourceRef))
      return Response.json({
        name: resourceRef,
        state: destroyedVersions.has(resourceRef) ? "DESTROYED" : "ENABLED",
      });
    throw new Error("Unexpected GCP request");
  };
  vi.stubGlobal("fetch", fetcher);
  return { requests, versions };
}

function firstPersistedGcpVersionRef(gcp: ReturnType<typeof mockGcpRotation>): string {
  const [versionRef] = gcp.versions.keys();
  if (!versionRef) throw new Error("No GCP version was written");
  return versionRef.replace("projects/1234567890/", "projects/sdp-lifecycle-test/");
}

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function seedActiveGcpCredential(gcp: ReturnType<typeof mockGcpRotation>) {
  const module = await import("@/services/credential-secret-store");
  const parent = module.prepareGcpCredentialSecret(env, CREDENTIAL_ID);
  const versionRef = `${parent.secretRef?.replace("projects/sdp-lifecycle-test/", "projects/1234567890/")}/versions/1`;
  gcp.versions.set(
    versionRef,
    Buffer.from(JSON.stringify({ appId: APP_ID, appSecret: APP_SECRET })).toString("base64")
  );
  await getDb(env).execute(
    `UPDATE provider_credentials SET storage_backend = 'gcp_secret_manager',
       secret_ref = ?, secret_version_ref = ?, encrypted_secret_payload = NULL,
       secret_next_scan_at = clock_timestamp() WHERE id = ?`,
    [parent.secretRef, versionRef, CREDENTIAL_ID]
  );
  return parent.secretRef;
}

async function activeConnectionCredentialIds() {
  return getDb(env).queryMany<{ provider_credential_id: string }>(
    "SELECT provider_credential_id FROM custody_connections WHERE status = 'active' ORDER BY id"
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
    env.GCP_SECRET_MANAGER_SECRET_PREFIX = ORIGINAL_GCP_PREFIX;
    env.GCP_SECRET_MANAGER_API_BASE_URL = ORIGINAL_GCP_API_BASE_URL;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await clearKVStores(env);
  });

  it("rotates a GCP credential into a new exact version of the same container", async () => {
    const gcp = mockGcpRotation();
    const parent = await seedActiveGcpCredential(gcp);
    const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "shared-gcp-parent",
      body: { fields: { appId: APP_ID, appSecret: "new-gcp-secret" } },
    });
    expect(response.status).toBe(200);
    const rows = await getDb(env).queryMany<{ secret_ref: string; secret_version_ref: string }>(
      "SELECT secret_ref, secret_version_ref FROM provider_credentials ORDER BY credential_version"
    );
    expect(rows.map((row) => row.secret_ref)).toEqual([parent, parent]);
    expect(new Set(rows.map((row) => row.secret_version_ref)).size).toBe(2);
    expect(gcp.requests.some(({ url }) => url.includes("?secretId="))).toBe(false);
  });

  it("persists the first GCP container's scan schedule before the external write completes", async () => {
    const gcp = mockGcpRotation({
      beforeAddResponse: async () => {
        const row = await getDb(env).queryOne<{ scheduled: boolean }>(
          "SELECT secret_next_scan_at IS NOT NULL AS scheduled FROM provider_credentials WHERE status = 'creating'"
        );
        expect(row).toEqual({ scheduled: true });
      },
    });
    const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "first-gcp-owner",
      body: { fields: { appId: APP_ID, appSecret: "first-owner-secret" } },
    });
    expect(response.status).toBe(200);
    expect(gcp.versions.size).toBe(1);
  });

  it("keeps scan ownership with each GCP container across backend changes", async () => {
    const gcp = mockGcpRotation();
    let current = CREDENTIAL_ID;
    for (const [index, backend] of (
      ["gcp_secret_manager", "encrypted_db", "gcp_secret_manager"] as const
    ).entries()) {
      env.CREDENTIAL_SECRET_STORE_BACKEND = backend;
      const response = await lifecycleRequest(`/provider-credentials/${current}/rotate`, {
        method: "POST",
        key: `backend-change-${index}`,
        body: { fields: { appId: APP_ID, appSecret: `backend-change-secret-${index}` } },
      });
      expect(response.status).toBe(200);
      current = credentialResponseSchema.parse(await response.json()).data.providerCredential.id;
    }
    const rows = await getDb(env).queryMany<{
      storage_backend: string;
      owns_scan: boolean;
      secret_ref: string | null;
    }>(
      "SELECT storage_backend, secret_next_scan_at IS NOT NULL AS owns_scan, secret_ref FROM provider_credentials ORDER BY credential_version"
    );
    expect(rows.map((row) => row.storage_backend)).toEqual([
      "encrypted_db",
      "gcp_secret_manager",
      "encrypted_db",
      "gcp_secret_manager",
    ]);
    expect(rows.map((row) => row.owns_scan)).toEqual([false, true, false, true]);
    expect(rows[1]?.secret_ref).not.toBe(rows[3]?.secret_ref);
    expect(gcp.versions.size).toBe(2);
  });

  it.each(["gcp_secret_manager", "encrypted_db"] as const)(
    "rolls back to the persisted %s backend after changing the write backend",
    async (previousBackend) => {
      const gcp = mockGcpRotation();
      if (previousBackend === "gcp_secret_manager") await seedActiveGcpCredential(gcp);
      env.CREDENTIAL_SECRET_STORE_BACKEND =
        previousBackend === "gcp_secret_manager" ? "encrypted_db" : "gcp_secret_manager";
      const rotated = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
        method: "POST",
        key: `rollback-backend-${previousBackend}`,
        body: { fields: { appId: APP_ID, appSecret: "backend-rollback-secret" } },
      });
      expect(rotated.status).toBe(200);
      const current = credentialResponseSchema.parse(await rotated.json()).data.providerCredential
        .id;
      const rollback = await lifecycleRequest(`/provider-credentials/${current}/rollback`, {
        method: "POST",
      });
      expect(rollback.status).toBe(200);
      expect(await activeConnectionCredentialIds()).toEqual([
        { provider_credential_id: CREDENTIAL_ID },
        { provider_credential_id: CREDENTIAL_ID },
      ]);
    }
  );

  it("shared-container cleanup preserves a rotation adopted after a lost COMMIT reply", async () => {
    const db = getDb(env);
    const runTransaction = db.transaction.bind(db);
    const gcp = mockGcpRotation({
      inventory: () =>
        Response.json({
          versions: [...gcp.versions.keys()].map((name) => ({ name, state: "ENABLED" })),
        }),
      beforeAddResponse: async () => {
        vi.spyOn(db, "transaction").mockImplementationOnce(async (callback) => {
          await runTransaction(callback);
          throw new Error("Lost finalization COMMIT response");
        });
      },
    });
    await seedActiveGcpCredential(gcp);

    const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "prototype-shared-commit",
      body: { fields: { appId: APP_ID, appSecret: "prototype-new-secret" } },
    });
    expect(response.status).toBe(200);
    const { data } = credentialResponseSchema.parse(await response.json());
    expect(await activeConnectionCredentialIds()).toEqual([
      { provider_credential_id: data.providerCredential.id },
      { provider_credential_id: data.providerCredential.id },
    ]);
    expect(
      await scanGcpCredentialContainers(env, () =>
        createCredentialSecretStore(env, "gcp_secret_manager")
      )
    ).toMatchObject({ cleaned: 0, failed: [] });
    expect(gcp.requests.some(({ url }) => url.endsWith(":destroy"))).toBe(false);
  });

  it("shared-container cleanup fences a cancelled HTTP writer before its late reply", async () => {
    const started = deferredVoid();
    const released = deferredVoid();
    const gcp = mockGcpRotation({
      inventory: () =>
        Response.json({
          versions: [...gcp.versions.keys()].map((name) => ({ name, state: "ENABLED" })),
        }),
      beforeAddResponse: async () => {
        started.resolve();
        await released.promise;
      },
    });
    await seedActiveGcpCredential(gcp);
    const rotation = lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "prototype-shared-cancel",
      body: { fields: { appId: APP_ID, appSecret: "prototype-late-secret" } },
    });
    try {
      await started.promise;
      expect(
        (
          await scanGcpCredentialContainers(env, () =>
            createCredentialSecretStore(env, "gcp_secret_manager")
          )
        ).skipped
      ).toBeGreaterThan(0);
      const read = await lifecycleRequest(`/connections/${CONNECTION_A_ID}/provider-credential`);
      const candidateId = z
        .object({ data: z.object({ rotationCandidate: z.object({ id: z.string() }) }) })
        .parse(await read.json()).data.rotationCandidate.id;
      expect(
        (
          await lifecycleRequest(`/provider-credentials/${candidateId}/deactivate`, {
            method: "POST",
          })
        ).status
      ).toBe(200);
      const result = await scanGcpCredentialContainers(
        env,
        () => createCredentialSecretStore(env, "gcp_secret_manager"),
        { now: new Date(Date.now() + 6 * 60_000) }
      );
      expect(result.cleaned).toBe(1);
      expect(
        gcp.requests.some(({ url }) =>
          url.endsWith(`sdp-provider-credentials-${CREDENTIAL_ID}/versions/7:destroy`)
        )
      ).toBe(true);
    } finally {
      released.resolve();
      await rotation;
    }
    expect((await rotation).status).toBe(409);
    expect(await activeConnectionCredentialIds()).toEqual([
      { provider_credential_id: CREDENTIAL_ID },
      { provider_credential_id: CREDENTIAL_ID },
    ]);
  });

  it("deactivates an unused setup Credential and replays without another lifecycle audit", async () => {
    const credentialId = "pcred_unused_setup";
    const stored = await createCredentialSecretStore(env).write({
      orgId: ORGANIZATION_ID,
      provider: "privy",
      providerCredentialId: credentialId,
      payload: { appId: APP_ID, appSecret: APP_SECRET },
    });
    await new ProviderCredentialStore(getDb(env)).insertCredential({
      id: credentialId,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_A_ID,
      provider: "privy",
      label: "Unused setup",
      scope: "project",
      source: "stored",
      stored,
      displayMetadata: {},
      version: 1,
      rotatedFromId: null,
      idempotencyKey: "unused-setup",
      idempotencyFingerprint: "unused-setup-fingerprint",
      createdBy: USER_ID,
    });
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await lifecycleRequest(`/provider-credentials/${credentialId}/deactivate`, {
        method: "POST",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { providerCredential: { id: credentialId, status: "deactivated" } },
      });
    }

    expect(
      await getDb(env).queryOne(
        "SELECT status, encrypted_secret_payload FROM provider_credentials WHERE id = ?",
        [credentialId]
      )
    ).toEqual({ status: "deactivated", encrypted_secret_payload: null });
    expect(
      await getDb(env).queryOne(
        "SELECT COUNT(*) AS count FROM audit_logs WHERE resource_id = ? AND action = 'deactivate'",
        [credentialId]
      )
    ).toEqual({ count: 1 });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it.each(["pending", "checking", "failed", "active"])(
    "blocks Credential deactivation while a %s Connection references it, even without active wallets",
    async (status) => {
      const db = getDb(env);
      await db.execute("UPDATE custody_wallets SET status = 'deactivated'");
      await db.execute(
        `UPDATE custody_connections SET status = ?, deactivated_at = NULL,
           last_check_status = CASE ? WHEN 'checking' THEN 'running' WHEN 'failed' THEN 'failed' ELSE 'success' END,
           activated_at = CASE WHEN ? = 'active' THEN activated_at ELSE NULL END WHERE id = ?`,
        [status, status, status, CONNECTION_A_ID]
      );
      await db.execute(
        "UPDATE custody_connections SET status = 'deactivated', deactivated_at = sdp_iso_now() WHERE id = ?",
        [CONNECTION_B_ID]
      );
      const original = await db.queryOne("SELECT * FROM provider_credentials WHERE id = ?", [
        CREDENTIAL_ID,
      ]);
      const providerFetch = vi.fn();
      vi.stubGlobal("fetch", providerFetch);

      const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/deactivate`, {
        method: "POST",
      });

      expect(response.status).toBe(409);
      expect((await response.json()).error).toEqual({
        code: "CONFLICT",
        message: "Credential cannot be deactivated while it is in use",
      });
      expect(
        await db.queryOne("SELECT * FROM provider_credentials WHERE id = ?", [CREDENTIAL_ID])
      ).toEqual(original);
      expect(await db.queryMany("SELECT id FROM audit_logs WHERE action = 'deactivate'")).toEqual(
        []
      );
      expect(providerFetch).not.toHaveBeenCalled();
    }
  );

  it("keeps a pending child visible and cancelable after its eligible parent is deactivated", async () => {
    const providerFetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", providerFetch);
    const pending = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-before-parent-deactivation",
      body: { fields: { appId: APP_ID, appSecret: "pending-secret" } },
    });
    expect(pending.status).toBe(200);
    const { data } = credentialResponseSchema.parse(await pending.json());
    const childId = data.providerCredential.id;
    // Prospective walletless history, prepared only in this test fixture.
    const db = getDb(env);
    await db.execute("UPDATE custody_wallets SET status = 'deactivated'");
    await db.execute(
      "UPDATE custody_connections SET status = 'deactivated', deactivated_at = sdp_iso_now()"
    );
    providerFetch.mockClear();

    const parent = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/deactivate`, {
      method: "POST",
    });
    expect(parent.status).toBe(200);
    expect(await parent.json()).toMatchObject({
      data: { providerCredential: { id: CREDENTIAL_ID, status: "deactivated" } },
    });
    const state = await lifecycleRequest(`/connections/${CONNECTION_A_ID}/provider-credential`);
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({
      data: {
        providerCredential: { id: CREDENTIAL_ID, status: "deactivated" },
        rotationCandidate: { id: childId, status: "pending" },
        rollback: null,
      },
    });
    const child = await lifecycleRequest(`/provider-credentials/${childId}/deactivate`, {
      method: "POST",
    });
    expect(child.status).toBe(200);
    expect(await child.json()).toMatchObject({
      data: { providerCredential: { id: childId, status: "deactivated" } },
    });
    expect(
      await (await lifecycleRequest(`/connections/${CONNECTION_A_ID}/provider-credential`)).json()
    ).toMatchObject({
      data: {
        providerCredential: { id: CREDENTIAL_ID, status: "deactivated" },
        rotationCandidate: null,
      },
    });
    expect(
      await db.queryMany(
        "SELECT resource_id FROM audit_logs WHERE action = 'deactivate' ORDER BY resource_id"
      )
    ).toEqual([CREDENTIAL_ID, childId].sort().map((resource_id) => ({ resource_id })));
    expect(providerFetch).not.toHaveBeenCalled();
  });

  describe("unreferenced current Credential deactivation", () => {
    beforeEach(async () => {
      // Prospective walletless history; Privy has no supported wallet deactivation command.
      await getDb(env).execute("UPDATE custody_wallets SET status = 'deactivated'");
      await getDb(env).execute(
        "UPDATE custody_connections SET status = 'deactivated', deactivated_at = sdp_iso_now()"
      );
    });

    it("refuses deactivation of an initial GCP Credential while its secret is creating", async () => {
      const gcp = mockGcpRotation();
      await seedActiveGcpCredential(gcp);
      const db = getDb(env);
      await db.execute(
        "UPDATE provider_credentials SET status = 'creating', secret_version_ref = NULL WHERE id = ?",
        [CREDENTIAL_ID]
      );
      const original = await db.queryOne("SELECT * FROM provider_credentials WHERE id = ?", [
        CREDENTIAL_ID,
      ]);

      const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/deactivate`, {
        method: "POST",
      });

      expect(response.status).toBe(409);
      expect(
        await db.queryOne("SELECT * FROM provider_credentials WHERE id = ?", [CREDENTIAL_ID])
      ).toEqual(original);
      expect(await db.queryMany("SELECT id FROM audit_logs WHERE action = 'deactivate'")).toEqual(
        []
      );
      expect(gcp.requests).toEqual([]);
    });

    it.each(["encrypted_db", "runtime_env"])(
      "deactivates the active %s Credential without changing deployment secrets or Connection history",
      async (backend) => {
        const db = getDb(env);
        if (backend === "runtime_env") {
          await db.execute(
            `UPDATE provider_credentials SET source = 'runtime', storage_backend = 'runtime_env',
               encrypted_secret_payload = NULL WHERE id = ?`,
            [CREDENTIAL_ID]
          );
        }
        const deployment = { ...env };
        const connections = await db.queryMany("SELECT * FROM custody_connections ORDER BY id");
        const providerFetch = vi.fn();
        vi.stubGlobal("fetch", providerFetch);

        const response = await lifecycleRequest(
          `/provider-credentials/${CREDENTIAL_ID}/deactivate`,
          {
            method: "POST",
          }
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          data: { providerCredential: { id: CREDENTIAL_ID, status: "deactivated" } },
        });
        expect(
          await db.queryOne(
            "SELECT status, encrypted_secret_payload FROM provider_credentials WHERE id = ?",
            [CREDENTIAL_ID]
          )
        ).toEqual({ status: "deactivated", encrypted_secret_payload: null });
        expect(await db.queryMany("SELECT * FROM custody_connections ORDER BY id")).toEqual(
          connections
        );
        expect(
          await db.queryOne(
            "SELECT COUNT(*) AS count FROM audit_logs WHERE resource_id = ? AND action = 'deactivate'",
            [CREDENTIAL_ID]
          )
        ).toEqual({ count: 1 });
        expect(env).toEqual(deployment);
        expect(providerFetch).not.toHaveBeenCalled();
      }
    );

    it.each(["failed_validation", "retired"])("preserves %s history", async (status) => {
      const db = getDb(env);
      await db.execute("UPDATE provider_credentials SET status = ? WHERE id = ?", [
        status,
        CREDENTIAL_ID,
      ]);
      const original = await db.queryOne("SELECT * FROM provider_credentials WHERE id = ?", [
        CREDENTIAL_ID,
      ]);
      const providerFetch = vi.fn();
      vi.stubGlobal("fetch", providerFetch);

      const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/deactivate`, {
        method: "POST",
      });

      expect(response.status).toBe(409);
      expect((await response.json()).error).toEqual({
        code: "CONFLICT",
        message: "Credential cannot be deactivated from its current state",
      });
      expect(
        await db.queryOne("SELECT * FROM provider_credentials WHERE id = ?", [CREDENTIAL_ID])
      ).toEqual(original);
      expect(await db.queryMany("SELECT id FROM audit_logs WHERE action = 'deactivate'")).toEqual(
        []
      );
      expect(providerFetch).not.toHaveBeenCalled();
    });

    it("returns success with one audit when two deactivations pass preflight together", async () => {
      let started = 0;
      let release = () => {};
      const bothStarted = new Promise<void>((resolve) => {
        release = resolve;
      });
      const findSecret = ProviderCredentialStore.prototype.findLifecycleCredentialWithSecret;
      vi.spyOn(
        ProviderCredentialStore.prototype,
        "findLifecycleCredentialWithSecret"
      ).mockImplementation(async function (this: ProviderCredentialStore, ...args) {
        const row = await findSecret.apply(this, args);
        if (++started === 2) release();
        await bothStarted;
        return row;
      });
      const providerFetch = vi.fn();
      vi.stubGlobal("fetch", providerFetch);

      const responses = await Promise.all(
        [0, 1].map(() =>
          lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/deactivate`, { method: "POST" })
        )
      );

      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          data: { providerCredential: { id: CREDENTIAL_ID, status: "deactivated" } },
        });
      }
      expect(
        await getDb(env).queryOne(
          "SELECT COUNT(*) AS count FROM audit_logs WHERE resource_id = ? AND action = 'deactivate'",
          [CREDENTIAL_ID]
        )
      ).toEqual({ count: 1 });
      expect(providerFetch).not.toHaveBeenCalled();
    });

    it("preserves a fresh authorization refusal when a concurrent deactivation has committed", async () => {
      const db = getDb(env);
      const transaction = db.transaction.bind(db);
      const providerFetch = vi.fn();
      vi.stubGlobal("fetch", providerFetch);
      vi.spyOn(db, "transaction").mockImplementationOnce(async (callback) => {
        // The first request has passed preflight; another authorized request wins.
        const winner = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/deactivate`, {
          method: "POST",
        });
        expect(winner.status).toBe(200);
        await db.execute("DELETE FROM project_members WHERE project_id = ? AND user_id = ?", [
          PROJECT_A_ID,
          USER_ID,
        ]);
        return transaction(callback);
      });

      const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/deactivate`, {
        method: "POST",
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "FORBIDDEN", message: "Requested project is not accessible" },
      });
      expect(
        await db.queryOne("SELECT status FROM provider_credentials WHERE id = ?", [CREDENTIAL_ID])
      ).toEqual({ status: "deactivated" });
      expect(
        await db.queryOne(
          "SELECT COUNT(*) AS count FROM audit_logs WHERE resource_id = ? AND action = 'deactivate'",
          [CREDENTIAL_ID]
        )
      ).toEqual({ count: 1 });
      expect(providerFetch).not.toHaveBeenCalled();
    });

    it.each(["database failure", "membership loss"])(
      "preserves Credential and secret when %s occurs after preflight",
      async (fault) => {
        const db = getDb(env);
        const original = await db.queryOne("SELECT * FROM provider_credentials WHERE id = ?", [
          CREDENTIAL_ID,
        ]);
        if (fault === "database failure") {
          const transaction = db.transaction.bind(db);
          vi.spyOn(db, "transaction").mockImplementationOnce((callback) =>
            transaction(async (tx) => {
              await callback(tx);
              await tx.execute("SELECT 1 / 0");
            })
          );
        } else {
          const lockProjects = ProviderCredentialStore.prototype.lockAuthorizedProjects;
          vi.spyOn(
            ProviderCredentialStore.prototype,
            "lockAuthorizedProjects"
          ).mockImplementationOnce(async function (this: ProviderCredentialStore, ...args) {
            await db.execute("DELETE FROM project_members WHERE project_id = ? AND user_id = ?", [
              PROJECT_A_ID,
              USER_ID,
            ]);
            return lockProjects.apply(this, args);
          });
        }
        const providerFetch = vi.fn();
        vi.stubGlobal("fetch", providerFetch);

        const response = await lifecycleRequest(
          `/provider-credentials/${CREDENTIAL_ID}/deactivate`,
          { method: "POST" }
        );

        expect(response.status).toBe(fault === "database failure" ? 503 : 403);
        expect(
          await db.queryOne("SELECT * FROM provider_credentials WHERE id = ?", [CREDENTIAL_ID])
        ).toEqual(original);
        expect(await db.queryMany("SELECT id FROM audit_logs WHERE action = 'deactivate'")).toEqual(
          []
        );
        expect(providerFetch).not.toHaveBeenCalled();
      }
    );
  });

  it("retries failed GCP root destruction at its container scan and preserves its live child", async () => {
    const options = { privyStatus: 503, destroyFailure: true };
    const gcp = mockGcpRotation(options);
    const secretRef = z.string().parse(await seedActiveGcpCredential(gcp));
    const canonicalRef = secretRef.replace("projects/sdp-lifecycle-test/", "projects/1234567890/");
    const rotation = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-before-gcp-root-deactivation",
      body: { fields: { appId: APP_ID, appSecret: "live-child-secret" } },
    });
    expect(rotation.status).toBe(200);
    const childId = credentialResponseSchema.parse(await rotation.json()).data.providerCredential
      .id;
    const secrets = () => createCredentialSecretStore(env, "gcp_secret_manager");
    expect(await scanGcpCredentialContainers(env, secrets)).toMatchObject({
      scanned: [secretRef],
      cleaned: 0,
      failed: [],
    });
    // Prospective walletless history, prepared only in this test fixture.
    const db = getDb(env);
    await db.execute("UPDATE custody_wallets SET status = 'deactivated'");
    await db.execute(
      "UPDATE custody_connections SET status = 'deactivated', deactivated_at = sdp_iso_now()"
    );

    const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/deactivate`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      data: { providerCredential: { id: CREDENTIAL_ID, status: "deactivated" } },
    });
    expect(JSON.stringify(body)).not.toContain(secretRef);
    expect(
      await db.queryOne(
        `SELECT status, secret_retention_expires_at::timestamptz <= clock_timestamp() AS due,
           secret_next_scan_at > clock_timestamp() AS scheduled
         FROM provider_credentials WHERE id = ?`,
        [CREDENTIAL_ID]
      )
    ).toEqual({ status: "deactivated", due: true, scheduled: true });
    expect(await cleanupRetiredProviderCredentialSecrets(env)).toEqual({
      cleaned: 0,
      skipped: 0,
      failed: 0,
    });
    const destruction = {
      url: `https://gcp-lifecycle.test/v1/${canonicalRef}/versions/1:destroy`,
      method: "POST",
    };
    expect(gcp.requests.filter(({ url }) => url.endsWith(":destroy"))).toEqual([destruction]);

    options.destroyFailure = false;
    expect(
      await scanGcpCredentialContainers(env, secrets, { now: new Date(Date.now() + 6 * 60_000) })
    ).toMatchObject({ scanned: [secretRef], cleaned: 1, failed: [] });
    expect(gcp.requests.filter(({ url }) => url.endsWith(":destroy"))).toEqual([
      destruction,
      destruction,
    ]);
    expect(await secrets().listVersions?.({ secretRef, liveOnly: true })).toMatchObject({
      versions: [{ secretVersionRef: `${canonicalRef}/versions/7`, state: "ENABLED" }],
    });
    expect(
      await db.queryOne(
        "SELECT status, secret_retention_expires_at FROM provider_credentials WHERE id = ?",
        [CREDENTIAL_ID]
      )
    ).toEqual({ status: "deactivated", secret_retention_expires_at: null });
    expect(
      await (await lifecycleRequest(`/connections/${CONNECTION_A_ID}/provider-credential`)).json()
    ).toMatchObject({
      data: {
        providerCredential: { id: CREDENTIAL_ID, status: "deactivated" },
        rotationCandidate: { id: childId, status: "pending" },
      },
    });
  });

  it.each(["actor", "organization"])(
    "refuses rotation when the %s quota is exhausted",
    async (scope) => {
      vi.spyOn(Date, "now").mockReturnValue(Date.now());
      await seedRateLimit(
        env,
        `metered:credential-rotation:org:${ORGANIZATION_ID}${scope === "actor" ? `:user:${USER_ID}` : ""}`,
        scope === "actor" ? 5 : 20
      );
      const providerFetch = vi.fn().mockResolvedValue(Response.json({ data: [] }));
      vi.stubGlobal("fetch", providerFetch);

      const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
        method: "POST",
        key: "rotate-quota-exhausted",
        body: { fields: { appId: APP_ID, appSecret: "new-secret" } },
      });

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).not.toBeNull();
      expect(await response.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
      expect(providerFetch).not.toHaveBeenCalled();
      const state = await lifecycleRequest(`/connections/${CONNECTION_A_ID}/provider-credential`);
      expect(state.status).toBe(200);
      expect(await state.json()).toMatchObject({
        data: { providerCredential: { id: CREDENTIAL_ID }, rotationCandidate: null },
      });
    }
  );

  it("refuses rotation before provider calls or secret storage when the quota store is unavailable", async () => {
    vi.spyOn(RedisKVStore.prototype, "admitSlidingWindow").mockRejectedValue(
      new Error("KV unavailable")
    );
    const providerFetch = vi.fn().mockResolvedValue(Response.json({ data: [] }));
    vi.stubGlobal("fetch", providerFetch);

    const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-quota-unavailable",
      body: { fields: { appId: APP_ID, appSecret: "new-secret" } },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
    expect(providerFetch).not.toHaveBeenCalled();
    const state = await lifecycleRequest(`/connections/${CONNECTION_A_ID}/provider-credential`);
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({
      data: { providerCredential: { id: CREDENTIAL_ID }, rotationCandidate: null },
    });
  });

  it.each(["complete-rotation", "rollback", "deactivate"])(
    "refuses %s before provider calls or state changes when its quota is exhausted",
    async (action) => {
      vi.spyOn(Date, "now").mockReturnValue(Date.now());
      const providerFetch = vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            action === "rollback"
              ? Response.json({ data: [] })
              : new Response(null, { status: 503 })
          )
        );
      vi.stubGlobal("fetch", providerFetch);
      const rotated = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
        method: "POST",
        key: "rotate-before-quota-test",
        body: { fields: { appId: APP_ID, appSecret: "new-secret" } },
      });
      expect(rotated.status).toBe(200);
      const { data } = await rotated.json();
      const statePath = `/connections/${CONNECTION_A_ID}/provider-credential`;
      const before = await (await lifecycleRequest(statePath)).json();
      const quota = action === "complete-rotation" ? "credential-rotation" : "credential-recovery";
      await seedRateLimit(env, `metered:${quota}:org:${ORGANIZATION_ID}`, 20);
      providerFetch.mockClear();

      const response = await lifecycleRequest(
        `/provider-credentials/${data.providerCredential.id}/${action}`,
        { method: "POST" }
      );

      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
      expect(providerFetch).not.toHaveBeenCalled();
      const after = await (await lifecycleRequest(statePath)).json();
      expect(after.data).toEqual(before.data);
    }
  );

  it("returns the exact credential and complete authorized impact", async () => {
    const response = await lifecycleRequest(`/connections/${CONNECTION_A_ID}/provider-credential`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      providerCredential: { id: CREDENTIAL_ID, status: "active", source: "stored" },
      rotationCandidate: null,
      impact: {
        projects: [
          { id: PROJECT_A_ID, name: "Lifecycle default-sandbox" },
          { id: PROJECT_B_ID, name: "Lifecycle default-production" },
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

  it("rolls back the whole cutover when retiring the predecessor fails", async () => {
    const logger = getLogger();
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => logger);
    const providerFetch = vi.fn().mockResolvedValue(Response.json({ data: [] }));
    vi.stubGlobal("fetch", providerFetch);
    const db = getDb(env);
    await db.execute(
      `ALTER TABLE provider_credentials
       ADD CONSTRAINT sdp_test_fail_provider_credential_retirement
       CHECK (status <> 'retired') NOT VALID`
    );

    try {
      const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
        method: "POST",
        key: "rotate-retirement-write-failure",
        body: { fields: { appId: APP_ID, appSecret: "new-secret" } },
      });

      expect(response.status).toBe(409);
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "sdp_api_credential_lifecycle_failure",
          stage: "rotation_commit",
          organization_id: ORGANIZATION_ID,
          request_id: "req_provider_credential_lifecycle",
          error_code: "23514",
        }),
        "sdp_api_credential_lifecycle_failure"
      );
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain("new-secret");
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
        "sdp_test_fail_provider_credential_retirement"
      );
      expect(providerFetch).toHaveBeenCalledTimes(1);
      expect(
        await db.queryMany<{
          id: string;
          status: string;
          rotated_from_provider_credential_id: string | null;
        }>(
          `SELECT id, status, rotated_from_provider_credential_id
           FROM provider_credentials
           ORDER BY credential_version, id`
        )
      ).toEqual([
        {
          id: CREDENTIAL_ID,
          status: "active",
          rotated_from_provider_credential_id: null,
        },
        expect.objectContaining({
          status: "pending",
          rotated_from_provider_credential_id: CREDENTIAL_ID,
        }),
      ]);
      expect(
        await db.queryMany<{ id: string; provider_credential_id: string }>(
          `SELECT id, provider_credential_id
           FROM custody_connections
           ORDER BY id`
        )
      ).toEqual([
        { id: CONNECTION_A_ID, provider_credential_id: CREDENTIAL_ID },
        { id: CONNECTION_B_ID, provider_credential_id: CREDENTIAL_ID },
      ]);
    } finally {
      await db.execute(
        `ALTER TABLE provider_credentials
         DROP CONSTRAINT sdp_test_fail_provider_credential_retirement`
      );
    }
  });

  it("does not create a GCP secret when reserving the rotation candidate fails", async () => {
    env.CREDENTIAL_SECRET_STORE_BACKEND = "gcp_secret_manager";
    env.GCP_SECRET_MANAGER_PROJECT_ID = "sdp-lifecycle-test";
    env.GCP_SECRET_MANAGER_SECRET_PREFIX = "sdp-provider-credentials";
    env.GCP_SECRET_MANAGER_API_BASE_URL = "https://gcp-lifecycle.test";
    const requests: Array<{ url: string; method: string }> = [];
    let secretRef: string | undefined;
    let versionRef: string | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      requests.push({ url: url.href, method });
      if (url.hostname === "metadata.google.internal") {
        return url.pathname.endsWith("/numeric-project-id")
          ? new Response("1234567890")
          : Response.json({ access_token: "gcp-sensitive-token", expires_in: 300 });
      }
      if (url.hostname !== "gcp-lifecycle.test") throw new Error("Unexpected provider request");
      const secretId = url.searchParams.get("secretId");
      if (secretId) {
        secretRef = `projects/1234567890/secrets/${secretId}`;
        return Response.json({ name: secretRef });
      }
      if (url.pathname.endsWith(":addVersion")) {
        if (!secretRef) throw new Error("Version requested before secret creation");
        versionRef = `${secretRef}/versions/7`;
        return Response.json({ name: versionRef });
      }
      if (url.pathname === `/v1/${versionRef}:destroy`) {
        return Response.json({ name: versionRef, state: "DESTROYED" });
      }
      if (url.pathname === `/v1/${versionRef}` && method === "GET") {
        return Response.json({ name: versionRef, state: "ENABLED" });
      }
      throw new Error("Unexpected GCP request");
    };
    vi.stubGlobal("fetch", fetcher);
    const logger = getLogger();
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => logger);
    const db = getDb(env);
    const original = await db.queryOne("SELECT * FROM provider_credentials WHERE id = ?", [
      CREDENTIAL_ID,
    ]);
    await db.execute(
      `ALTER TABLE provider_credentials ADD CONSTRAINT sdp_test_fail_gcp_rotation_insert
         CHECK (credential_version = 1) NOT VALID`
    );
    try {
      await expect(
        lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
          method: "POST",
          key: "rotate-gcp-insert-rollback",
          body: { fields: { appId: APP_ID, appSecret: "new-gcp-secret" } },
        })
      ).rejects.toMatchObject({ code: "23514" });
      expect(versionRef).toBeUndefined();
      expect(requests.filter((request) => request.method === "POST")).toEqual([]);
      expect(await db.queryMany("SELECT * FROM provider_credentials")).toEqual([original]);
      expect(
        await db.queryMany<{ provider_credential_id: string }>(
          "SELECT provider_credential_id FROM custody_connections ORDER BY id"
        )
      ).toEqual([
        { provider_credential_id: CREDENTIAL_ID },
        { provider_credential_id: CREDENTIAL_ID },
      ]);
      const orphanLogs = errorLog.mock.calls.filter(
        (call) => call[1] === "provider_credential_orphan_risk"
      );
      expect(orphanLogs).toHaveLength(0);
      const logs = JSON.stringify(errorLog.mock.calls);
      for (const sensitive of [
        "new-gcp-secret",
        "gcp-sensitive-token",
        "sensitive-upstream-cleanup-detail",
        "projects/1234567890/secrets/",
      ]) {
        expect(logs).not.toContain(sensitive);
      }
    } finally {
      await db.execute(
        "ALTER TABLE provider_credentials DROP CONSTRAINT sdp_test_fail_gcp_rotation_insert"
      );
    }
  });

  it("exposes an in-flight GCP candidate without permitting a second writer or completion", async () => {
    const started = deferredVoid();
    const released = deferredVoid();
    const gcp = mockGcpRotation({
      beforeAddResponse: async () => {
        started.resolve();
        await released.promise;
      },
    });
    const request = {
      method: "POST" as const,
      key: "rotate-gcp-in-flight",
      body: { fields: { appId: APP_ID, appSecret: "in-flight-secret" } },
    };
    const rotation = lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, request);
    try {
      await started.promise;
      const read = await lifecycleRequest(`/connections/${CONNECTION_A_ID}/provider-credential`);
      expect(read.status).toBe(200);
      const body = z
        .object({
          data: z.object({
            rotationCandidate: z.object({ id: z.string(), status: z.literal("creating") }),
          }),
        })
        .parse(await read.json());
      const candidateId = body.data.rotationCandidate.id;
      expect(
        (await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, request)).status
      ).toBe(503);
      expect(
        (
          await lifecycleRequest(`/provider-credentials/${candidateId}/complete-rotation`, {
            method: "POST",
          })
        ).status
      ).toBe(503);
      expect(
        (
          await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
            ...request,
            key: "rotate-gcp-other-key",
          })
        ).status
      ).toBe(409);
      expect(gcp.requests.filter(({ url }) => url.endsWith(":addVersion"))).toHaveLength(1);
      expect(await activeConnectionCredentialIds()).toEqual([
        { provider_credential_id: CREDENTIAL_ID },
        { provider_credential_id: CREDENTIAL_ID },
      ]);
    } finally {
      released.resolve();
      await rotation;
    }
    expect((await rotation).status).toBe(200);
  });

  it.each(["create", "lost_response"] as const)(
    "retains cleanup work when GCP fails at %s",
    async (writeFailure) => {
      const gcp = mockGcpRotation({ writeFailure });
      const request = {
        method: "POST" as const,
        key: `rotate-gcp-${writeFailure}`,
        body: { fields: { appId: APP_ID, appSecret: "failed-gcp-write-secret" } },
      };
      const response = await lifecycleRequest(
        `/provider-credentials/${CREDENTIAL_ID}/rotate`,
        request
      );
      expect(response.status).toBe(503);
      const rows = await getDb(env).queryMany<{
        id: string;
        status: string;
        last_failure_code: string | null;
        secret_ref: string | null;
        secret_version_ref: string | null;
        secret_retention_expires_at: string | null;
      }>(
        "SELECT id, status, last_failure_code, secret_ref, secret_version_ref, secret_retention_expires_at FROM provider_credentials ORDER BY credential_version"
      );
      expect(rows).toEqual([
        expect.objectContaining({
          id: CREDENTIAL_ID,
          status: "active",
          secret_retention_expires_at: null,
        }),
        expect.objectContaining({
          status: "deactivated",
          last_failure_code: "secret_creation_abandoned",
          secret_ref: expect.stringContaining("/secrets/sdp-provider-credentials-"),
          secret_version_ref: null,
          secret_retention_expires_at: expect.any(String),
        }),
      ]);
      expect(gcp.versions.size).toBe(writeFailure === "lost_response" ? 1 : 0);
      expect(await activeConnectionCredentialIds()).toEqual([
        { provider_credential_id: CREDENTIAL_ID },
        { provider_credential_id: CREDENTIAL_ID },
      ]);
      const writesBeforeReplay = gcp.requests.filter(({ method }) => method === "POST");
      expect(
        (await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, request)).status
      ).toBe(409);
      expect(gcp.requests.filter(({ method }) => method === "POST")).toEqual(writesBeforeReplay);
      expect(gcp.requests.some(({ url }) => url.endsWith(":destroy"))).toBe(false);
    }
  );

  it("retains and destroys the acknowledged rotation version after SQL rejects finalization", async () => {
    const gcp = mockGcpRotation();
    const db = getDb(env);
    await db.execute(
      `ALTER TABLE provider_credentials ADD CONSTRAINT sdp_test_fail_gcp_finalization
       CHECK (credential_version = 1 OR status IN ('creating', 'deactivated')) NOT VALID`
    );
    try {
      await expect(
        lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
          method: "POST",
          key: "rotate-gcp-finalization-sql-failure",
          body: { fields: { appId: APP_ID, appSecret: "sql-rejected-gcp-secret" } },
        })
      ).rejects.toMatchObject({ code: "23514" });
      expect(gcp.versions.size).toBe(1);
      expect(
        await db.queryOne(
          "SELECT status, last_failure_code, secret_version_ref, secret_retention_expires_at FROM provider_credentials WHERE rotated_from_provider_credential_id = ?",
          [CREDENTIAL_ID]
        )
      ).toEqual({
        status: "deactivated",
        last_failure_code: "secret_creation_abandoned",
        secret_version_ref: firstPersistedGcpVersionRef(gcp),
        secret_retention_expires_at: expect.any(String),
      });
      expect(await activeConnectionCredentialIds()).toEqual([
        { provider_credential_id: CREDENTIAL_ID },
        { provider_credential_id: CREDENTIAL_ID },
      ]);
      expect(gcp.requests.some(({ url }) => url.endsWith(":destroy"))).toBe(false);
      await expect(cleanupRetiredProviderCredentialSecrets(env)).resolves.toMatchObject({
        cleaned: 1,
        failed: 0,
      });
      expect(gcp.requests.filter(({ url }) => url.endsWith(":destroy"))).toEqual([
        {
          url: `https://gcp-lifecycle.test/v1/${firstPersistedGcpVersionRef(gcp)}:destroy`,
          method: "POST",
        },
      ]);
    } finally {
      await db.execute(
        "ALTER TABLE provider_credentials DROP CONSTRAINT sdp_test_fail_gcp_finalization"
      );
    }
  });

  it("keeps a GCP candidate cancelled when its late write response arrives", async () => {
    const started = deferredVoid();
    const released = deferredVoid();
    const gcp = mockGcpRotation({
      beforeAddResponse: async () => {
        started.resolve();
        await released.promise;
      },
    });
    const request = {
      method: "POST" as const,
      key: "rotate-gcp-cancel-creating",
      body: { fields: { appId: APP_ID, appSecret: "late-gcp-write-secret" } },
    };
    const rotation = lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, request);
    let candidateId: string | undefined;
    try {
      await started.promise;
      const read = await lifecycleRequest(`/connections/${CONNECTION_A_ID}/provider-credential`);
      candidateId = z
        .object({ data: z.object({ rotationCandidate: z.object({ id: z.string() }) }) })
        .parse(await read.json()).data.rotationCandidate.id;
      const cancelled = await lifecycleRequest(`/provider-credentials/${candidateId}/deactivate`, {
        method: "POST",
      });
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toMatchObject({
        data: { providerCredential: { id: candidateId, status: "deactivated" } },
      });
    } finally {
      released.resolve();
      await rotation;
    }
    expect((await rotation).status).toBe(409);
    expect(
      await getDb(env).queryOne(
        "SELECT status, last_failure_code, secret_version_ref, secret_retention_expires_at FROM provider_credentials WHERE id = ?",
        [candidateId]
      )
    ).toEqual({
      status: "deactivated",
      last_failure_code: "secret_creation_abandoned",
      secret_version_ref: firstPersistedGcpVersionRef(gcp),
      secret_retention_expires_at: expect.any(String),
    });
    expect(await activeConnectionCredentialIds()).toEqual([
      { provider_credential_id: CREDENTIAL_ID },
      { provider_credential_id: CREDENTIAL_ID },
    ]);
    expect(gcp.requests.some(({ url }) => new URL(url).hostname === "api.privy.io")).toBe(false);
    expect(
      (await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, request)).status
    ).toBe(409);
    expect(gcp.requests.filter(({ url }) => url.endsWith(":addVersion"))).toHaveLength(1);
  });

  it("reopens legacy absence metadata when a cancelled writer acknowledges its version", async () => {
    const db = getDb(env);
    let candidateId = "";
    const gcp = mockGcpRotation({
      beforeAddResponse: async () => {
        const candidate = await db.queryOne<{ id: string }>(
          "SELECT id FROM provider_credentials WHERE status = 'creating'"
        );
        if (!candidate) throw new Error("Missing creating candidate");
        candidateId = candidate.id;
        await new ProviderCredentialStore(db).abandonCredentialCreation({
          organizationId: ORGANIZATION_ID,
          credentialId: candidateId,
        });
        await db.execute(
          `UPDATE provider_credentials SET secret_retention_expires_at = NULL,
        secret_cleanup_outcome = 'assumed_absent', secret_cleanup_absent_since = '2000-01-01T00:00:00.000Z'
        WHERE id = ?`,
          [candidateId]
        );
      },
    });
    const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "legacy-absence-ack",
      body: { fields: { appId: APP_ID, appSecret: "late-known-secret" } },
    });
    expect(response.status).toBe(409);
    expect(
      await db.queryOne(
        "SELECT secret_version_ref, secret_cleanup_outcome, secret_cleanup_absent_since FROM provider_credentials WHERE id = ?",
        [candidateId]
      )
    ).toEqual({
      secret_version_ref: firstPersistedGcpVersionRef(gcp),
      secret_cleanup_outcome: null,
      secret_cleanup_absent_since: null,
    });
    await expect(cleanupRetiredProviderCredentialSecrets(env)).resolves.toMatchObject({
      cleaned: 1,
      failed: 0,
    });
    expect(
      await db.queryOne(
        "SELECT secret_retention_expires_at FROM provider_credentials WHERE id = ?",
        [candidateId]
      )
    ).toEqual({ secret_retention_expires_at: null });
  });

  it.each([
    { privyStatus: 200, status: "active" },
    { privyStatus: 503, status: "pending" },
  ])(
    "preserves an adopted GCP candidate after a lost finalization COMMIT ($status)",
    async ({ privyStatus, status }) => {
      const db = getDb(env);
      const runTransaction = db.transaction.bind(db);
      const gcp = mockGcpRotation({
        privyStatus,
        beforeAddResponse: async () => {
          vi.spyOn(db, "transaction").mockImplementationOnce(async (callback) => {
            await runTransaction(callback);
            throw new Error("Lost finalization COMMIT response");
          });
        },
      });
      const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
        method: "POST",
        key: `rotate-gcp-adopted-${status}`,
        body: { fields: { appId: APP_ID, appSecret: "adopted-gcp-secret" } },
      });
      expect(response.status).toBe(200);
      const { data } = credentialResponseSchema.parse(await response.json());
      expect(
        await db.queryOne(
          "SELECT status, secret_version_ref, secret_retention_expires_at FROM provider_credentials WHERE id = ?",
          [data.providerCredential.id]
        )
      ).toEqual({
        status,
        secret_version_ref: firstPersistedGcpVersionRef(gcp),
        secret_retention_expires_at: null,
      });
      const currentId = status === "active" ? data.providerCredential.id : CREDENTIAL_ID;
      expect(await activeConnectionCredentialIds()).toEqual([
        { provider_credential_id: currentId },
        { provider_credential_id: currentId },
      ]);
      expect(gcp.requests.some(({ url }) => url.endsWith(":destroy"))).toBe(false);
      expect(gcp.requests.filter(({ url }) => url.endsWith(":addVersion"))).toHaveLength(1);
    }
  );

  it.each([true, false])(
    "retains GCP ownership when finalization reconciliation is unavailable (committed: %s)",
    async (committed) => {
      const db = getDb(env);
      const runTransaction = db.transaction.bind(db);
      const lostCommit = new Error("Lost finalization COMMIT response");
      const gcp = mockGcpRotation({
        beforeAddResponse: async () => {
          vi.spyOn(db, "transaction")
            .mockImplementationOnce(async (callback) => {
              if (committed) await runTransaction(callback);
              else
                await expect(
                  runTransaction(async (tx) => {
                    await callback(tx);
                    throw lostCommit;
                  })
                ).rejects.toBe(lostCommit);
              throw lostCommit;
            })
            .mockRejectedValueOnce(new Error("Reconciliation database unavailable"));
        },
      });
      const request = {
        method: "POST" as const,
        key: `rotate-gcp-unknown-${committed}`,
        body: { fields: { appId: APP_ID, appSecret: "uncertain-gcp-secret" } },
      };
      expect(
        (await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, request)).status
      ).toBe(503);
      expect(
        await db.queryOne(
          "SELECT status, secret_version_ref, last_failure_code FROM provider_credentials WHERE rotated_from_provider_credential_id = ?",
          [CREDENTIAL_ID]
        )
      ).toEqual({
        status: committed ? "pending" : "creating",
        secret_version_ref: committed ? firstPersistedGcpVersionRef(gcp) : null,
        last_failure_code: null,
      });
      expect(await activeConnectionCredentialIds()).toEqual([
        { provider_credential_id: CREDENTIAL_ID },
        { provider_credential_id: CREDENTIAL_ID },
      ]);
      expect(gcp.requests.some(({ url }) => url.endsWith(":destroy"))).toBe(false);
      const replay = await lifecycleRequest(
        `/provider-credentials/${CREDENTIAL_ID}/rotate`,
        request
      );
      expect(replay.status).toBe(committed ? 200 : 503);
      expect(gcp.requests.filter(({ url }) => url.endsWith(":addVersion"))).toHaveLength(1);
    }
  );

  it("never writes GCP after losing the reservation COMMIT acknowledgement", async () => {
    const gcp = mockGcpRotation();
    const db = getDb(env);
    const runTransaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce(async (callback) => {
      await runTransaction(callback);
      throw new Error("Lost reservation COMMIT response");
    });
    const request = {
      method: "POST" as const,
      key: "rotate-gcp-unknown-reservation",
      body: { fields: { appId: APP_ID, appSecret: "unwritten-gcp-secret" } },
    };
    expect(
      (await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, request)).status
    ).toBe(503);
    expect(
      await db.queryOne(
        "SELECT status, secret_version_ref FROM provider_credentials WHERE rotated_from_provider_credential_id = ?",
        [CREDENTIAL_ID]
      )
    ).toEqual({ status: "creating", secret_version_ref: null });
    expect(
      (await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, request)).status
    ).toBe(503);
    expect(gcp.requests.filter(({ method }) => method === "POST")).toEqual([]);
    expect(gcp.versions.size).toBe(0);
    expect(await activeConnectionCredentialIds()).toEqual([
      { provider_credential_id: CREDENTIAL_ID },
      { provider_credential_id: CREDENTIAL_ID },
    ]);
  });

  it("rejects only the candidate when Privy rejects the new credentials", async () => {
    const providerFetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", providerFetch);

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

  it("audits a rejected rotation once across replays", async () => {
    const providerFetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", providerFetch);
    const request = {
      method: "POST" as const,
      key: "rotate-rejected-audit",
      body: { fields: { appId: APP_ID, appSecret: "invalid-secret" } },
    };
    const response = await lifecycleRequest(
      `/provider-credentials/${CREDENTIAL_ID}/rotate`,
      request
    );
    expect(response.status).toBe(200);
    const events = await rotationFailureEvents();
    expect(events).toEqual([
      { resource_id: expect.any(String), status: "failure", failure_code: "invalid_credentials" },
    ]);

    const replay = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, request);
    expect(replay.status).toBe(200);
    expect(await rotationFailureEvents()).toEqual(events);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a valid credential for a different Privy account without changing the current credential", async () => {
    const providerFetch = vi.fn().mockResolvedValue(Response.json({ data: [] }));
    vi.stubGlobal("fetch", providerFetch);
    const db = getDb(env);
    const original = await db.queryOne("SELECT * FROM provider_credentials WHERE id = ?", [
      CREDENTIAL_ID,
    ]);

    const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-different-privy-account",
      body: { fields: { appId: "different-privy-app", appSecret: "valid-other-secret" } },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { providerCredential: { id: string } };
    };
    expect(body).toMatchObject({
      data: {
        providerCredential: { status: "failed_validation" },
        rotation: { status: "failed", code: "provider_account_mismatch" },
      },
    });
    expect(body.data.providerCredential.id).not.toBe(CREDENTIAL_ID);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(
      await db.queryOne("SELECT * FROM provider_credentials WHERE id = ?", [CREDENTIAL_ID])
    ).toEqual(original);
    expect(
      await db.queryMany<{ id: string; provider_credential_id: string }>(
        "SELECT id, provider_credential_id FROM custody_connections ORDER BY id"
      )
    ).toEqual([
      { id: CONNECTION_A_ID, provider_credential_id: CREDENTIAL_ID },
      { id: CONNECTION_B_ID, provider_credential_id: CREDENTIAL_ID },
    ]);
    expect(
      await db.queryOne<{
        status: string;
        last_failure_code: string | null;
        rotated_from_provider_credential_id: string | null;
        encrypted_secret_payload: string | null;
      }>(
        `SELECT status, last_failure_code, rotated_from_provider_credential_id,
                encrypted_secret_payload
         FROM provider_credentials WHERE id = ?`,
        [body.data.providerCredential.id]
      )
    ).toEqual({
      status: "failed_validation",
      last_failure_code: "provider_account_mismatch",
      rotated_from_provider_credential_id: CREDENTIAL_ID,
      encrypted_secret_payload: null,
    });
    expect(await rotationFailureEvents()).toEqual([
      {
        resource_id: body.data.providerCredential.id,
        status: "failure",
        failure_code: "provider_account_mismatch",
      },
    ]);
  });

  it("emits one rejection outcome when two completions reject the same candidate", async () => {
    const providerFetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", providerFetch);
    const pending = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-concurrent-rejection",
      body: { fields: { appId: APP_ID, appSecret: "rejected-secret" } },
    });
    const { data } = credentialResponseSchema.parse(await pending.json());
    const candidateId = data.providerCredential.id;
    let checksStarted = 0;
    let releaseChecks = () => {};
    const bothChecking = new Promise<void>((resolve) => {
      releaseChecks = resolve;
    });
    providerFetch.mockImplementation(async () => {
      if (++checksStarted === 2) releaseChecks();
      await bothChecking;
      return new Response(null, { status: 401 });
    });

    const results = await Promise.all([
      lifecycleRequest(`/provider-credentials/${candidateId}/complete-rotation`, {
        method: "POST",
      }),
      lifecycleRequest(`/provider-credentials/${candidateId}/complete-rotation`, {
        method: "POST",
      }),
    ]);
    for (const response of results) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { rotation: { status: "failed", code: "invalid_credentials" } },
      });
    }
    expect(await rotationFailureEvents()).toEqual([
      { resource_id: candidateId, status: "failure", failure_code: "invalid_credentials" },
    ]);
    expect(
      await getDb(env).queryOne<{ count: number }>(
        `SELECT count(*) AS count FROM audit_logs
         WHERE action = 'maintenance'
           AND metadata::jsonb ->> 'event' = 'provider_credential_rotation_rejection_not_committed'`
      )
    ).toEqual({ count: 1 });
  });

  it("keeps a rejection intent unresolved when the COMMIT response is lost", async () => {
    const logger = getLogger();
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const providerFetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", providerFetch);
    const pending = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-rejection-commit-unknown",
      body: { fields: { appId: APP_ID, appSecret: "rejected-secret" } },
    });
    const { data } = credentialResponseSchema.parse(await pending.json());
    const candidateId = data.providerCredential.id;
    providerFetch.mockResolvedValue(new Response(null, { status: 401 }));
    const db = getDb(env);
    const runTransaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce(async (callback) => {
      await runTransaction(callback);
      throw new Error("Lost COMMIT response");
    });

    const response = await lifecycleRequest(
      `/provider-credentials/${candidateId}/complete-rotation`,
      {
        method: "POST",
      }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { rotation: { status: "failed", code: "invalid_credentials" } },
    });
    expect(await rotationFailureEvents()).toEqual([]);
    expect(
      await db.queryOne<{ count: number }>(
        `SELECT count(*) AS count FROM audit_logs intent
       WHERE intent.metadata::jsonb ->> 'auditPhase' = 'intent'
         AND intent.metadata::jsonb -> 'target' ->> 'resourceId' = ?
         AND NOT EXISTS (
           SELECT 1 FROM audit_logs outcome
           WHERE outcome.metadata::jsonb ->> 'auditIntentId' = intent.resource_id
         )`,
        [candidateId]
      )
    ).toEqual({ count: 1 });
    const intent = await db.queryOne<{ resource_id: string }>(
      `SELECT resource_id FROM audit_logs
       WHERE metadata::jsonb ->> 'auditPhase' = 'intent'
         AND metadata::jsonb -> 'target' ->> 'resourceId' = ?`,
      [candidateId]
    );
    expect(warning).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "sdp_api_credential_lifecycle_audit_unresolved",
        provider_credential_id: candidateId,
        audit_intent_id: intent?.resource_id,
        reason: "commit_outcome_unknown",
      }),
      "sdp_api_credential_lifecycle_audit_unresolved"
    );
  });

  describe.each([
    {
      operation: "rotation",
      command: "complete-rotation",
      event: "provider_credential_rotated",
      action: "rotate",
    },
    {
      operation: "rollback",
      command: "rollback",
      event: "provider_credential_rolled_back",
      action: "rollback",
    },
    {
      operation: "cancellation",
      command: "deactivate",
      event: "provider_credential_rotation_canceled",
      action: "deactivate",
    },
  ])("$operation COMMIT recovery", ({ operation, command, event, action }) => {
    it.each([false, true])(
      "keeps the ambiguous intent unresolved (transaction committed: %s)",
      async (committed) => {
        const secret = "commit-recovery-secret";
        const providerFetch = vi
          .fn()
          .mockResolvedValue(
            operation === "rollback"
              ? Response.json({ data: [] })
              : new Response(null, { status: 503 })
          );
        vi.stubGlobal("fetch", providerFetch);
        const initial = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
          method: "POST",
          key: "rotate-before-commit-recovery",
          body: { fields: { appId: APP_ID, appSecret: secret } },
        });
        expect(initial.status).toBe(200);
        const { data } = credentialResponseSchema.parse(await initial.json());
        const candidateId = data.providerCredential.id;
        const targetId = operation === "rollback" ? CREDENTIAL_ID : candidateId;
        const path = `/provider-credentials/${candidateId}/${command}`;
        providerFetch.mockImplementation(async () => Response.json({ data: [] }));

        const logger = getLogger();
        const warning = vi.spyOn(logger, "warn").mockImplementation(() => logger);
        const db = getDb(env);
        const runTransaction = db.transaction.bind(db);
        const lostCommit = new Error(`Lost COMMIT response with sensitive detail: ${secret}`);
        vi.spyOn(db, "transaction").mockImplementationOnce(async (callback) => {
          if (committed) {
            await runTransaction(callback);
          } else {
            // The callback completes, but its writes roll back before another
            // request wins. The loser then observes the winner's committed state.
            await expect(
              runTransaction(async (tx) => {
                await callback(tx);
                throw lostCommit;
              })
            ).rejects.toBe(lostCommit);
            const winner = await lifecycleRequest(path, { method: "POST" });
            expect(winner.status).toBe(200);
          }
          throw lostCommit;
        });

        const response = await lifecycleRequest(path, { method: "POST" });
        expect(response.status).toBe(200);
        expect(
          credentialResponseSchema.parse(await response.json()).data.providerCredential.id
        ).toBe(targetId);
        const outcomes = await db.queryMany<{ id: string }>(
          `SELECT id FROM audit_logs
           WHERE organization_id = ? AND status = 'success'
             AND metadata::jsonb ->> 'event' = ?`,
          [ORGANIZATION_ID, event]
        );
        expect(outcomes).toHaveLength(committed ? 0 : 1);
        const unresolved = await db.queryMany<{ resource_id: string }>(
          `SELECT intent.resource_id FROM audit_logs intent
           WHERE intent.organization_id = ?
             AND intent.metadata::jsonb ->> 'auditPhase' = 'intent'
             AND intent.metadata::jsonb -> 'target' ->> 'resourceId' = ?
             AND intent.metadata::jsonb -> 'target' ->> 'action' = ?
             AND NOT EXISTS (
               SELECT 1 FROM audit_logs outcome
               WHERE outcome.organization_id = intent.organization_id
                 AND outcome.metadata::jsonb ->> 'auditIntentId' = intent.resource_id
             )`,
          [ORGANIZATION_ID, targetId, action]
        );
        expect(unresolved).toHaveLength(1);
        const intent = unresolved[0];
        if (!intent) throw new Error("Expected the unresolved lifecycle intent");
        expect(warning).toHaveBeenCalledExactlyOnceWith(
          {
            event: "sdp_api_credential_lifecycle_audit_unresolved",
            organization_id: ORGANIZATION_ID,
            project_id: PROJECT_A_ID,
            provider: "privy",
            provider_credential_id: targetId,
            audit_intent_id: intent.resource_id,
            request_id: "req_provider_credential_lifecycle",
            operation: action,
            reason: "commit_outcome_unknown",
          },
          "sdp_api_credential_lifecycle_audit_unresolved"
        );
        expect(JSON.stringify(warning.mock.calls)).not.toContain(secret);
      }
    );
  });

  it("keeps rejected credentials pending when their audit intent cannot be persisted", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const db = getDb(env);
    await db.execute(
      `ALTER TABLE audit_logs ADD CONSTRAINT sdp_test_fail_rotation_audit
       CHECK (action <> 'maintenance') NOT VALID`
    );
    try {
      await expect(
        lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
          method: "POST",
          key: "rotate-audit-unavailable",
          body: { fields: { appId: APP_ID, appSecret: "rejected-secret" } },
        })
      ).rejects.toThrow("Required audit record could not be persisted");
      expect(
        await db.queryOne<{ status: string; has_secret: boolean }>(
          `SELECT status, encrypted_secret_payload IS NOT NULL AS has_secret
           FROM provider_credentials WHERE idempotency_key = 'rotate-audit-unavailable'`
        )
      ).toEqual({ status: "pending", has_secret: true });
      expect(await rotationFailureEvents()).toEqual([]);
    } finally {
      await db.execute("ALTER TABLE audit_logs DROP CONSTRAINT sdp_test_fail_rotation_audit");
    }
  });

  it("logs an unreadable candidate secret without exposing its stored contents", async () => {
    const providerFetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", providerFetch);
    const pending = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-unreadable-secret",
      body: { fields: { appId: APP_ID, appSecret: "new-secret" } },
    });
    const { data } = credentialResponseSchema.parse(await pending.json());
    const candidateId = data.providerCredential.id;
    await getDb(env).execute(
      "UPDATE provider_credentials SET encrypted_secret_payload = ? WHERE id = ?",
      ["invalid-secret-ciphertext", candidateId]
    );
    const logger = getLogger();
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => logger);

    const response = await lifecycleRequest(
      `/provider-credentials/${candidateId}/complete-rotation`,
      {
        method: "POST",
      }
    );
    expect(response.status).toBe(500);
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "sdp_api_credential_lifecycle_failure",
        stage: "secret_read",
        provider_credential_id: candidateId,
        error_name: "CredentialSecretStoreError",
        error_code: "MISSING_SECRET",
      }),
      "sdp_api_credential_lifecycle_failure"
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("invalid-secret-ciphertext");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("new-secret");
    expect(providerFetch).toHaveBeenCalledTimes(1);
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

  it("rolls every connection back even when the rotation quota is exhausted", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
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

    await seedRateLimit(
      env,
      `metered:credential-rotation:org:${ORGANIZATION_ID}:user:${USER_ID}`,
      5
    );
    await seedRateLimit(env, `metered:credential-rotation:org:${ORGANIZATION_ID}`, 20);

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

  it("allocates beyond failed versions when retrying with a new rotation intent", async () => {
    const providerFetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", providerFetch);
    const rejected = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "lineage-version-rejected",
      body: { fields: { appId: APP_ID, appSecret: "rejected-secret" } },
    });
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({
      data: { providerCredential: { status: "failed_validation" } },
    });
    providerFetch.mockResolvedValue(Response.json({ data: [] }));
    expect(
      await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
        method: "POST",
        key: "lineage-version-after-rejection",
        body: { fields: { appId: APP_ID, appSecret: "replacement-secret" } },
      })
    ).toMatchObject({ status: 200 });
    expect(
      await getDb(env).queryMany<{ credential_version: number }>(
        `SELECT credential_version FROM provider_credentials
         WHERE organization_id = ? ORDER BY credential_version`,
        [ORGANIZATION_ID]
      )
    ).toEqual([{ credential_version: 1 }, { credential_version: 2 }, { credential_version: 3 }]);
  });

  it("allocates beyond a rolled-back descendant without reusing its version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => Response.json({ data: [] }))
    );
    const secondResponse = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "lineage-version-two",
      body: { fields: { appId: APP_ID, appSecret: "second-secret" } },
    });
    expect(secondResponse.status).toBe(200);
    const second = credentialResponseSchema.parse(await secondResponse.json()).data
      .providerCredential;
    const thirdResponse = await lifecycleRequest(`/provider-credentials/${second.id}/rotate`, {
      method: "POST",
      key: "lineage-version-three",
      body: { fields: { appId: APP_ID, appSecret: "third-secret" } },
    });
    expect(thirdResponse.status).toBe(200);
    const third = credentialResponseSchema.parse(await thirdResponse.json()).data
      .providerCredential;
    expect(
      await lifecycleRequest(`/provider-credentials/${third.id}/rollback`, { method: "POST" })
    ).toMatchObject({ status: 200 });
    expect(
      await lifecycleRequest(`/provider-credentials/${second.id}/rotate`, {
        method: "POST",
        key: "lineage-version-four",
        body: { fields: { appId: APP_ID, appSecret: "fourth-secret" } },
      })
    ).toMatchObject({ status: 200 });
    expect(
      await getDb(env).queryMany<{ credential_version: number }>(
        `SELECT credential_version FROM provider_credentials
         WHERE organization_id = ? ORDER BY credential_version`,
        [ORGANIZATION_ID]
      )
    ).toEqual([
      { credential_version: 1 },
      { credential_version: 2 },
      { credential_version: 3 },
      { credential_version: 4 },
    ]);
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
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
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
    await seedRateLimit(
      env,
      `metered:credential-rotation:org:${ORGANIZATION_ID}:user:${USER_ID}`,
      5
    );
    await seedRateLimit(env, `metered:credential-rotation:org:${ORGANIZATION_ID}`, 20);
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
    expect(
      await getDb(env).queryOne<{ secret_retention_expires_at: string | null }>(
        "SELECT secret_retention_expires_at FROM provider_credentials WHERE id = ?",
        [rotatedBody.data.providerCredential.id]
      )
    ).toEqual({ secret_retention_expires_at: expect.any(String) });
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
    expect((await canceled.json()).error).toEqual({
      code: "CONFLICT",
      message: "Credential cannot be deactivated while it is in use",
    });
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

  it("validates credentials at the 4096-character input limit", async () => {
    const appId = "a".repeat(4096);
    const appSecret = ` ${"s".repeat(4094)} `;
    const providerFetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", providerFetch);

    const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-max-length-fields",
      body: { fields: { appId: ` ${appId} `, appSecret } },
    });

    expect(response.status).toBe(200);
    expect(providerFetch).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`,
          "privy-app-id": appId,
        }),
      })
    );
  });

  it.each(["appId", "appSecret"])("rejects oversized %s before secret-store I/O", async (field) => {
    env.CREDENTIAL_SECRET_STORE_BACKEND = "gcp_secret_manager";
    env.GCP_SECRET_MANAGER_PROJECT_ID = "sdp-lifecycle-test";
    env.GCP_SECRET_MANAGER_SECRET_PREFIX = "sdp-provider-credentials";
    const providerFetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", providerFetch);

    const response = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-oversized-field",
      body: { fields: { appId: APP_ID, appSecret: "new-secret", [field]: "x".repeat(4097) } },
    });

    expect(response.status).toBe(400);
    expect(providerFetch).not.toHaveBeenCalled();
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
    const providerFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: [] }))
      .mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", providerFetch);
    const rotated = await lifecycleRequest(`/provider-credentials/${CREDENTIAL_ID}/rotate`, {
      method: "POST",
      key: "rotate-before-pending-child",
      body: { fields: { appId: APP_ID, appSecret: "new-secret" } },
    });
    expect(rotated.status).toBe(200);
    const rotatedBody = (await rotated.json()) as {
      data: { providerCredential: { id: string } };
    };
    expect(rotatedBody.data).toMatchObject({
      providerCredential: { status: "active" },
      rotation: { status: "success" },
    });
    const currentId = rotatedBody.data.providerCredential.id;

    const pending = await lifecycleRequest(`/provider-credentials/${currentId}/rotate`, {
      method: "POST",
      key: "rotate-pending-before-rollback",
      body: { fields: { appId: APP_ID, appSecret: "pending-secret" } },
    });
    expect(pending.status).toBe(200);
    const pendingBody = (await pending.json()) as {
      data: { providerCredential: { id: string } };
    };
    expect(pendingBody.data).toMatchObject({
      providerCredential: { status: "pending" },
      rotation: { status: "retry_unknown", code: "provider_response_unknown" },
    });
    const candidateId = pendingBody.data.providerCredential.id;

    const response = await lifecycleRequest(`/provider-credentials/${currentId}/rollback`, {
      method: "POST",
    });

    expect(response.status).toBe(409);
    expect(providerFetch).toHaveBeenCalledTimes(2);
    const state = await lifecycleRequest(`/connections/${CONNECTION_A_ID}/provider-credential`);
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({
      data: {
        providerCredential: { id: currentId, status: "active" },
        rotationCandidate: { id: candidateId, status: "pending" },
        rollback: {
          providerCredential: { id: CREDENTIAL_ID, status: "retired" },
          expiresAt: expect.any(String),
        },
      },
    });
    expect(
      await getDb(env).queryMany<{ provider_credential_id: string }>(
        "SELECT provider_credential_id FROM custody_connections ORDER BY id"
      )
    ).toEqual([{ provider_credential_id: currentId }, { provider_credential_id: currentId }]);

    const canceled = await lifecycleRequest(`/provider-credentials/${candidateId}/deactivate`, {
      method: "POST",
    });
    expect(canceled.status).toBe(200);
    expect(await canceled.json()).toMatchObject({
      data: { providerCredential: { id: candidateId, status: "deactivated" } },
    });
    expect(
      await getDb(env).queryOne<{ status: string; encrypted_secret_payload: string | null }>(
        "SELECT status, encrypted_secret_payload FROM provider_credentials WHERE id = ?",
        [candidateId]
      )
    ).toEqual({ status: "deactivated", encrypted_secret_payload: null });
    const afterCancellation = await lifecycleRequest(
      `/connections/${CONNECTION_A_ID}/provider-credential`
    );
    expect(afterCancellation.status).toBe(200);
    expect(await afterCancellation.json()).toMatchObject({
      data: {
        providerCredential: { id: currentId, status: "active" },
        rotationCandidate: null,
      },
    });
    expect(providerFetch).toHaveBeenCalledTimes(2);
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
