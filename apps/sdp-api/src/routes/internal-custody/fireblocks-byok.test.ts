import { execFileSync } from "node:child_process";
import { verify } from "node:crypto";
import { type Context, Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { runWithTenantDatabaseIdentity } from "@/db/identity";
import { FireblocksCsrRepository } from "@/db/repositories/fireblocks-csr.repository";
import { verifyClerkJwt } from "@/lib/clerk-token";
import { AppError } from "@/lib/errors";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { createCredentialSecretStore } from "@/services/credential-secret-store";
import { eraseExpiredFireblocksCsrs } from "@/services/custody/fireblocks-registration.service";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { ProviderCredentialSecretCleanupStore } from "@/services/stores/provider-credential-secret-cleanup.store";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";
import { internalCustody } from "./index";

const ORGANIZATION_ID = "org_fireblocks_byok";
const USER_ID = "usr_fireblocks_byok";
const PROJECT_ID = "prj_fireblocks_byok";
const ADDRESS = "11111111111111111111111111111111";
const OTHER_ADDRESS = "So11111111111111111111111111111111111111112";
const fields = {
  apiKey: "tenant-fireblocks-key",
  signingKeyId: "",
  vaultAccountId: "0",
};
const body = {
  provider: "fireblocks",
  fields: { credentialLabel: "Fireblocks treasury", scope: "project", ...fields },
  walletLabel: "Treasury",
};
let token: string;
let auditContext: Context<{ Bindings: Env }>;
let app: Hono<{ Bindings: Env }>;
const testEnv: Env = {
  ...env,
  SDP_DEPLOYMENT_MODE: "self_hosted",
  CREDENTIAL_SECRET_STORE_BACKEND: "encrypted_db",
  CUSTODY_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64"),
  FIREBLOCKS_API_BASE_URL: "https://fireblocks.example.test",
  FIREBLOCKS_API_KEY: "deployment-key-must-not-be-used",
  FIREBLOCKS_API_SECRET: "deployment-secret-must-not-be-used",
};

function request(
  path: string,
  payload?: unknown,
  projectId = PROJECT_ID,
  key = crypto.randomUUID()
) {
  return app.request(
    `/internal/dashboard/custody${path}`,
    {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Project-ID": projectId,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    },
    testEnv
  );
}

function providerResponse(address = ADDRESS) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ addresses: [{ address }] }));
}

async function connect(projectId = PROJECT_ID) {
  if (projectId !== PROJECT_ID)
    body.fields.signingKeyId = (await newRegistration(projectId)).signingKeyId;
  const submitted = await request("/provider-credentials", body, projectId);
  expect(submitted.status, await submitted.clone().text()).toBe(201);
  const { data } = await submitted.json();
  const completed = await request(`/connections/${data.connectionId}/complete`, {}, projectId);
  expect(completed.status).toBe(200);
  expect((await completed.json()).data.completion.status).toBe("success");
  return z
    .object({ connectionId: z.string(), providerCredential: z.object({ id: z.string() }) })
    .parse(data);
}

async function newRegistration(projectId = PROJECT_ID) {
  const response = await request("/fireblocks/csr", {}, projectId);
  expect(response.status, await response.clone().text()).toBe(201);
  const { data } = await response.json();
  return { ...fields, signingKeyId: data.csr.id };
}

beforeEach(async () => {
  testEnv.SDP_RELEASE_CHANNEL = "beta";
  testEnv.CREDENTIAL_SECRET_STORE_BACKEND = "encrypted_db";
  await seedTestDatabase(env);
  await clearKVStores(env);
  const db = getDb(env);
  await db.execute(
    "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, 'Fireblocks BYOK', 'fireblocks-byok', 'enterprise', 'active')",
    [ORGANIZATION_ID]
  );
  await db.execute(
    "INSERT INTO users (id, email, email_verified, status) VALUES (?, 'fireblocks-byok@example.com', 1, 'active')",
    [USER_ID]
  );
  await db.execute(
    "INSERT INTO organization_members (id, organization_id, user_id, role, status) VALUES ('mem_fireblocks_byok', ?, ?, 'admin', 'active')",
    [ORGANIZATION_ID, USER_ID]
  );
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [USER_ID],
    ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
  });
  await db.execute(
    "UPDATE organizations SET settings = (settings::jsonb || ?::jsonb)::text WHERE id = ?",
    [JSON.stringify({ providerOverrides: { custody: { fireblocks: true } } }), ORGANIZATION_ID]
  );
  token = await signSeededClerkMember(testEnv, db, USER_ID, ORGANIZATION_ID);
  await verifyClerkJwt(token, testEnv);
  app = new Hono<{ Bindings: Env }>();
  app.use("*", kvStoreMiddleware());
  app.use("*", async (c, next) => {
    c.set("requestId", "req_fireblocks_byok");
    auditContext = c;
    await next();
  });
  app.route("/internal/dashboard/custody", internalCustody);
  app.onError((error) => {
    if (error instanceof AppError)
      return Response.json(error.toResponse(), { status: error.statusCode });
    throw error;
  });
  fields.signingKeyId = (await newRegistration()).signingKeyId;
  body.fields.signingKeyId = fields.signingKeyId;
});
afterEach(() => vi.restoreAllMocks());

