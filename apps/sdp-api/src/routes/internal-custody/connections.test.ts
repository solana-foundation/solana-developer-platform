import type { CustodyConnectionLifecycle, CustodyProvider } from "@sdp/types/custody";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { AppError } from "@/lib/errors";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { insertTestCustodyWalletRow } from "@/test/helpers/custody";
import { seedCustodyAdmin } from "@/test/helpers/custody-admin";
import {
  activateTestCustodyConnection,
  insertTestCustodyConnection,
  insertTestStoredProviderCredential,
  type TestStoredProviderCredential,
} from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";
import { internalCustody } from "./index";

const ORGANIZATION_ID = "org_connections_read";
const PROJECT_ID = "prj_connections_read";
const OTHER_PROJECT_ID = `${PROJECT_ID}_production`;
const USER_ID = "usr_connections_read";
const SECRET_PAYLOAD = "encrypted-connections-read-secret";
const listSchema = z.object({
  data: z.object({
    connections: z.array(z.record(z.string(), z.unknown())),
    pagination: z.object({ limit: z.number(), offset: z.number(), total: z.number() }),
  }),
});

let token: string;
const app = new Hono<{ Bindings: Env }>();
app.use("*", kvStoreMiddleware());
app.route("/internal/dashboard/custody", internalCustody);
app.onError((error) => {
  if (error instanceof AppError)
    return Response.json(error.toResponse(), { status: error.statusCode });
  throw error;
});

