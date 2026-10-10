import { SDP_RAMP_PROVIDER_STAGES } from "@sdp/types";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@/app";
import { getDb } from "@/db";
import { createSystemPaymentsRepository } from "@/db/repositories";
import { verifyClerkJwt } from "@/lib/clerk-token";
import { AppError } from "@/lib/errors";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import internalCustody from "@/routes/internal-custody";
import { noopObservability } from "@/runtime/observability";
import { trackPendingTransfers } from "@/services/jobs/track-pending-transfers";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";

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
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
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
  return data as { connectionId: string; providerCredential: { id: string } };
}

async function newRegistration(projectId = PROJECT_ID) {
  const response = await request("/fireblocks/csr", {}, projectId);
  expect(response.status, await response.clone().text()).toBe(201);
  const { data } = await response.json();
  return { ...fields, signingKeyId: data.csr.id };
}

beforeEach(async () => {
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
    await next();
  });
  app.route("/internal/dashboard/custody", internalCustody);
  app.onError((error, c) => {
    if (error instanceof AppError) return c.json(error.toResponse(), error.statusCode as 400);
    throw error;
  });
  fields.signingKeyId = (await newRegistration()).signingKeyId;
  body.fields.signingKeyId = fields.signingKeyId;
});
afterEach(() => vi.restoreAllMocks());

const SIG =
  "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const paymentApp = createApp({
  observability: noopObservability,
  rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
});
let walletId: string;
let createBody: import("@sdp/custody/provisioning").FireblocksTransferRequest;
let providerStatus: string;
let lostResponse = false;
let readMissing = false;
let createStatus = 200;
async function ready() {
  const mock = providerResponse();
  const connection = await connect();
  const wallet = await getDb(env).queryOne<{ id: string }>(
    "SELECT id FROM custody_wallets WHERE custody_connection_id = ?",
    [connection.connectionId]
  );
  if (!wallet) throw new Error("Expected imported wallet");
  walletId = wallet.id;
  providerStatus = "PENDING_AUTHORIZATION";
  lostResponse = false;
  readMissing = false;
  createStatus = 200;
  mock.mockImplementation(async (url, init) => {
    const path = String(url).replace(testEnv.FIREBLOCKS_API_BASE_URL ?? "", "");
    expect(new Headers(init?.headers).get("X-API-Key")).toBe(fields.apiKey);
    if (path === "/v1/supported_assets")
      return Response.json([
        {
          id: "USDC_WRONG_CHAIN",
          type: "ERC20",
          nativeAsset: "ETH",
          issuerAddress: USDC,
          decimals: 6,
        },
        {
          id: "SOL_USDC_JKVK",
          type: "SOL_ASSET",
          nativeAsset: "SOL_TEST",
          issuerAddress: USDC,
          decimals: 6,
        },
      ]);
    if (path === "/v1/transactions" && init?.method === "POST") {
      createBody = JSON.parse(String(init.body));
      if (lostResponse) throw new Error("Timeout after provider accepted payment");
      if (createStatus !== 200)
        return Response.json({ message: "secret must not be echoed" }, { status: createStatus });
      return Response.json({ id: "fb-proposal", status: providerStatus });
    }
    if (path.startsWith("/v1/transactions/external_tx_id/") && init?.method === "GET") {
      if (readMissing) return Response.json({}, { status: 404 });
      return Response.json({
        id: "fb-proposal",
        externalTxId: createBody.externalTxId,
        operation: "TRANSFER",
        assetId: createBody.assetId,
        source: createBody.source,
        status: providerStatus,
        subStatus: providerStatus === "BLOCKED" ? "BLOCKED_BY_POLICY" : undefined,
        txHash: providerStatus === "COMPLETED" ? SIG : undefined,
      });
    }
    throw new Error(`Unexpected provider request ${init?.method} ${path}`);
  });
  mock.mockClear();
  return mock;
}
async function send(key = "fireblocks-test", patch: Record<string, unknown> = {}) {
  return paymentApp.request(
    "/v1/payments/transfers",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Project-ID": PROJECT_ID,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({
        sourceCustodyWalletId: walletId,
        destination: OTHER_ADDRESS,
        token: "SOL",
        amount: "0.01",
        ...patch,
      }),
    },
    testEnv
  );
}
async function refresh(id: string) {
  await getDb(env).execute(
    "UPDATE payment_transfers SET provider_data = provider_data - 'fireblocksLastPolledAt' WHERE id = ?",
    [id]
  );
  const response = await paymentApp.request(
    `/v1/payments/transfers/${id}`,
    { headers: { Authorization: `Bearer ${token}`, "X-Project-ID": PROJECT_ID } },
    testEnv
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()).data.transfer;
}