describe("Fireblocks BYOK lifecycle", () => {
  it("refuses stable CSR, discovery, installation and rotation before provider calls or writes", async () => {
    const fetch = providerResponse();
    const connected = await connect();
    const registration = await newRegistration();
    const pending = await request("/provider-credentials", {
      ...body,
      fields: { ...body.fields, ...registration },
    });
    expect(pending.status).toBe(201);
    const pendingId = (await pending.json()).data.connectionId;
    const before = await getDb(env).queryMany(
      "SELECT id, status FROM provider_credentials WHERE organization_id = ? ORDER BY id",
      [ORGANIZATION_ID]
    );
    testEnv.SDP_RELEASE_CHANNEL = "stable";
    fetch.mockClear();
    const discoveryFields = { apiKey: fields.apiKey, signingKeyId: fields.signingKeyId };
    for (const [path, payload] of [
      ["/fireblocks/csr", undefined],
      ["/fireblocks/csr", {}],
      ["/fireblocks/vaults", discoveryFields],
      ["/provider-credentials", body],
      [`/connections/${pendingId}/complete`, {}],
      [
        `/provider-credentials/${connected.providerCredential.id}/rotate`,
        { provider: "fireblocks", fields: registration },
      ],
    ] as const) {
      const response = await request(path, payload);
      expect(response.status, await response.clone().text()).toBe(403);
      expect(await response.text()).toContain("custody_provider_not_in_release_channel");
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await getDb(env).queryMany(
        "SELECT id, status FROM provider_credentials WHERE organization_id = ? ORDER BY id",
        [ORGANIZATION_ID]
      )
    ).toEqual(before);
    // Channel changes must leave cancellation available for existing installations.
    expect((await request(`/connections/${pendingId}/cancel`, {})).status).toBe(200);
  });

  it("encrypts credentials, attaches the vault with one read and replays completion", async () => {
    const fetch = providerResponse();
    const connected = await connect();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      `${testEnv.FIREBLOCKS_API_BASE_URL}/v1/vault/accounts/0/SOL_TEST/addresses_paginated`,
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "X-API-Key": fields.apiKey }),
      })
    );
    const credential = await getDb(env).queryOne<{ encrypted_secret_payload: string }>(
      "SELECT encrypted_secret_payload FROM provider_credentials WHERE id = ?",
      [connected.providerCredential.id]
    );
    expect(credential?.encrypted_secret_payload).not.toContain(fields.apiKey);
    const payload = await createCredentialSecretStore(testEnv).read({
      orgId: ORGANIZATION_ID,
      stored: {
        storageBackend: "encrypted_db",
        encryptedSecretPayload: credential?.encrypted_secret_payload,
      },
    });
    expect(payload).toMatchObject({
      apiKey: fields.apiKey,
      vaultAccountId: "0",
      assetId: "SOL_TEST",
      apiSecretPem: expect.stringContaining("BEGIN PRIVATE KEY"),
    });
    expect(payload).not.toHaveProperty("signingKeyId");
    expect(
      await getDb(env).queryOne(
        "SELECT encrypted_private_key FROM fireblocks_csr_requests WHERE id = ?",
        [fields.signingKeyId]
      )
    ).toEqual({ encrypted_private_key: null });
    const replay = await request(`/connections/${connected.connectionId}/complete`, {});
    expect(replay.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    const listed = await request("/connections?provider=fireblocks");
    const serialized = JSON.stringify(await listed.json());
    expect(serialized).toContain("fireblocks");
    expect(serialized).not.toContain(fields.apiKey);
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    const wallet = await getDb(env).queryOne(
      "SELECT wallet_id, public_key FROM custody_wallets WHERE custody_connection_id = ?",
      [connected.connectionId]
    );
    expect(wallet).toEqual({ wallet_id: "fb_0", public_key: ADDRESS });
  });

  it("pins production to SOL and rejects browser URL or asset overrides", async () => {
    const fetch = providerResponse();
    await connect(`${PROJECT_ID}_production`);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("/SOL/addresses_paginated");
    for (const extra of [
      { apiBaseUrl: "https://attacker.invalid" },
      { assetId: "SOL" },
      { apiSecretPem: "client-supplied-key" },
    ]) {
      expect(
        (await request("/provider-credentials", { ...body, fields: { ...body.fields, ...extra } }))
          .status
      ).toBe(400);
    }
  });

  it("keeps Privy and Fireblocks setup independent and refuses cross-provider replacement", async () => {
    const first = await request("/provider-credentials", body);
    const connectionId = (await first.json()).data.connectionId;
    const privy = {
      provider: "privy",
      fields: { credentialLabel: "Privy", scope: "project", appId: "app", appSecret: "secret" },
    };
    expect((await request("/provider-credentials", privy)).status).toBe(201);
    expect((await request(`/connections/${connectionId}/provider-credentials`, privy)).status).toBe(
      404
    );
    expect((await request("/provider-credentials", body)).status).toBe(409);
  });

  it("rejects invalid credentials without creating or signing a wallet", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("denied", { status: 401 }));
    const created = (await (await request("/provider-credentials", body)).json()).data;
    const checked = await request(`/connections/${created.connectionId}/complete`, {});
    expect((await checked.json()).data.completion).toMatchObject({
      status: "failed",
      code: "invalid_credentials",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      await getDb(env).queryMany("SELECT id FROM custody_wallets WHERE custody_connection_id = ?", [
        created.connectionId,
      ])
    ).toEqual([]);
  });

  it("requires an explicit matching rotation provider before credential I/O", async () => {
    const fetch = providerResponse();
    const connected = await connect();
    fetch.mockClear();
    for (const payload of [
      { fields: { appId: "app", appSecret: "secret" } },
      { provider: "fireblocks", fields: { appId: "app", appSecret: "secret" } },
      { provider: "privy", fields: { appId: "app", appSecret: "secret" } },
    ]) {
      const response = await request(
        `/provider-credentials/${connected.providerCredential.id}/rotate`,
        payload
      );
      expect(response.status).toBe(400);
    }
    expect(fetch).not.toHaveBeenCalled();
    const credentials = await getDb(env).queryMany(
      "SELECT id FROM provider_credentials WHERE organization_id = ?",
      [ORGANIZATION_ID]
    );
    expect(credentials).toHaveLength(1);
  });

  it("rotates only within the pinned vault and can roll back to the prior credential", async () => {
    const fetch = providerResponse();
    const connected = await connect();
    fetch.mockImplementation(async () =>
      Response.json({ addresses: [{ address: OTHER_ADDRESS }] })
    );
    const rejected = await request(
      `/provider-credentials/${connected.providerCredential.id}/rotate`,
      { provider: "fireblocks", fields: { ...(await newRegistration()), apiKey: "foreign-key" } }
    );
    expect((await rejected.json()).data.rotation).toEqual({
      status: "failed",
      code: "provider_account_mismatch",
    });
    fetch.mockImplementation(async () => Response.json({ addresses: [{ address: ADDRESS }] }));
    const rotated = await request(
      `/provider-credentials/${connected.providerCredential.id}/rotate`,
      {
        provider: "fireblocks",
        fields: { ...(await newRegistration()), apiKey: "replacement-key" },
      }
    );
    const rotation = (await rotated.json()).data;
    expect(rotation.rotation.status).toBe("success");
    expect(rotation.providerCredential.provider).toBe("fireblocks");
    const rolledBack = await request(
      `/provider-credentials/${rotation.providerCredential.id}/rollback`,
      {}
    );
    expect(rolledBack.status).toBe(200);
    const connection = await getDb(env).queryOne<{ provider_credential_id: string }>(
      "SELECT provider_credential_id FROM custody_connections WHERE id = ?",
      [connected.connectionId]
    );
    expect(connection?.provider_credential_id).toBe(connected.providerCredential.id);
  });

  it("resolves only the owned wallet through the keychain Fireblocks signer", async () => {
    const fetch = providerResponse();
    const connected = await connect();
    const wallet = await getDb(env).queryOne<{ id: string }>(
      "SELECT id FROM custody_wallets WHERE custody_connection_id = ?",
      [connected.connectionId]
    );
    if (!wallet) throw new Error("Missing wallet");
    const resolver = new CustodyRuntimeTargets(getDb(env), testEnv, new Map());
    const managedAdapter = vi.fn();
    const signer = await resolver.getTransactionSignerForWalletRecord(
      ORGANIZATION_ID,
      PROJECT_ID,
      wallet.id,
      "payments.transfer",
      managedAdapter
    );
    expect(signer.address).toBe(ADDRESS);
    expect(managedAdapter).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
    await resolver.getTransactionSignerForWalletRecord(
      ORGANIZATION_ID,
      PROJECT_ID,
      wallet.id,
      "payments.transfer",
      managedAdapter
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(
      resolver.getTransactionSignerForWalletRecord(
        ORGANIZATION_ID,
        `${PROJECT_ID}_production`,
        wallet.id,
        "payments.transfer",
        managedAdapter
      )
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockImplementation(async () =>
      Response.json({ addresses: [{ address: OTHER_ADDRESS }] })
    );
    const uncached = new CustodyRuntimeTargets(getDb(env), testEnv, new Map());
    await expect(
      uncached.getTransactionSignerForWalletRecord(
        ORGANIZATION_ID,
        PROJECT_ID,
        wallet.id,
        "payments.transfer",
        managedAdapter
      )
    ).rejects.toThrow();
  });
  it("provisions an additional vault with tenant credentials and reuses its fetched address", async () => {
    const fetch = providerResponse();
    const connected = await connect();
    fetch.mockReset();
    fetch
      .mockResolvedValueOnce(Response.json({ id: "42" }))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({ addresses: [{ address: OTHER_ADDRESS }] }));
    const resolver = new CustodyRuntimeTargets(getDb(env), testEnv, new Map());
    const wallet = await resolver.createConnectionWallet({
      auditContext,
      creationReason: "wallet_api",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      connectionId: connected.connectionId,
      label: "Operations",
      purpose: "transfer",
    });
    expect(wallet).toMatchObject({
      walletId: "fb_42",
      publicKey: OTHER_ADDRESS,
      custodyConnectionId: connected.connectionId,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [, init] of fetch.mock.calls)
      expect(new Headers(init?.headers).get("X-API-Key")).toBe(fields.apiKey);
  });

  it("reserves GCP credentials before writing and includes Fireblocks containers in cleanup", async () => {
    testEnv.CREDENTIAL_SECRET_STORE_BACKEND = "gcp_secret_manager";
    testEnv.GCP_SECRET_MANAGER_PROJECT_ID = "fireblocks-test";
    testEnv.GCP_SECRET_MANAGER_SECRET_PREFIX = "sdp-provider-credentials";
    testEnv.GCP_SECRET_MANAGER_API_BASE_URL = "https://gcp-fireblocks.test";
    let sawReservation = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "metadata.google.internal")
        return url.pathname.endsWith("/numeric-project-id")
          ? new Response("1234567890")
          : Response.json({ access_token: "test-token", expires_in: 300 });
      if (url.searchParams.has("secretId")) return Response.json({});
      if (url.pathname.endsWith(":addVersion")) {
        const creating = await getDb(env).queryOne(
          "SELECT provider, status, secret_next_scan_at FROM provider_credentials WHERE organization_id = ?",
          [ORGANIZATION_ID]
        );
        expect(creating).toMatchObject({
          provider: "fireblocks",
          status: "creating",
          secret_next_scan_at: expect.anything(),
        });
        sawReservation = true;
        return Response.json({
          name: `${url.pathname.slice(4, -":addVersion".length).replace("projects/fireblocks-test/", "projects/1234567890/")}/versions/1`,
        });
      }
      throw new Error("Unexpected GCP request");
    });
    const submitted = await request("/provider-credentials", body);
    expect(submitted.status, await submitted.clone().text()).toBe(201);
    expect(sawReservation).toBe(true);
    const { data } = await submitted.json();
    const cleanup = new ProviderCredentialSecretCleanupStore(getDb(env));
    expect(await cleanup.listDueContainers(new Date(Date.now() + 60_000), 10)).toEqual([
      expect.objectContaining({ id: data.providerCredential.id }),
    ]);
  });
});

