import type { CustodyProvider } from "@sdp/types";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import type { ClerkJwtPayload } from "@/lib/clerk-token";
import { AppError } from "@/lib/errors";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import {
  activateTestCustodyConnection,
  insertTestConnectionWallet,
  insertTestCustodyConnection,
  insertTestStoredProviderCredential,
  selectTestCustodyConnection,
  type TestStoredProviderCredential,
} from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
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

function buildApp(options: { injectJwt: boolean }) {
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
    if (options.injectJwt) {
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
  ]);
  await seedDefaultProjects(db, {
    organizationId: ORG.id,
    createdBy: USER.id,
    members: [USER.id],
    ids: { sandbox: PROJECT.id, production: `${PROJECT.id}_production` },
  });
}

async function seedCredentialAndConnection(input: {
  credentialId: string;
  connectionId: string;
  provider: CustodyProvider;
  label: string;
  status: "pending" | "failed";
  createdAt: string;
  failureCode: string | null;
  pendingWalletLabel: string | null;
}): Promise<void> {
  const db = getDb(env);
  const credential: TestStoredProviderCredential = {
    id: input.credentialId,
    organizationId: ORG.id,
    projectId: PROJECT.id,
    provider: input.provider,
    label: input.label,
    stored: { storageBackend: "encrypted_db", encryptedSecretPayload: SECRET_PAYLOAD },
    displayMetadata: {},
    status: "active",
    credentialVersion: 1,
    rotatedFromProviderCredentialId: null,
    lastValidatedAt: null,
    deactivatedAt: null,
    createdBy: null,
  };
  await insertTestStoredProviderCredential(db, credential);
  await insertTestCustodyConnection(db, {
    id: input.connectionId,
    organizationId: ORG.id,
    projectId: PROJECT.id,
    provider: input.provider,
    credential,
    status: input.status,
    setupMetadata:
      input.pendingWalletLabel === null ? {} : { pendingWalletLabel: input.pendingWalletLabel },
    providerAccountFingerprint: null,
    lastCheckStatus: input.failureCode === null ? null : "failed",
    lastCheckAt: input.failureCode === null ? null : input.createdAt,
    lastCheckFailureCode: input.failureCode,
    activatedAt: null,
    deactivatedAt: null,
    createdBy: null,
    createdAt: input.createdAt,
  });
}

async function makeConnectionRuntimeReady(
  connectionId: string,
  custodyWalletId: string
): Promise<void> {
  const db = getDb(env);
  await insertTestConnectionWallet(db, {
    id: custodyWalletId,
    connectionId,
    walletId: `provider-${custodyWalletId}`,
    publicKey: `address-${custodyWalletId}`,
    status: "active",
  });
  await activateTestCustodyConnection(db, {
    connectionId,
    custodyWalletId,
    providerAccountFingerprint: `fingerprint-${connectionId}`,
  });
}

async function seedRuntimeReadyConnection(connectionId: string, createdAt: string): Promise<void> {
  await seedCredentialAndConnection({
    credentialId: `pcred_${connectionId}`,
    connectionId,
    provider: "privy",
    label: "Shared label",
    status: "pending",
    createdAt,
    failureCode: null,
    pendingWalletLabel: null,
  });
  await makeConnectionRuntimeReady(connectionId, `cwlt_${connectionId}`);
}

async function selectConnection(connectionId: string): Promise<void> {
  await selectTestCustodyConnection(getDb(env), {
    id: "csd_connections_read",
    organizationId: ORG.id,
    projectId: PROJECT.id,
    connectionId,
  });
}

async function requestConnections(query: string): Promise<Response> {
  const { app, token } = buildApp({ injectJwt: true });
  return app.request(
    `/internal/dashboard/custody/connections${query}`,
    { headers: { Authorization: `Bearer ${token}`, "X-Project-ID": PROJECT.id } },
    env
  );
}