describe("native Fireblocks BYOK payment routes", () => {
  it("submits TRANSFER with tenant credentials, records pending approval and replays without another POST", async () => {
    const mock = await ready();
    const response = await send();
    expect(response.status, await response.clone().text()).toBe(200);
    const transfer = (await response.json()).data.transfer;
    expect(transfer).toMatchObject({
      status: "processing",
      signature: null,
      fireblocks: { transactionId: "fb-proposal", status: "PENDING_AUTHORIZATION" },
    });
    expect(createBody).toMatchObject({
      operation: "TRANSFER",
      assetId: "SOL_TEST",
      externalTxId: transfer.id,
      source: { type: "VAULT_ACCOUNT", id: "0" },
      destination: { type: "ONE_TIME_ADDRESS", oneTimeAddress: { address: OTHER_ADDRESS } },
      amount: "0.01",
      treatAsGrossAmount: false,
    });
    expect(createBody).not.toHaveProperty("extraParameters");
    expect(mock).toHaveBeenCalledTimes(1);
    const replay = await send();
    expect(replay.status).toBe(200);
    expect((await replay.json()).data.transfer.id).toBe(transfer.id);
    expect(mock).toHaveBeenCalledTimes(1);
    providerStatus = "COMPLETED";
    expect(await refresh(transfer.id)).toMatchObject({ status: "confirmed", signature: SIG });
    providerStatus = "PENDING_SIGNATURE";
    expect(await refresh(transfer.id)).toMatchObject({ status: "confirmed", signature: SIG });
    expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("maps USDC by exact mint and network and rejects unsupported assets and precision", async () => {
    await ready();
    const response = await send("usdc", { token: USDC, amount: "0.123456" });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(createBody.assetId).toBe("SOL_USDC_JKVK");
    expect(createBody.amount).toBe("0.123456");
    expect((await send("unsupported", { token: ADDRESS })).status).toBe(400);
    expect((await send("too-precise", { token: USDC, amount: "0.0000001" })).status).toBe(400);
  });
  it("recovers an accepted payment after a lost response without resubmitting", async () => {
    const mock = await ready();
    lostResponse = true;
    const response = await send();
    expect(response.status, await response.clone().text()).toBe(200);
    const transfer = (await response.json()).data.transfer;
    expect(transfer).toMatchObject({
      status: "processing",
      signature: null,
      fireblocks: { transactionId: null },
    });
    expect((await send()).status).toBe(200);
    readMissing = true;
    expect(await refresh(transfer.id)).toMatchObject({
      status: "processing",
      fireblocks: { transactionId: null },
    });
    readMissing = false;
    expect(await refresh(transfer.id)).toMatchObject({
      status: "processing",
      fireblocks: { transactionId: "fb-proposal" },
    });
    expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("persists policy substatus and does not treat human approval as a five-minute timeout", async () => {
    await ready();
    const response = await send();
    expect(response.status, await response.clone().text()).toBe(200);
    const transfer = (await response.json()).data.transfer;
    await getDb(env).execute("UPDATE payment_transfers SET updated_at = ? WHERE id = ?", [
      new Date(Date.now() - 3600000).toISOString(),
      transfer.id,
    ]);
    await trackPendingTransfers(testEnv);
    expect(
      (
        await createSystemPaymentsRepository(testEnv).getTransferById({
          transferId: transfer.id,
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
        })
      )?.status
    ).toBe("processing");
    providerStatus = "BLOCKED";
    expect(await refresh(transfer.id)).toMatchObject({
      status: "failed",
      signature: null,
      error: expect.stringContaining("BLOCKED_BY_POLICY"),
    });
  });
  it("does not expose credentials and blocks another project from reading or executing this wallet", async () => {
    const mock = await ready();
    const response = await send();
    const raw = await response.text();
    expect(raw).not.toContain(fields.apiKey);
    expect(raw).not.toContain("PRIVATE KEY");
    const id = JSON.parse(raw).data.transfer.id;
    const other = await paymentApp.request(
      `/v1/payments/transfers/${id}`,
      { headers: { Authorization: `Bearer ${token}`, "X-Project-ID": `${PROJECT_ID}_production` } },
      testEnv
    );
    expect(other.status).toBe(404);
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it("returns a recorded failure for a definitive rejection and keeps server failures pending", async () => {
    const mock = await ready();
    createStatus = 403;
    const response = await send();
    expect(response.status).toBe(200);
    const failed = (await response.json()).data.transfer;
    expect(failed.status).toBe("failed");
    expect(failed.error).not.toContain("secret must not be echoed");
    createStatus = 503;
    const uncertain = await send("second");
    expect(uncertain.status).toBe(200);
    expect((await uncertain.json()).data.transfer.status).toBe("processing");
    expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });
  it("joins concurrent sends under one intent and throttles concurrent status reads", async () => {
    const mock = await ready();
    const responses = await Promise.all([send(), send()]);
    for (const response of responses)
      expect(response.status, await response.clone().text()).toBe(200);
    const ids = await Promise.all(
      responses.map(async (response) => (await response.json()).data.transfer.id)
    );
    expect(ids[0]).toBe(ids[1]);
    expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    const read = () =>
      paymentApp.request(
        `/v1/payments/transfers/${ids[0]}`,
        { headers: { Authorization: `Bearer ${token}`, "X-Project-ID": PROJECT_ID } },
        testEnv
      );
    await Promise.all([read(), read(), read()]);
    expect(mock.mock.calls.filter(([, init]) => init?.method === "GET")).toHaveLength(1);
  });
  it("refuses a disabled connection before contacting Fireblocks", async () => {
    const mock = await ready();
    await getDb(env).execute(
      "UPDATE custody_connections SET status = 'deactivated', deactivated_at = sdp_iso_now() WHERE organization_id = ?",
      [ORGANIZATION_ID]
    );
    const response = await send();
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mock).not.toHaveBeenCalled();
  });
});