describe("Fireblocks CSR security", () => {
  it("keeps repository reads, claims and retirement bound to the CSR's project and tenant", async () => {
    providerResponse();
    const connected = await connect();
    const { signingKeyId } = await newRegistration();
    const repo = new FireblocksCsrRepository(getDb(env));
    const scope = { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID };
    const original = await repo.getForDiscovery(scope, signingKeyId);
    expect(original).not.toBeNull();
    for (const other of [
      { ...scope, projectId: `${PROJECT_ID}_production` },
      { ...scope, organizationId: "org_another" },
    ]) {
      expect(await repo.getForDiscovery(other, signingKeyId)).toBeNull();
      expect(await repo.claimForRegistration(other, signingKeyId, "another-request")).toBeNull();
      await repo.retire(other, signingKeyId, connected.providerCredential.id);
      expect(await repo.getForDiscovery(scope, signingKeyId)).toEqual(original);
    }
    expect(await repo.claimForRegistration(scope, signingKeyId, "owner-request")).toEqual(original);
    expect(await repo.claimForRegistration(scope, signingKeyId, "other-request")).toBeNull();
    expect(await repo.claimForRegistration(scope, signingKeyId, "owner-request")).toEqual(original);
    expect(await repo.getForDiscovery(scope, signingKeyId)).toBeNull();
    await repo.retire(scope, signingKeyId, connected.providerCredential.id);
    expect(await repo.claimForRegistration(scope, signingKeyId, "owner-request")).toBeNull();
  });

  it("returns only public material, encrypts the key, and isolates projects and tenants", async () => {
    const response = await request("/fireblocks/csr");
    const { data } = await response.json();
    expect(Object.keys(data.csr).sort()).toEqual(["csrPem", "expiresAt", "id"]);
    expect(data.csr.id).toBe(fields.signingKeyId);
    expect(data.csr.csrPem).toContain("BEGIN CERTIFICATE REQUEST");
    expect(JSON.stringify(data)).not.toContain("PRIVATE KEY");
    const stored = await getDb(env).queryOne<{ encrypted_private_key: string }>(
      "SELECT encrypted_private_key FROM fireblocks_csr_requests WHERE id = ?",
      [fields.signingKeyId]
    );
    expect(stored?.encrypted_private_key).toBeTruthy();
    expect(stored?.encrypted_private_key).not.toContain("PRIVATE KEY");
    expect(
      (await (await request("/fireblocks/csr", undefined, `${PROJECT_ID}_production`)).json()).data
        .csr
    ).toBeNull();
    expect((await request("/provider-credentials", body, `${PROJECT_ID}_production`)).status).toBe(
      404
    );
    const hidden = await runWithTenantDatabaseIdentity({ organizationId: "org_another" }, () =>
      getDb(env).queryMany("SELECT * FROM fireblocks_csr_requests")
    );
    expect(hidden).toEqual([]);
    expect((await request("/fireblocks/csr")).status).toBe(200);
  });

  it("deduplicates concurrent CSR generation and preserves submission replay after key retirement", async () => {
    const key = crypto.randomUUID();
    const responses = await Promise.all([
      request("/fireblocks/csr", {}, PROJECT_ID, key),
      request("/fireblocks/csr", {}, PROJECT_ID, key),
    ]);
    const successful = responses.find((response) => response.status === 201);
    if (!successful) throw new Error("Expected a successful CSR request");
    for (const response of responses) {
      if (response.status === 409) {
        expect((await response.json()).error.code).toBe("IDEMPOTENCY_KEY_IN_FLIGHT");
      } else expect(response.status).toBe(201);
    }
    const first = (await successful.json()).data.csr;
    const csrReplay = await request("/fireblocks/csr", {}, PROJECT_ID, key);
    expect(csrReplay.status).toBe(201);
    expect((await csrReplay.json()).data.csr).toEqual(first);
    expect(first.id).not.toBe(fields.signingKeyId);
    const previous = (await (await request("/fireblocks/csr", undefined)).json()).data.csr;
    expect(previous.id).toBe(first.id);
    const payload = { ...body, fields: { ...body.fields, signingKeyId: first.id } };
    const submissionKey = crypto.randomUUID();
    const submitted = await request("/provider-credentials", payload, PROJECT_ID, submissionKey);
    expect(submitted.status).toBe(201);
    const submittedData = (await submitted.json()).data;
    const replay = await request("/provider-credentials", payload, PROJECT_ID, submissionKey);
    expect(replay.status).toBe(201);
    expect((await replay.json()).data.providerCredential.id).toBe(
      submittedData.providerCredential.id
    );
    expect(
      (
        await request(
          "/provider-credentials",
          { ...payload, fields: { ...payload.fields, apiKey: "changed" } },
          PROJECT_ID,
          submissionKey
        )
      ).status
    ).toBe(409);
  });

  it("authenticates real keychain requests with the generated CSR's public key", async () => {
    const { data } = await (await request("/fireblocks/csr")).json();
    const publicKey = execFileSync("openssl", ["req", "-pubkey", "-noout"], {
      input: data.csr.csrPem,
      encoding: "utf8",
    });
    const fetch = providerResponse();
    await connect();
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    const jwt = headers.get("Authorization")?.replace(/^Bearer /, "");
    expect(jwt).toBeTruthy();
    const [header, payload, signature] = z.string().parse(jwt).split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString()).alg).toBe("RS256");
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, "base64url")
      )
    ).toBe(true);
    expect(headers.get("X-API-Key")).toBe(fields.apiKey);
  });

  it("refuses expired registrations and erases their staging keys", async () => {
    await getDb(env).execute(
      "UPDATE fireblocks_csr_requests SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
      [fields.signingKeyId]
    );
    expect((await (await request("/fireblocks/csr")).json()).data.csr).toBeNull();
    expect((await request("/provider-credentials", body)).status).toBe(404);
    await eraseExpiredFireblocksCsrs(getDb(env));
    expect(
      await getDb(env).queryOne(
        "SELECT encrypted_private_key FROM fireblocks_csr_requests WHERE id = ?",
        [fields.signingKeyId]
      )
    ).toEqual({ encrypted_private_key: null });
  });

  it("requires an entitled credential administrator and bounds RSA generation", async () => {
    const unauthenticated = await app.request(
      "/internal/dashboard/custody/fireblocks/csr",
      {},
      testEnv
    );
    expect(unauthenticated.status).toBe(401);
    await newRegistration();
    await newRegistration();
    expect((await request("/fireblocks/csr", {})).status).toBe(429);
    await getDb(env).execute("UPDATE organizations SET settings = '{}' WHERE id = ?", [
      ORGANIZATION_ID,
    ]);
    expect((await request("/fireblocks/csr")).status).toBe(403);
  });
});

