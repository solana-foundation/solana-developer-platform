import { invalidateFireblocksAddressBook } from "@sdp/custody/provisioning/fireblocks-address-book";
import { SDP_RAMP_PROVIDER_STAGES } from "@sdp/types/release-channels";
import { wellKnownMint } from "@sdp/types/well-known-tokens";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApp } from "@/app";
import { getDb } from "@/db/client";
import { verifyClerkJwt } from "@/lib/clerk-token";
import { AppError } from "@/lib/errors";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { internalCustody } from "@/routes/internal-custody";
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
  testEnv.CREDENTIAL_SECRET_STORE_BACKEND = "encrypted_db";
  fields.apiKey = `test-user-${crypto.randomUUID()}`;
  body.fields.apiKey = fields.apiKey;
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

const api = createApp({
  rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
});
const contactId = "cpty_book";
const accountId = "counterparty_account_book";
let walletId: string;
let connectionId: string;
let external: unknown[];
let internal: unknown[];
let calls: { path: string; method: string; body: unknown; key: string | null }[];
let failRead = false;
function entry(status = "APPROVED", assetId = "SOL_TEST", address = OTHER_ADDRESS) {
  return {
    id: "external-wallet",
    name: "Fireblocks contact",
    assets: [{ id: assetId, address, status }],
  };
}
async function ready() {
  const mock = providerResponse();
  connectionId = (await connect()).connectionId;
  const db = getDb(env);
  walletId =
    (
      await db.queryOne<{ id: string }>(
        "SELECT id FROM custody_wallets WHERE custody_connection_id = ?",
        [connectionId]
      )
    )?.id ?? "";
  await db.execute(
    "INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name, provider_data) VALUES (?, ?, ?, 'business', 'My SDP name', '{}'::jsonb)",
    [contactId, ORGANIZATION_ID, PROJECT_ID]
  );
  await db.execute(
    "INSERT INTO counterparty_accounts (id, organization_id, project_id, counterparty_id, account_kind, label, details, network, address) VALUES (?, ?, ?, ?, 'crypto_wallet', 'Saved address', ?::jsonb, 'solana', ?)",
    [
      accountId,
      ORGANIZATION_ID,
      PROJECT_ID,
      contactId,
      JSON.stringify({ network: "solana", address: OTHER_ADDRESS }),
      OTHER_ADDRESS,
    ]
  );
  external = [];
  internal = [];
  calls = [];
  failRead = false;
  mock.mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    expect(headers.get("X-API-Key")).toBe(fields.apiKey);
    expect(headers.get("Authorization")).toMatch(/^Bearer /);
    calls.push({
      path,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      key: headers.get("Idempotency-Key"),
    });
    if (method === "GET") {
      if (failRead) return Response.json({ message: "sensitive provider detail" }, { status: 503 });
      if (path === "/v1/external_wallets") return Response.json(external);
      if (path === "/v1/internal_wallets") return Response.json(internal);
      if (path === "/v1/supported_assets")
        return Response.json([
          {
            id: "USDC_SOL",
            nativeAsset: "SOL_TEST",
            issuerAddress: wellKnownMint("USDC", "devnet"),
            type: "SOL_ASSET",
            decimals: 6,
          },
        ]);
    }
    throw new Error(`Unexpected provider call: ${method} ${path}`);
  });
}
function selection() {
  return { walletId, counterpartyId: contactId, accountId, token: "SOL", address: OTHER_ADDRESS };
}
async function bookRequest(method = "GET", overrides = {}, projectId = PROJECT_ID) {
  const input = { ...selection(), ...overrides };
  const response = await api.request(
    `/internal/dashboard/fireblocks/${method === "GET" ? `destination?${new URLSearchParams(input)}` : "whitelist"}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Project-ID": projectId,
        "Content-Type": "application/json",
      },
      body: method === "POST" ? JSON.stringify(input) : undefined,
    },
    testEnv
  );
  return response;
}
function expireBook() {
  invalidateFireblocksAddressBook({
    apiKey: fields.apiKey,
    apiSecretPem: "unused",
    apiBaseUrl: testEnv.FIREBLOCKS_API_BASE_URL,
  });
}
describe("Fireblocks read-only address book", () => {
  it("shares two reads, recognizes internal whitelist entries and matches the exact network", async () => {
    await ready();
    internal = [entry()];
    const replies = await Promise.all([bookRequest(), bookRequest()]);
    for (const reply of replies) expect((await reply.json()).data.state).toBe("approved");
    expect(calls).toHaveLength(2);
    expireBook();
    internal = [entry("APPROVED", "SOL")];
    expect((await (await bookRequest()).json()).data.state).toBe("not_whitelisted");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("recognizes pending approvals and activation delays", async () => {
    await ready();
    external = [entry("WAITING_FOR_APPROVAL")];
    expect((await (await bookRequest()).json()).data.state).toBe("pending");
    expireBook();
    const future = entry();
    Object.assign(future.assets[0], { activationTime: "2099-01-01T00:00:00Z" });
    external = [future];
    expect((await (await bookRequest()).json()).data.state).toBe("pending");
  });
  it("does not turn provider failures or malformed books into an absent address or cache failures", async () => {
    await ready();
    failRead = true;
    const failed = await bookRequest();
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("sensitive provider detail");
    failRead = false;
    external = [{ id: "bad-wallet", assets: [] }];
    expect((await bookRequest()).status).toBe(503);
    external = [];
    expect((await (await bookRequest()).json()).data.state).toBe("not_whitelisted");
  });
  it("rejects changed addresses and cross-project access before provider calls", async () => {
    await ready();
    expect((await bookRequest("GET", { address: ADDRESS })).status).toBe(409);
    expect((await bookRequest("GET", {}, `${PROJECT_ID}_production`)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
  it("rejects API keys on the internal dashboard book endpoint", async () => {
    await ready();
    const raw = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await seedProjectApiKey(getDb(env), testEnv, {
      key: { id: "key_book_read", raw, prefix: raw.slice(0, 16) },
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      createdBy: USER_ID,
      grants: ["wallets.read", "counterparties.read"],
    });
    token = raw;
    expect((await bookRequest()).status).toBe(403);
    expect(calls).toEqual([]);
  });
  it("removes the whitelist endpoint even for an administrator", async () => {
    await ready();
    expect((await bookRequest("POST")).status).toBe(404);
    expect(calls).toEqual([]);
  });
  it("listing contacts no longer triggers provider calls or automatic imports", async () => {
    await ready();
    external = [entry("APPROVED", "SOL_TEST", ADDRESS)];
    const response = await api.request(
      "/v1/counterparties",
      {
        headers: { Authorization: `Bearer ${token}`, "X-Project-ID": PROJECT_ID },
      },
      testEnv
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data.counterparties).toHaveLength(1);
    expect(calls).toEqual([]);
  });
});