async function seedCredentialAndConnection(input: {
  credentialId: string;
  connectionId: string;
  provider: CustodyProvider;
  label: string;
  status: Extract<CustodyConnectionLifecycle, "pending" | "failed">;
  createdAt: string;
  failureCode: string | null;
  pendingWalletLabel: string | null;
  projectId: string;
}): Promise<void> {
  const { projectId } = input;
  const db = getDb(env);
  const credential: TestStoredProviderCredential = {
    id: input.credentialId,
    organizationId: ORGANIZATION_ID,
    projectId,
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
    organizationId: ORGANIZATION_ID,
    projectId,
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
  custodyWalletId: string,
  publicKey: string
): Promise<void> {
  const db = getDb(env);
  await insertTestCustodyWalletRow(db, {
    id: custodyWalletId,
    owner: { kind: "connection", custodyConnectionId: connectionId },
    walletId: `provider-${custodyWalletId}`,
    publicKey,
    label: null,
    purpose: null,
    status: "active",
  });
  await activateTestCustodyConnection(db, {
    connectionId,
    custodyWalletId,
    providerAccountFingerprint: `fingerprint-${connectionId}`,
  });
}

async function seedRuntimeReadyConnection(
  connectionId: string,
  createdAt: string,
  publicKey: string
): Promise<void> {
  await seedCredentialAndConnection({
    credentialId: `pcred_${connectionId}`,
    connectionId,
    provider: "privy",
    label: "Shared label",
    status: "pending",
    createdAt,
    failureCode: null,
    pendingWalletLabel: null,
    projectId: PROJECT_ID,
  });
  await makeConnectionRuntimeReady(connectionId, `cwlt_${connectionId}`, publicKey);
}

async function requestConnections(query: string): Promise<Response> {
  return app.request(
    `/internal/dashboard/custody/connections${query}`,
    { headers: { Authorization: `Bearer ${token}`, "X-Project-ID": PROJECT_ID } },
    env
  );
}

async function listConnections(query: string) {
  const response = await requestConnections(query);
  expect(response.status).toBe(200);
  return listSchema.parse(await response.json()).data;
}

describe("internal custody connections", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    token = await seedCustodyAdmin(env, {
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
      projectId: PROJECT_ID,
      tier: "enterprise",
    });
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  it("refuses a caller with no dashboard session with 401", async () => {
    const response = await app.request(
      "/internal/dashboard/custody/connections",
      { headers: { "X-Project-ID": PROJECT_ID } },
      env
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "API key required" },
    });
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
      projectId: PROJECT_ID,
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
      projectId: PROJECT_ID,
    });

    const data = await listConnections("");

    expect(data).toEqual({
      connections: [
        {
          id: "ccon_read_b",
          provider: "privy",
          label: "Pending treasury",
          status: "pending",
          isRuntimeExecutionAllowed: false,
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
          isRuntimeExecutionAllowed: false,
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
  });

  it("lists only the requested project's connections", async () => {
    await seedCredentialAndConnection({
      credentialId: "pcred_read_own",
      connectionId: "ccon_read_own",
      provider: "privy",
      label: "Own treasury",
      status: "pending",
      createdAt: "2026-08-01T00:00:00.000Z",
      failureCode: null,
      pendingWalletLabel: null,
      projectId: PROJECT_ID,
    });
    await seedCredentialAndConnection({
      credentialId: "pcred_read_other_project",
      connectionId: "ccon_read_other_project",
      provider: "privy",
      label: "Other project treasury",
      status: "pending",
      createdAt: "2026-08-02T00:00:00.000Z",
      failureCode: null,
      pendingWalletLabel: null,
      projectId: OTHER_PROJECT_ID,
    });

    const data = await listConnections("");

    expect(data.connections.map((row) => row.id)).toEqual(["ccon_read_own"]);
    expect(data.pagination.total).toBe(1);
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
      projectId: PROJECT_ID,
    });

    const response = await requestConnections("");
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain(SECRET_PAYLOAD);
    expect(raw).not.toContain("encrypted_secret_payload");
    expect(raw).not.toContain("encryptedSecretPayload");
    expect(raw).not.toContain("raw_provider_stack");
    const { data } = listSchema.parse(JSON.parse(raw));
    expect(data.connections.map((row) => row.lastCheck)).toEqual([
      { status: "failed", at: "2026-08-01T00:00:00.000Z", failureCode: null },
    ]);
  });

  it("reports runtime eligibility from each Connection's own lifecycle, not from any of its wallets", async () => {
    await seedRuntimeReadyConnection(
      "ccon_read_first",
      "2026-08-01T00:00:00.000Z",
      syntheticAddress(1)
    );
    await seedRuntimeReadyConnection(
      "ccon_read_second",
      "2026-08-02T00:00:00.000Z",
      syntheticAddress(2)
    );

    const activeConnection = (id: string, createdAt: string) => ({
      id,
      provider: "privy",
      label: "Shared label",
      status: "active",
      isRuntimeExecutionAllowed: true,
      createdAt,
      activatedAt: expect.any(String),
      lastCheck: { status: "success", at: expect.any(String), failureCode: null },
      pendingWalletLabel: null,
    });
    expect((await listConnections("")).connections).toEqual([
      activeConnection("ccon_read_second", "2026-08-02T00:00:00.000Z"),
      activeConnection("ccon_read_first", "2026-08-01T00:00:00.000Z"),
    ]);

    await getDb(env)
      .prepare(
        `UPDATE custody_wallets SET status = 'inactive'
         WHERE id = 'cwlt_ccon_read_first'`
      )
      .run();
    expect((await listConnections("")).connections).toEqual([
      activeConnection("ccon_read_second", "2026-08-02T00:00:00.000Z"),
      activeConnection("ccon_read_first", "2026-08-01T00:00:00.000Z"),
    ]);
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
      projectId: PROJECT_ID,
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
      projectId: PROJECT_ID,
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
        projectId: PROJECT_ID,
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
      projectId: PROJECT_ID,
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
      projectId: PROJECT_ID,
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
        projectId: PROJECT_ID,
      });
    }

    const page = await listConnections("?limit=2&offset=1");
    expect(page.connections.map((row) => row.id)).toEqual(["ccon_read_p1", "ccon_read_p0"]);
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
    expect(oversized.connections).toEqual([]);
  });
});