describe("Fireblocks vault discovery and selection", () => {
  it("lists named Solana vaults with a CSR-authenticated request and keeps pagination on the configured host", async () => {
    const csr = (await (await request("/fireblocks/csr")).json()).data.csr.csrPem;
    const publicKey = execFileSync("openssl", ["req", "-pubkey", "-noout"], {
      input: csr,
      encoding: "utf8",
    });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(testEnv.FIREBLOCKS_API_BASE_URL);
      expect(url.pathname).toBe("/v1/vault/accounts_paged");
      expect(url.searchParams.get("assetId")).toBe("SOL_TEST");
      expect(url.searchParams.get("limit")).toBe("50");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      const headers = new Headers(init?.headers);
      expect(headers.get("X-API-Key")).toBe(fields.apiKey);
      const jwt = headers.get("Authorization")?.slice(7).split(".");
      if (jwt?.length !== 3) throw new Error("Missing JWT");
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(`${jwt[0]}.${jwt[1]}`),
          publicKey,
          Buffer.from(jwt[2], "base64url")
        )
      ).toBe(true);
      expect(JSON.parse(Buffer.from(jwt[1], "base64url").toString())).toMatchObject({
        sub: fields.apiKey,
        uri: url.pathname + url.search,
      });
      return Response.json({
        accounts: [
          { id: "0", name: "Treasury", assets: [{ id: "SOL_TEST", total: "999" }] },
          { id: "1", name: "Other network", assets: [{ id: "SOL" }] },
        ],
        paging: { after: "page&2" },
        nextUrl: "https://untrusted.example/vaults",
      });
    });
    const input = { apiKey: fields.apiKey, signingKeyId: fields.signingKeyId };
    const result = await request("/fireblocks/vaults", input);
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect((await result.json()).data).toEqual({
      vaults: [{ id: "0", name: "Treasury", hasSolanaWallet: true }],
      nextCursor: "page&2",
    });
    expect((await request("/fireblocks/vaults", { ...input, after: "page&2" })).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetch.mock.calls[1]?.[0])).searchParams.get("after")).toBe("page&2");
    expect(
      await getDb(env).queryOne(
        "SELECT claim_fingerprint, consumed_at FROM fireblocks_csr_requests WHERE id = ?",
        [fields.signingKeyId]
      )
    ).toEqual({ claim_fingerprint: null, consumed_at: null });
  });

  it("refuses cross-project and expired discovery before calling Fireblocks", async () => {
    const fetch = providerResponse();
    const input = { apiKey: fields.apiKey, signingKeyId: fields.signingKeyId };
    expect((await request("/fireblocks/vaults", input, `${PROJECT_ID}_production`)).status).toBe(
      404
    );
    await getDb(env).execute(
      "UPDATE fireblocks_csr_requests SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
      [fields.signingKeyId]
    );
    expect((await request("/fireblocks/vaults", input)).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns actionable authorization errors without echoing provider secrets", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream secret body", { status: 401 })
    );
    const response = await request("/fireblocks/vaults", {
      apiKey: fields.apiKey,
      signingKeyId: fields.signingKeyId,
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("registration is approved");
    expect(text).not.toContain("upstream secret body");
    expect(text).not.toContain(fields.apiKey);
  });

  function selectedVaultResponses(secondStatus?: number) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(init?.method).toBe("GET");
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/addresses_paginated"))
        return Response.json({
          addresses: [{ address: path.includes("/7/") ? OTHER_ADDRESS : ADDRESS }],
        });
      const id = path.split("/").at(-1);
      if (id === "7" && secondStatus) return new Response(null, { status: secondStatus });
      return Response.json({
        id,
        name: id === "7" ? "Operations" : "Treasury",
        assets: [{ id: "SOL_TEST" }],
      });
    });
  }
  function selectedPayload(ids = ["0", "7"]) {
    return {
      provider: "fireblocks",
      fields: { ...body.fields, vaultAccountId: ids[0] },
      fireblocksVaultAccountIds: ids,
    };
  }

  async function connectSelectedVaults() {
    const submitted = await request("/provider-credentials", selectedPayload());
    expect(submitted.status).toBe(201);
    const data = z
      .object({
        connectionId: z.string(),
        providerCredential: z.object({ id: z.string() }),
      })
      .parse((await submitted.json()).data);
    const completed = await request(`/connections/${data.connectionId}/complete`, {});
    expect((await completed.json()).data.completion.status).toBe("success");
    return data;
  }

  async function attachedState(connectionId: string) {
    return getDb(env).queryMany(
      `SELECT c.provider_credential_id, w.wallet_id, w.public_key, w.status
       FROM custody_connections c JOIN custody_wallets w ON w.custody_connection_id = c.id
       WHERE c.id = ? ORDER BY w.wallet_id`,
      [connectionId]
    );
  }

  const secondaryFailures = [
    { name: "forbidden", httpStatus: 403, code: "invalid_credentials" },
    { name: "missing", httpStatus: 404, code: "invalid_credentials" },
    { name: "changed address", httpStatus: 200, code: "provider_account_mismatch" },
    { name: "unavailable", httpStatus: 500, code: "provider_response_unknown" },
  ] as const;

  it.each(secondaryFailures)(
    "keeps all wallets on the current credential when rotation's secondary vault is $name",
    async ({ httpStatus, code }) => {
      const fetch = selectedVaultResponses();
      const connected = await connectSelectedVaults();
      // Inactive wallets retain the connection and can be reactivated later.
      await getDb(env).execute(
        "UPDATE custody_wallets SET status = 'inactive' WHERE custody_connection_id = ? AND wallet_id = 'fb_7'",
        [connected.connectionId]
      );
      const before = await attachedState(connected.connectionId);
      const registration = await newRegistration();
      fetch.mockClear().mockImplementation(async (input) => {
        if (String(input).includes("/7/")) {
          if (httpStatus !== 200) return new Response(null, { status: httpStatus });
          return Response.json({ addresses: [{ address: ADDRESS }] });
        }
        return Response.json({ addresses: [{ address: ADDRESS }] });
      });
      const response = await request(
        `/provider-credentials/${connected.providerCredential.id}/rotate`,
        {
          provider: "fireblocks",
          fields: { ...registration, apiKey: "replacement-key" },
        }
      );
      expect(response.status).toBe(200);
      const result = (await response.json()).data;
      expect(result.rotation).toEqual({
        status: httpStatus === 500 ? "retry_unknown" : "failed",
        code,
      });
      expect(await attachedState(connected.connectionId)).toEqual(before);
      expect(fetch).toHaveBeenCalledTimes(2);
      if (httpStatus === 500) {
        fetch.mockImplementation(async (input) =>
          Response.json({
            addresses: [{ address: String(input).includes("/7/") ? OTHER_ADDRESS : ADDRESS }],
          })
        );
        const retry = await request(
          `/provider-credentials/${result.providerCredential.id}/complete-rotation`,
          {}
        );
        expect((await retry.json()).data.rotation.status).toBe("success");
        expect(fetch).toHaveBeenCalledTimes(4);
      }
    }
  );

  it.each(secondaryFailures)(
    "keeps all wallets on the current credential when rollback's secondary vault is $name",
    async ({ httpStatus }) => {
      const fetch = selectedVaultResponses();
      const connected = await connectSelectedVaults();
      const response = await request(
        `/provider-credentials/${connected.providerCredential.id}/rotate`,
        {
          provider: "fireblocks",
          fields: { ...(await newRegistration()), apiKey: "replacement-key" },
        }
      );
      const rotated = (await response.json()).data;
      expect(rotated.rotation.status).toBe("success");
      const before = await attachedState(connected.connectionId);
      fetch.mockClear().mockImplementation(async (input, init) => {
        expect(new Headers(init?.headers).get("X-API-Key")).toBe(fields.apiKey);
        if (String(input).includes("/7/") && httpStatus !== 200)
          return new Response(null, { status: httpStatus });
        return Response.json({ addresses: [{ address: ADDRESS }] });
      });
      const failed = await request(
        `/provider-credentials/${rotated.providerCredential.id}/rollback`,
        {}
      );
      expect(failed.status).toBe(httpStatus === 500 ? 503 : 409);
      expect(await attachedState(connected.connectionId)).toEqual(before);
      expect(fetch).toHaveBeenCalledTimes(2);
      fetch.mockClear().mockImplementation(async (input) =>
        Response.json({
          addresses: [{ address: String(input).includes("/7/") ? OTHER_ADDRESS : ADDRESS }],
        })
      );
      const retry = await request(
        `/provider-credentials/${rotated.providerCredential.id}/rollback`,
        {}
      );
      expect(retry.status).toBe(200);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(await attachedState(connected.connectionId)).toEqual(
        before.map((row) => ({
          ...row,
          provider_credential_id: connected.providerCredential.id,
        }))
      );
    }
  );

  it.each([
    { action: "rotate", mutation: "address" },
    { action: "rollback", mutation: "address" },
    { action: "rotate", mutation: "new wallet" },
    { action: "rollback", mutation: "new wallet" },
  ])(
    "rejects $action when an attached $mutation changes during verification",
    async ({ action, mutation }) => {
      const fetch = selectedVaultResponses();
      const connected = await connectSelectedVaults();
      const registration = await newRegistration();
      const replacement = {
        provider: "fireblocks",
        fields: { ...registration, apiKey: "replacement-key" },
      };
      let currentId = connected.providerCredential.id;
      if (action === "rollback") {
        const rotated = await request(`/provider-credentials/${currentId}/rotate`, replacement);
        const data = (await rotated.json()).data;
        expect(data.rotation.status).toBe("success");
        currentId = data.providerCredential.id;
      }
      fetch.mockClear().mockImplementation(async (input) => {
        if (String(input).includes("/7/")) {
          if (mutation === "address") {
            await getDb(env).execute(
              "UPDATE custody_wallets SET public_key = ? WHERE custody_connection_id = ? AND wallet_id = 'fb_7'",
              [ADDRESS, connected.connectionId]
            );
          } else {
            await getDb(env).execute(
              `INSERT INTO custody_wallets (id, custody_connection_id, wallet_id, public_key)
             VALUES (?, ?, 'fb_8', ?)`,
              [`cwlt_${crypto.randomUUID()}`, connected.connectionId, OTHER_ADDRESS]
            );
          }
          return Response.json({ addresses: [{ address: OTHER_ADDRESS }] });
        }
        return Response.json({ addresses: [{ address: ADDRESS }] });
      });
      const response = await request(
        `/provider-credentials/${currentId}/${action}`,
        action === "rotate" ? replacement : {}
      );
      expect(response.status).toBe(409);
      const rows = await attachedState(connected.connectionId);
      expect(rows).toHaveLength(mutation === "address" ? 2 : 3);
      expect(rows.every((row) => row.provider_credential_id === currentId)).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  );

  it("imports selected vaults atomically with provider names and replays without extra provider reads", async () => {
    const fetch = selectedVaultResponses();
    const idempotencyKey = crypto.randomUUID();
    const payload = selectedPayload();
    const submitted = await request("/provider-credentials", payload, PROJECT_ID, idempotencyKey);
    expect(submitted.status).toBe(201);
    const { connectionId } = (await submitted.json()).data;
    const complete = await request(`/connections/${connectionId}/complete`, {});
    expect((await complete.json()).data.completion.status).toBe("success");
    expect(fetch).toHaveBeenCalledTimes(4);
    const wallets = await getDb(env).queryMany(
      "SELECT wallet_id, public_key, label, purpose FROM custody_wallets WHERE custody_connection_id = ? ORDER BY wallet_id",
      [connectionId]
    );
    expect(wallets).toEqual([
      { wallet_id: "fb_0", public_key: ADDRESS, label: "Treasury", purpose: "transfer" },
      { wallet_id: "fb_7", public_key: OTHER_ADDRESS, label: "Operations", purpose: "transfer" },
    ]);
    expect((await request(`/connections/${connectionId}/complete`, {})).status).toBe(200);
    expect(
      (await request("/provider-credentials", payload, PROJECT_ID, idempotencyKey)).status
    ).toBe(201);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(
      (await request("/provider-credentials", selectedPayload(["0"]), PROJECT_ID, idempotencyKey))
        .status
    ).toBe(409);
    expect(
      (
        await new CustodyRuntimeTargets(getDb(env), testEnv, new Map()).resolve({
          kind: "wallet",
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          walletId: "fb_7",
        })
      )?.kind
    ).toBe("connection");
  });

  it.each([403, 404])(
    "imports no wallets when a selected vault returns HTTP %s",
    async (status) => {
      selectedVaultResponses(status);
      const submitted = await request("/provider-credentials", selectedPayload());
      const { connectionId } = (await submitted.json()).data;
      const result = await request(`/connections/${connectionId}/complete`, {});
      expect((await result.json()).data.completion).toMatchObject({
        status: "failed",
        code: "invalid_credentials",
      });
      expect(
        await getDb(env).queryMany(
          "SELECT id FROM custody_wallets WHERE custody_connection_id = ?",
          [connectionId]
        )
      ).toEqual([]);
      expect(
        await getDb(env).queryOne(
          "SELECT provider_account_fingerprint FROM custody_connections WHERE id = ?",
          [connectionId]
        )
      ).toEqual({ provider_account_fingerprint: null });
    }
  );

  it("rolls back every wallet when saving a later selected wallet fails", async () => {
    selectedVaultResponses();
    const submitted = await request("/provider-credentials", selectedPayload());
    const { connectionId } = (await submitted.json()).data;
    const db = getDb(env);
    await db.execute(
      "ALTER TABLE custody_wallets ADD CONSTRAINT sdp_test_fail_second_vault CHECK (wallet_id <> 'fb_7')"
    );
    try {
      const result = await request(`/connections/${connectionId}/complete`, {});
      expect(result.status, await result.clone().text()).toBe(409);
      expect(
        await db.queryMany("SELECT id FROM custody_wallets WHERE custody_connection_id = ?", [
          connectionId,
        ])
      ).toEqual([]);
      expect(
        await db.queryOne("SELECT status FROM custody_connections WHERE id = ?", [connectionId])
      ).not.toEqual({ status: "active" });
    } finally {
      await db.execute("ALTER TABLE custody_wallets DROP CONSTRAINT sdp_test_fail_second_vault");
    }
    // After the unresolved persistence lease expires, completion can safely reconcile.
    await db.execute("UPDATE custody_connections SET last_check_at = ? WHERE id = ?", [
      new Date(Date.now() - 10 * 60_000).toISOString(),
      connectionId,
    ]);
    const retry = await request(`/connections/${connectionId}/complete`, {});
    expect(retry.status, await retry.clone().text()).toBe(200);
    expect((await retry.json()).data.completion.status).toBe("success");
    expect(
      await db.queryMany("SELECT wallet_id FROM custody_wallets WHERE custody_connection_id = ?", [
        connectionId,
      ])
    ).toHaveLength(2);
  });

  it("refuses a vault already attached through another connection", async () => {
    selectedVaultResponses();
    await connect();
    body.fields.signingKeyId = (await newRegistration()).signingKeyId;
    const submitted = await request("/provider-credentials", selectedPayload(["7", "0"]));
    expect(submitted.status).toBe(201);
    const { connectionId } = (await submitted.json()).data;
    const completed = await request(`/connections/${connectionId}/complete`, {});
    expect(completed.status, await completed.clone().text()).toBe(409);
    expect(
      await getDb(env).queryOne(
        "SELECT status, last_check_failure_code FROM custody_connections WHERE id = ?",
        [connectionId]
      )
    ).toEqual({
      status: "failed",
      last_check_failure_code: "provider_account_already_connected",
    });
    expect(
      await getDb(env).queryMany("SELECT id FROM custody_wallets WHERE custody_connection_id = ?", [
        connectionId,
      ])
    ).toEqual([]);
  });

  it("rejects duplicate, oversized and mismatched selections before storing credentials", async () => {
    const fetch = providerResponse();
    for (const ids of [["0", "0"], Array.from({ length: 21 }, (_, i) => String(i))]) {
      expect((await request("/provider-credentials", selectedPayload(ids))).status).toBe(400);
    }
    expect(
      (
        await request("/provider-credentials", {
          ...selectedPayload(),
          fireblocksVaultAccountIds: ["7"],
        })
      ).status
    ).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});
