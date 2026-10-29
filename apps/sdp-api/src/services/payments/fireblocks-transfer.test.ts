import { runInClusterScope } from "@sdp/rpc/scope";
import { SDP_RAMP_PROVIDER_MATURITY } from "@sdp/types/release-channels";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApp } from "@/app";
import { getDb } from "@/db/client";
import { createSystemPaymentsRepository } from "@/db/repositories/repository-factory";
import { verifyClerkJwt } from "@/lib/clerk-token";
import { AppError } from "@/lib/errors";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { internalCustody } from "@/routes/internal-custody";
import { AuditService } from "@/services/audit.service";
import * as credentialSecretStore from "@/services/credential-secret-store";
import { trackPendingTransfers } from "@/services/jobs/track-pending-transfers";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
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
  testEnv.SOLANA_NETWORK = "devnet";
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
  app.onError((error) => {
    if (error instanceof AppError)
      return Response.json(error.toResponse(), { status: error.statusCode });
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
  rampProviderMaturity: SDP_RAMP_PROVIDER_MATURITY,
});
let walletId: string;
let createBody: import("@sdp/custody/provisioning/fireblocks-transfers").FireblocksTransferRequest;
let providerStatus: string;
let lostResponse = false;
let readMissing = false;
let createStatus = 200;
let createResultPatch: Record<string, unknown> = {};
let settlementPatch: Record<string, unknown> = {};
async function ready(projectId = PROJECT_ID) {
  const mock = providerResponse();
  const connection = await connect(projectId);
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
  createResultPatch = {};
  settlementPatch = {};
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
      expect(new Headers(init.headers).has("Idempotency-Key")).toBe(false);
      createBody = JSON.parse(String(init.body));
      if (lostResponse) throw new Error("Timeout after provider accepted payment");
      if (createStatus !== 200)
        return Response.json({ message: "secret must not be echoed" }, { status: createStatus });
      return Response.json({ id: "fb-proposal", status: providerStatus, ...createResultPatch });
    }
    if (path.startsWith("/v1/transactions/external_tx_id/") && init?.method === "GET") {
      if (readMissing) return Response.json({}, { status: 404 });
      return Response.json({
        id: "fb-proposal",
        externalTxId: createBody.externalTxId,
        operation: "TRANSFER",
        assetId: createBody.assetId,
        source: createBody.source,
        destinationAddress: createBody.destination.oneTimeAddress.address,
        amountInfo: {
          amount: createBody.amount,
          requestedAmount: createBody.amount,
          netAmount: createBody.amount,
        },
        status: providerStatus,
        subStatus: providerStatus === "BLOCKED" ? "BLOCKED_BY_POLICY" : undefined,
        txHash: providerStatus === "COMPLETED" ? SIG : undefined,
        ...settlementPatch,
      });
    }
    throw new Error(`Unexpected provider request ${init?.method} ${path}`);
  });
  mock.mockClear();
  return mock;
}
async function send(
  key = "fireblocks-test",
  patch: Record<string, unknown> = {},
  projectId = PROJECT_ID
) {
  return paymentApp.request(
    "/v1/payments/transfers",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Project-ID": projectId,
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
  it.each([undefined, SIG])(
    "keeps a COMPLETED create response pending until a verified detail read (hash: %s)",
    async (txHash) => {
      const mock = await ready();
      providerStatus = "COMPLETED";
      createResultPatch = { txHash };
      const response = await send();
      expect(response.status).toBe(200);
      const transfer = (await response.json()).data.transfer;
      expect(transfer).toMatchObject({ status: "processing", signature: null });
      expect(await refresh(transfer.id)).toMatchObject({ status: "confirmed", signature: SIG });
      expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    }
  );

  it.each([undefined, null])(
    "keeps COMPLETED details without a signature recoverable (hash: %s)",
    async (txHash) => {
      const mock = await ready();
      const response = await send();
      const transfer = (await response.json()).data.transfer;
      providerStatus = "COMPLETED";
      settlementPatch = { txHash };
      expect(await refresh(transfer.id)).toMatchObject({ status: "processing", signature: null });
      // A later detailed response still has to pass settlement checks before confirmation.
      settlementPatch = { destinationAddress: ADDRESS };
      expect(await refresh(transfer.id)).toMatchObject({ status: "processing", signature: null });
      settlementPatch = {};
      expect(await refresh(transfer.id)).toMatchObject({ status: "confirmed", signature: SIG });
      expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    }
  );

  it("blocks new payments in stable but still reconciles a payment submitted in beta", async () => {
    const mock = await ready();
    const response = await send();
    expect(response.status).toBe(200);
    const transfer = (await response.json()).data.transfer;
    testEnv.SDP_RELEASE_CHANNEL = "stable";
    mock.mockClear();
    const refused = await send("stable-new");
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("custody_provider_not_in_release_channel");
    expect(mock).not.toHaveBeenCalled();
    providerStatus = "COMPLETED";
    expect(await refresh(transfer.id)).toMatchObject({ status: "confirmed", signature: SIG });
    expect(mock.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it.each([
    { change: "deactivated", recovery: "dashboard" },
    { change: "deactivated", recovery: "cron" },
    { change: "failed check", recovery: "dashboard" },
    { change: "failed check", recovery: "cron" },
  ] as const)(
    "reconciles an accepted transfer through $recovery after a $change connection, but refuses new sends",
    async ({ change, recovery }) => {
      const mock = await ready();
      const response = await send();
      expect(response.status).toBe(200);
      const transfer = (await response.json()).data.transfer;
      expect(transfer).toMatchObject({ status: "processing", signature: null });
      const db = getDb(env);
      const connection = await db.queryOne<{ id: string }>(
        "SELECT custody_connection_id AS id FROM custody_wallets WHERE id = ?",
        [walletId]
      );
      if (!connection) throw new Error("Expected Fireblocks connection");
      if (change === "deactivated") {
        // The real teardown first requires the connection's wallets to be inactive.
        await db.execute("UPDATE custody_wallets SET status = 'inactive' WHERE id = ?", [walletId]);
        const deactivated = await request(`/connections/${connection.id}/deactivate`, {});
        expect(deactivated.status, await deactivated.clone().text()).toBe(200);
      } else {
        await db.execute(
          "UPDATE custody_connections SET status = 'failed', activated_at = NULL, last_check_status = 'failed' WHERE id = ?",
          [connection.id]
        );
      }
      mock.mockClear();
      expect((await send("after-connection-change")).status).toBe(409);
      expect(mock).not.toHaveBeenCalled();

      providerStatus = "COMPLETED";
      if (recovery === "cron") {
        await runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
          trackPendingTransfers(testEnv)
        );
        expect(
          await db.queryOne<{ status: string; signature: string }>(
            "SELECT status, signature FROM payment_transfers WHERE id = ?",
            [transfer.id]
          )
        ).toMatchObject({ status: "confirmed", signature: SIG });
      } else {
        expect(await refresh(transfer.id)).toMatchObject({ status: "confirmed", signature: SIG });
      }
      expect(mock).toHaveBeenCalledTimes(1);
      expect(mock.mock.calls[0]?.[1]?.method).toBe("GET");
      // Settled intents never acquire recovery access or poll again.
      expect(await refresh(transfer.id)).toMatchObject({ status: "confirmed", signature: SIG });
      expect(mock).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    { connectionId: "another-connection" },
    { accountFingerprint: "another-account" },
    { vaultAccountId: "99" },
  ])("refuses recovery with a mismatched intent %j after a failed check", async (patch) => {
    const mock = await ready();
    const response = await send();
    expect(response.status).toBe(200);
    const transfer = (await response.json()).data.transfer;
    await getDb(env).execute(
      "UPDATE custody_connections SET status = 'failed', activated_at = NULL, last_check_status = 'failed' WHERE organization_id = ?",
      [ORGANIZATION_ID]
    );
    await getDb(env).execute(
      `UPDATE payment_transfers SET provider_data = jsonb_set(provider_data, '{fireblocksTransfer}',
       (provider_data->'fireblocksTransfer') || ?::jsonb) WHERE id = ?`,
      [JSON.stringify(patch), transfer.id]
    );
    mock.mockClear();
    const secrets = vi.spyOn(credentialSecretStore, "createCredentialSecretStore");
    providerStatus = "COMPLETED";
    expect(await refresh(transfer.id)).toMatchObject({ status: "processing", signature: null });
    expect(secrets).not.toHaveBeenCalled();
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([OTHER_ADDRESS, null])(
    "refuses recovery with a changed source address (%s)",
    async (source) => {
      const mock = await ready();
      const response = await send();
      expect(response.status).toBe(200);
      const transfer = (await response.json()).data.transfer;
      await getDb(env).execute("UPDATE payment_transfers SET source_address = ? WHERE id = ?", [
        source,
        transfer.id,
      ]);
      mock.mockClear();
      const secrets = vi.spyOn(credentialSecretStore, "createCredentialSecretStore");
      providerStatus = "COMPLETED";
      expect(await refresh(transfer.id)).toMatchObject({ status: "processing", signature: null });
      expect(secrets).not.toHaveBeenCalled();
      expect(mock).not.toHaveBeenCalled();
    }
  );

  it("does not read a revoked credential during recovery", async () => {
    const mock = await ready();
    const response = await send();
    expect(response.status).toBe(200);
    const transfer = (await response.json()).data.transfer;
    await getDb(env).execute(
      "UPDATE provider_credentials SET status = 'deactivated', deactivated_at = sdp_iso_now() WHERE organization_id = ?",
      [ORGANIZATION_ID]
    );
    mock.mockClear();
    const secrets = vi.spyOn(credentialSecretStore, "createCredentialSecretStore");
    providerStatus = "COMPLETED";
    expect(await refresh(transfer.id)).toMatchObject({ status: "processing", signature: null });
    expect(secrets).not.toHaveBeenCalled();
    expect(mock).not.toHaveBeenCalled();
  });

  it("does not confirm mismatched or incomplete settlement details or resubmit the payment", async () => {
    const mock = await ready();
    const response = await send();
    const transfer = (await response.json()).data.transfer;
    providerStatus = "COMPLETED";
    for (const patch of [
      { destinationAddress: ADDRESS },
      { destinationAddress: "" },
      { amountInfo: null },
      { amountInfo: { amount: "0.02", netAmount: "0.02" } },
      { amountInfo: { amount: "0.01", netAmount: "0.009" } },
      { amountInfo: { amount: "0.01", netAmount: "0.01", requestedAmount: "1" } },
      { source: { type: "VAULT_ACCOUNT", id: "99" } },
      { externalTxId: "another-payment" },
      { assetId: "SOL" },
    ]) {
      settlementPatch = patch;
      expect(await refresh(transfer.id)).toMatchObject({ status: "processing", signature: null });
    }
    settlementPatch = { amountInfo: { amount: "0.010000000", netAmount: "0.010000000" } };
    expect(await refresh(transfer.id)).toMatchObject({ status: "confirmed", signature: SIG });
    expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
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
    const mock = await ready();
    const response = await send("usdc", { token: USDC, amount: "0.123456" });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(createBody.assetId).toBe("SOL_USDC_JKVK");
    expect(createBody.amount).toBe("0.123456");
    const callsBeforeRejection = mock.mock.calls.length;
    const unsupported = await send("unsupported", { token: ADDRESS });
    expect(unsupported.status).toBe(400);
    expect((await unsupported.json()).error.message).toBe(
      "Fireblocks payments currently support SOL and USDC only"
    );
    expect((await send("too-precise", { token: USDC, amount: "0.0000001" })).status).toBe(400);
    expect(mock).toHaveBeenCalledTimes(callsBeforeRejection);
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
    await runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
      trackPendingTransfers(testEnv)
    );
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
  it.each([400, 401, 403, 422, 429])(
    "returns and replays TRANSACTION_FAILED for HTTP %s",
    async (status) => {
      const mock = await ready();
      createStatus = status;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await send();
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error.code).toBe("TRANSACTION_FAILED");
        expect(body.error.message).not.toContain("secret must not be echoed");
      }
      expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    }
  );
  it.each(["REJECTED", "BLOCKED"])(
    "returns an error for an immediate %s result",
    async (status) => {
      await ready();
      providerStatus = status;
      const response = await send();
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("TRANSACTION_FAILED");
    }
  );
  it("keeps server failures pending and does not resubmit", async () => {
    const mock = await ready();
    createStatus = 503;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await send();
      expect(response.status).toBe(200);
      expect((await response.json()).data.transfer.status).toBe("processing");
    }
    expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("fails an unacknowledged intent only after authenticated 404s separated by 24 hours", async () => {
    const mock = await ready();
    lostResponse = true;
    readMissing = true;
    const response = await send();
    const id = (await response.json()).data.transfer.id;
    expect(await refresh(id)).toMatchObject({ status: "processing" });
    await getDb(env).execute(
      "UPDATE payment_transfers SET provider_data = provider_data || ?::jsonb WHERE id = ?",
      [
        JSON.stringify({
          fireblocksFirstMissingAt: new Date(Date.now() - 86_400_001).toISOString(),
        }),
        id,
      ]
    );
    expect(await refresh(id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("24 hours"),
    });
    expect((await (await send()).json()).data.transfer.id).toBe(id);
    expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("never fails an acknowledged transfer because a lookup returns 404", async () => {
    await ready();
    const response = await send();
    const id = (await response.json()).data.transfer.id;
    readMissing = true;
    await getDb(env).execute(
      "UPDATE payment_transfers SET provider_data = provider_data || ?::jsonb WHERE id = ?",
      [
        JSON.stringify({
          fireblocksFirstMissingAt: new Date(Date.now() - 86_400_001).toISOString(),
        }),
        id,
      ]
    );
    expect(await refresh(id)).toMatchObject({ status: "processing" });
  });
  it("does not expire an intent acknowledged while the absence lookup is in flight", async () => {
    const mock = await ready();
    lostResponse = true;
    const id = (await (await send()).json()).data.transfer.id;
    await getDb(env).execute(
      "UPDATE payment_transfers SET provider_data = provider_data || ?::jsonb WHERE id = ?",
      [
        JSON.stringify({
          fireblocksFirstMissingAt: new Date(Date.now() - 86_400_001).toISOString(),
        }),
        id,
      ]
    );
    mock.mockImplementationOnce(async () => {
      await getDb(env).execute(
        "UPDATE payment_transfers SET provider_reference = 'fb-proposal' WHERE id = ?",
        [id]
      );
      return Response.json({}, { status: 404 });
    });
    expect(await refresh(id)).toMatchObject({ status: "processing" });
    const row = await getDb(env).queryOne<{ provider_reference: string; error: string | null }>(
      "SELECT provider_reference, error FROM payment_transfers WHERE id = ?",
      [id]
    );
    expect(row).toEqual({ provider_reference: "fb-proposal", error: null });
  });
  it("joins concurrent sends under one intent and throttles concurrent status reads", async () => {
    const mock = await ready();
    const responses = await Promise.all([send(), send()]);
    const successful = responses.find((response) => response.status === 200);
    if (!successful) throw new Error("Expected one concurrent request to succeed");
    for (const response of responses) {
      if (response.status === 409) {
        expect((await response.json()).error.code).toBe("IDEMPOTENCY_KEY_IN_FLIGHT");
      } else expect(response.status).toBe(200);
    }
    const replay = await send();
    expect(replay.status).toBe(200);
    const ids = [
      (await successful.json()).data.transfer.id,
      (await replay.json()).data.transfer.id,
    ];
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
  it.each([
    { projectId: `${PROJECT_ID}_production`, defaultNetwork: "devnet", assetId: "SOL" },
    { projectId: PROJECT_ID, defaultNetwork: "mainnet-beta", assetId: "SOL_TEST" },
  ] as const)(
    "uses the project's $assetId despite deployment default $defaultNetwork",
    async ({ projectId, defaultNetwork, assetId }) => {
      testEnv.SOLANA_NETWORK = defaultNetwork;
      const mock = await ready(projectId);
      const response = await send("project-network", {}, projectId);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(createBody.assetId).toBe(assetId);
      expect(mock).toHaveBeenCalledTimes(1);
    }
  );

  it("only polls Fireblocks intents in the cron's current environment", async () => {
    const projectId = `${PROJECT_ID}_production`;
    const mock = await ready(projectId);
    expect((await send("cron-production", {}, projectId)).status).toBe(200);
    mock.mockClear();
    await runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
      trackPendingTransfers(testEnv)
    );
    expect(mock).not.toHaveBeenCalled();
    await runInClusterScope({ projectId: null, environment: "production" }, () =>
      trackPendingTransfers(testEnv)
    );
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it.each(["suspended organization", "revoked key", "removed grant", "removed wallet"])(
    "refuses %s changed after route authorization, before the provider POST",
    async (change) => {
      const mock = await ready();
      const db = getDb(env);
      const raw = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
      await seedProjectApiKey(db, testEnv, {
        key: { id: "key_fireblocks_send", raw, prefix: raw.slice(0, 16) },
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        createdBy: USER_ID,
        grants: ["transfers.execute"],
      });
      token = raw;
      const original = AuditService.prototype.beginCritical;
      vi.spyOn(AuditService.prototype, "beginCritical").mockImplementation(async function (
        this: AuditService,
        ...args
      ) {
        const intent = await original.apply(this, args);
        if (change === "suspended organization")
          await db.execute("UPDATE organizations SET status = 'suspended' WHERE id = ?", [
            ORGANIZATION_ID,
          ]);
        else if (change === "revoked key")
          await db.execute("UPDATE api_keys SET status = 'revoked' WHERE id = ?", [
            "key_fireblocks_send",
          ]);
        else if (change === "removed grant")
          await db.execute(
            "UPDATE api_keys SET grants = ARRAY['transfers.read']::text[] WHERE id = ?",
            ["key_fireblocks_send"]
          );
        else
          await db.execute("UPDATE api_keys SET wallet_scope = 'selected' WHERE id = ?", [
            "key_fireblocks_send",
          ]);
        return intent;
      });
      const response = await send();
      expect(response.status, await response.clone().text()).toBe(403);
      expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
      const row = await db.queryOne<{ status: string }>(
        "SELECT status FROM payment_transfers WHERE organization_id = ?",
        [ORGANIZATION_ID]
      );
      expect(row?.status).toBe("failed");
    }
  );

  it.each([
    "inactive wallet",
    "deactivated connection",
    "failed health check",
    "retired credential",
    "changed connection intent",
    "changed account",
    "changed vault",
    "changed source",
  ] as const)("refuses %s changed during preparation without a provider POST", async (change) => {
    const mock = await ready();
    const db = getDb(env);
    const original = AuditService.prototype.beginCritical;
    vi.spyOn(AuditService.prototype, "beginCritical").mockImplementation(async function (
      this: AuditService,
      ...args
    ) {
      const audit = await original.apply(this, args);
      switch (change) {
        case "inactive wallet":
          await db.execute("UPDATE custody_wallets SET status = 'inactive' WHERE id = ?", [
            walletId,
          ]);
          break;
        case "deactivated connection":
          await db.execute(
            "UPDATE custody_connections SET status = 'deactivated', deactivated_at = sdp_iso_now() WHERE organization_id = ?",
            [ORGANIZATION_ID]
          );
          break;
        case "failed health check":
          await db.execute(
            "UPDATE custody_connections SET status = 'failed', activated_at = NULL, last_check_status = 'failed' WHERE organization_id = ?",
            [ORGANIZATION_ID]
          );
          break;
        case "retired credential":
          await db.execute(
            "UPDATE provider_credentials SET status = 'deactivated', deactivated_at = sdp_iso_now() WHERE organization_id = ?",
            [ORGANIZATION_ID]
          );
          break;
        case "changed connection intent":
          await db.execute(
            `UPDATE payment_transfers SET provider_data = jsonb_set(provider_data,
             '{fireblocksTransfer,connectionId}', '"another-connection"'::jsonb)
             WHERE organization_id = ?`,
            [ORGANIZATION_ID]
          );
          break;
        case "changed account":
          await db.execute(
            "UPDATE custody_connections SET provider_account_fingerprint = 'another-account' WHERE organization_id = ?",
            [ORGANIZATION_ID]
          );
          break;
        case "changed vault":
          await db.execute("UPDATE custody_wallets SET wallet_id = 'fb_1' WHERE id = ?", [
            walletId,
          ]);
          break;
        case "changed source":
          await db.execute("UPDATE custody_wallets SET public_key = ? WHERE id = ?", [
            OTHER_ADDRESS,
            walletId,
          ]);
          break;
        default: {
          const exhaustive: never = change;
          throw new Error(`Unexpected custody change: ${exhaustive}`);
        }
      }
      return audit;
    });
    const response = await send();
    expect(response.status, await response.clone().text()).toBe(409);
    expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    const row = await db.queryOne<{
      id: string;
      status: string;
      provider_reference: string | null;
    }>("SELECT id, status, provider_reference FROM payment_transfers WHERE organization_id = ?", [
      ORGANIZATION_ID,
    ]);
    expect(row).toMatchObject({ status: "failed", provider_reference: null });
    if (!row) throw new Error("Expected failed payment intent");
    mock.mockClear();
    expect(await refresh(row.id)).toMatchObject({ status: "failed" });
    await send();
    expect(mock).not.toHaveBeenCalled();
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