async function listConnections(query: string): Promise<{
  connections: Array<Record<string, unknown>>;
  pagination: { limit: number; offset: number; total: number };
}> {
  const response = await requestConnections(query);
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

  it("lists the scope's connections newest first through the safe Connection contract", async () => {
    await seedCredentialAndConnection({
      credentialId: "pcred_read_a",
      connectionId: "ccon_read_a",
      provider: "privy",
      label: "Failed treasury",
      status: "failed",
      createdAt: "2026-08-01T00:00:00.000Z",
      failureCode: "invalid_credentials",
      pendingWalletLabel: null,
    });
    await seedCredentialAndConnection({
      credentialId: "pcred_read_b",
      connectionId: "ccon_read_b",
      provider: "privy",
      label: "Pending treasury",
      status: "pending",
      createdAt: "2026-08-02T00:00:00.000Z",
      failureCode: null,
      pendingWalletLabel: "Treasury wallet",
    });

    const data = await listConnections("");

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
      provider: "privy",
      label: "Secret treasury",
      status: "failed",
      createdAt: "2026-08-01T00:00:00.000Z",
      failureCode: "raw_provider_stack",
      pendingWalletLabel: null,
    });

    const data = await listConnections("");
    expect(JSON.stringify(data)).not.toContain(SECRET_PAYLOAD);
    expect(JSON.stringify(data)).not.toContain("encrypted_secret_payload");
    expect(JSON.stringify(data)).not.toContain("raw_provider_stack");
    expect(data.connections[0]?.lastCheck).toMatchObject({ failureCode: null });
  });

  it("separates effective default selection from runtime eligibility", async () => {
    await seedRuntimeReadyConnection("ccon_read_selected", "2026-08-01T00:00:00.000Z");
    await seedRuntimeReadyConnection("ccon_read_unselected", "2026-08-02T00:00:00.000Z");
    await selectConnection("ccon_read_selected");

    const data = await listConnections("");
    const selected = data.connections.find((connection) => connection.id === "ccon_read_selected");
    const unselected = data.connections.find(
      (connection) => connection.id === "ccon_read_unselected"
    );

    expect(selected).toMatchObject({
      label: "Shared label",
      status: "active",
      isDefault: true,
      isRuntimeExecutionAllowed: true,
      defaultCustodyWalletId: "cwlt_ccon_read_selected",
    });
    expect(unselected).toMatchObject({
      label: "Shared label",
      status: "active",
      isDefault: false,
      isRuntimeExecutionAllowed: true,
      defaultCustodyWalletId: "cwlt_ccon_read_unselected",
    });

    await getDb(env)
      .prepare(
        `UPDATE custody_wallets SET status = 'inactive'
         WHERE id = 'cwlt_ccon_read_selected'`
      )
      .run();
    const unavailableDefault = (await listConnections("")).connections.find(
      (connection) => connection.id === "ccon_read_selected"
    );
    expect(unavailableDefault).toMatchObject({
      isDefault: true,
      isRuntimeExecutionAllowed: false,
    });
  });

  it("narrows the page and the total to one provider together", async () => {
    await seedCredentialAndConnection({
      credentialId: "pcred_filter_privy_old",
      connectionId: "ccon_filter_privy_old",
      provider: "privy",
      label: "Older Privy",
      status: "pending",
      createdAt: "2026-08-01T00:00:00.000Z",
      failureCode: null,
      pendingWalletLabel: null,
    });
    await seedCredentialAndConnection({
      credentialId: "pcred_filter_other",
      connectionId: "ccon_filter_other",
      provider: "turnkey",
      label: "Newer Turnkey",
      status: "pending",
      createdAt: "2026-08-05T00:00:00.000Z",
      failureCode: null,
      pendingWalletLabel: null,
    });

    const all = await listConnections("");
    expect(all.pagination.total).toBe(2);

    const privy = await listConnections("?provider=privy");
    expect(privy.connections.map((row) => row.id)).toEqual(["ccon_filter_privy_old"]);
    expect(privy.pagination.total).toBe(1);

    const turnkey = await listConnections("?provider=turnkey");
    expect(turnkey.connections.map((row) => row.id)).toEqual(["ccon_filter_other"]);
    expect(turnkey.pagination.total).toBe(1);
  });

  it("reaches a provider's connections past a page filled by another", async () => {
    for (let index = 0; index < 3; index += 1) {
      await seedCredentialAndConnection({
        credentialId: `pcred_filter_newer_${index}`,
        connectionId: `ccon_filter_newer_${index}`,
        provider: "turnkey",
        label: `Newer Turnkey ${index}`,
        status: "pending",
        createdAt: `2026-09-0${index + 1}T00:00:00.000Z`,
        failureCode: null,
        pendingWalletLabel: null,
      });
    }
    await seedCredentialAndConnection({
      credentialId: "pcred_filter_buried",
      connectionId: "ccon_filter_buried",
      provider: "privy",
      label: "Buried Privy",
      status: "pending",
      createdAt: "2026-08-01T00:00:00.000Z",
      failureCode: null,
      pendingWalletLabel: null,
    });

    const blind = await listConnections("?limit=3");
    expect(blind.connections.map((row) => row.provider)).toEqual(["turnkey", "turnkey", "turnkey"]);

    const privy = await listConnections("?provider=privy&limit=3");
    expect(privy.connections.map((row) => row.id)).toEqual(["ccon_filter_buried"]);
    expect(privy.pagination.total).toBe(1);
  });

  it("refuses an unknown provider rather than ignoring the filter", async () => {
    await seedCredentialAndConnection({
      credentialId: "pcred_filter_reject",
      connectionId: "ccon_filter_reject",
      provider: "privy",
      label: "Filtered Privy",
      status: "pending",
      createdAt: "2026-08-01T00:00:00.000Z",
      failureCode: null,
      pendingWalletLabel: null,
    });

    const response = await requestConnections("?provider=not_a_provider");
    expect(response.status).toBe(400);
  });

  it("bounds the page size and honors offsets", async () => {
    for (let index = 0; index < 3; index += 1) {
      await seedCredentialAndConnection({
        credentialId: `pcred_read_p${index}`,
        connectionId: `ccon_read_p${index}`,
        provider: "privy",
        label: `Paged treasury ${index}`,
        status: "failed",
        createdAt: `2026-08-0${index + 1}T00:00:00.000Z`,
        failureCode: "invalid_credentials",
        pendingWalletLabel: null,
      });
    }

    const page = await listConnections("?limit=2&offset=1");
    expect(page.connections).toHaveLength(2);
    expect(page.pagination).toEqual({ limit: 2, offset: 1, total: 3 });

    const clamped = await listConnections("?limit=9999");
    expect(clamped.pagination.limit).toBe(50);

    const fractional = await listConnections("?limit=1.5&offset=1.9");
    expect(fractional.pagination).toEqual({ limit: 1, offset: 1, total: 3 });

    const infinite = await listConnections("?limit=Infinity&offset=1e309");
    expect(infinite.pagination).toEqual({ limit: 50, offset: 0, total: 3 });

    const oversized = await listConnections("?offset=1e308");
    expect(oversized.pagination).toEqual({
      limit: 20,
      offset: Number.MAX_SAFE_INTEGER,
      total: 3,
    });
    expect(oversized.connections).toHaveLength(0);
  });
});
