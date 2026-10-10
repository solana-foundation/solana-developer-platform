import { invalidateFireblocksAddressBook } from "@sdp/custody/provisioning";
import { SDP_RAMP_PROVIDER_STAGES, wellKnownMint } from "@sdp/types";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@/app";
import { getDb } from "@/db";
import { verifyClerkJwt } from "@/lib/clerk-token";
import { AppError } from "@/lib/errors";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import internalCustody from "@/routes/internal-custody";
import { noopObservability } from "@/runtime/observability";
import { syncFireblocksContacts } from "@/services/custody/fireblocks-address-book.service";
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
  testEnv.FIREBLOCKS_CONTACT_SYNC_ENABLED = undefined;
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
  app.onError((error, c) => {
    if (error instanceof AppError) return c.json(error.toResponse(), error.statusCode as 400);
    throw error;
  });
  fields.signingKeyId = (await newRegistration()).signingKeyId;
  body.fields.signingKeyId = fields.signingKeyId;
});
afterEach(() => vi.restoreAllMocks());

const api = createApp({
  observability: noopObservability,
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
let loseWrite = false;
let denyWrite = false;
let denyStatus = 403;
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
  loseWrite = false;
  denyWrite = false;
  denyStatus = 403;
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
    if (method === "POST") {
      if ((headers.get("Idempotency-Key")?.length ?? 0) > 40)
        return Response.json(
          { code: 9003, message: "Invalid idempotency key length" },
          { status: 400 }
        );
      if (loseWrite) throw new Error("Lost response");
      if (denyWrite)
        return Response.json(
          { code: 9003, message: "sensitive provider detail" },
          { status: denyStatus }
        );
      if (path === "/v1/external_wallets") return Response.json({ id: "created-external" });
      if (path === "/v1/external_wallets/created-external/SOL_TEST")
        return Response.json({ status: "WAITING_FOR_APPROVAL" });
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
      ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
    },
    testEnv
  );
  return response;
}
const project = { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID };
async function expireSync() {
  await getDb(env).execute(
    "UPDATE fireblocks_contact_sync SET synced_at = NULL, lease_until = NULL"
  );
  invalidateFireblocksAddressBook({
    apiKey: fields.apiKey,
    apiSecretPem: "unused",
    apiBaseUrl: testEnv.FIREBLOCKS_API_BASE_URL,
  });
}
describe("Fireblocks address book", () => {
  it("shares two reads, recognizes internal whitelist entries, and matches asset/network exactly", async () => {
    await ready();
    internal = [entry()];
    const replies = await Promise.all([bookRequest(), bookRequest()]);
    for (const reply of replies) expect((await reply.json()).data.state).toBe("approved");
    expect(calls).toHaveLength(2);
    await expireSync();
    internal = [entry("APPROVED", "SOL")];
    expect((await (await bookRequest()).json()).data.state).toBe("not_whitelisted");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("does not re-propose pending entries or approved addresses awaiting activation", async () => {
    await ready();
    external = [entry("WAITING_FOR_APPROVAL")];
    expect((await (await bookRequest("POST")).json()).data.state).toBe("pending");
    const future = entry();
    Object.assign(future.assets[0], { activationTime: "2099-01-01T00:00:00Z" });
    external = [future];
    expect((await (await bookRequest("POST")).json()).data.state).toBe("pending");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("creates one proposal with tenant credentials and durable deduplication for concurrent clicks", async () => {
    await ready();
    expect((await (await bookRequest()).json()).data.state).toBe("not_whitelisted");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    const replies = await Promise.all([bookRequest("POST"), bookRequest("POST")]);
    for (const reply of replies) expect(reply.status, await reply.clone().text()).toBe(200);
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0]?.body).toEqual({ name: "Saved address" });
    expect(posts[1]?.body).toEqual({ address: OTHER_ADDRESS });
    expect(posts.every((call) => call.key && call.key.length <= 40)).toBe(true);
    expect(posts[0]?.key).not.toBe(posts[1]?.key);
    await bookRequest("POST");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
  });
  it("does not interpret provider failures as absence or repeat ambiguous writes", async () => {
    await ready();
    failRead = true;
    const failed = await bookRequest();
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(await failed.text()).not.toContain("sensitive provider detail");
    failRead = false;
    expect((await (await bookRequest()).json()).data.state).toBe("not_whitelisted");
    loseWrite = true;
    expect((await (await bookRequest("POST")).json()).data.state).toBe("unknown");
    await bookRequest("POST");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });
  it("rejects changed addresses and cross-project access before provider calls", async () => {
    await ready();
    expect((await bookRequest("POST", { address: ADDRESS })).status).toBe(409);
    expect((await bookRequest("POST", {}, `${PROJECT_ID}_production`)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
  it("allows reads but refuses whitelist proposals without contact-write permission", async () => {
    await ready();
    const raw = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await seedProjectApiKey(getDb(env), testEnv, {
      key: { id: "key_book_read", raw, prefix: raw.slice(0, 16) },
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      createdBy: USER_ID,
      role: "api_readonly",
      permissions: ["wallets:read", "counterparties:read"],
    });
    token = raw;
    expect((await bookRequest()).status).toBe(200);
    expect((await bookRequest("POST")).status).toBe(403);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("allows an explicit retry after a definite rejection without retrying automatically", async () => {
    await ready();
    denyWrite = true;
    expect((await (await bookRequest("POST")).json()).data).toMatchObject({
      state: "failed",
      failureReason: "permissions",
      providerCode: 9003,
    });
    expect((await (await bookRequest()).json()).data.state).toBe("not_whitelisted");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    denyWrite = false;
    expect((await (await bookRequest("POST")).json()).data.state).toBe("pending");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(3);
  });
  it("distinguishes invalid provider requests from permission failures and records safe diagnostics", async () => {
    await ready();
    denyWrite = true;
    denyStatus = 400;
    const result = await bookRequest("POST");
    const payload = await result.json();
    expect(payload.data).toMatchObject({
      state: "failed",
      failureReason: "request",
      providerCode: 9003,
    });
    expect(JSON.stringify(payload)).not.toContain("sensitive provider detail");
    const audits = await getDb(env).queryMany<{ metadata: string }>(
      "SELECT metadata FROM audit_logs WHERE organization_id = ? AND status = 'failure'",
      [ORGANIZATION_ID]
    );
    const outcome = audits
      .map((a) => JSON.parse(a.metadata))
      .find((a) => a.event === "fireblocks_whitelist_rejected");
    expect(outcome).toMatchObject({
      providerStep: "create_wallet",
      httpStatus: 400,
      providerCode: 9003,
    });
    expect(JSON.stringify(outcome)).not.toContain("sensitive provider detail");
  });
  it("fails closed on malformed address books and does not cache the failure", async () => {
    await ready();
    external = [{ id: "bad-wallet", assets: [] }];
    expect((await bookRequest()).status).toBe(503);
    external = [];
    expect((await (await bookRequest()).json()).data.state).toBe("not_whitelisted");
  });
  it("imports approved Solana contacts once, preserves existing/edited names and archives, and respects the host switch", async () => {
    await ready();
    external = [
      entry(),
      { ...entry("APPROVED", "SOL_TEST", ADDRESS), id: "new-wallet", name: "Imported name" },
      {
        ...entry(
          "WAITING_FOR_APPROVAL",
          "SOL_TEST",
          "4d43uqR36EKgSMNhvndFG422uSEBKJjvmUQNFbPQjCFM"
        ),
        id: "pending",
      },
      {
        ...entry("APPROVED", "SOL", "4d43uqR36EKgSMNhvndFG422uSEBKJjvmUQNFbPQjCFM"),
        id: "wrong-network",
      },
    ];
    testEnv.FIREBLOCKS_CONTACT_SYNC_ENABLED = "false";
    await syncFireblocksContacts(testEnv, project);
    expect(calls).toHaveLength(0);
    testEnv.FIREBLOCKS_CONTACT_SYNC_ENABLED = undefined;
    await Promise.all([
      syncFireblocksContacts(testEnv, project),
      syncFireblocksContacts(testEnv, project),
    ]);
    const db = getDb(env);
    let contacts = await db.queryMany<{ id: string; display_name: string; status: string }>(
      "SELECT id, display_name, status FROM counterparties WHERE project_id = ? ORDER BY display_name",
      [PROJECT_ID]
    );
    expect(contacts.map((c) => c.display_name)).toEqual(["Imported name", "My SDP name"]);
    expect(calls.filter((c) => c.path === "/v1/external_wallets")).toHaveLength(1);
    const importedId = contacts[0]?.id;
    const importedAccountResponse = await api.request(
      `/v1/counterparties/${importedId}/accounts`,
      { headers: { Authorization: `Bearer ${token}`, "X-Project-ID": PROJECT_ID } },
      testEnv
    );
    expect(importedAccountResponse.status).toBe(200);
    expect((await importedAccountResponse.json()).data.accounts[0].providerAccountData).toEqual({});

    await db.execute(
      "UPDATE counterparties SET display_name = 'My edited name', status = 'archived' WHERE id = ?",
      [importedId]
    );
    external = [
      { ...entry("APPROVED", "SOL_TEST", ADDRESS), id: "new-wallet", name: "Provider renamed" },
    ];
    await expireSync();
    await syncFireblocksContacts(testEnv, project);
    contacts = await db.queryMany(
      "SELECT id, display_name, status FROM counterparties WHERE project_id = ? ORDER BY display_name",
      [PROJECT_ID]
    );
    expect(contacts).toContainEqual({
      id: importedId,
      display_name: "My edited name",
      status: "archived",
    });
    expect(contacts).toHaveLength(2);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
});

// Policy integration uses an isolated database and a recording HTTP provider.
// It must never submit a policy (or payment) to the real mainnet workspace.
function policyProvider() {
  const fallback = vi.mocked(fetch).getMockImplementation();
  if (!fallback) throw new Error("Provider fixture is not initialized");
  const state = {
    rules: [] as Record<string, unknown>[],
    draft: null as null | { rules: Record<string, unknown>[]; draftId: string; metadata: object },
    writes: [] as { method: string; body: Record<string, unknown> }[],
    denied: false,
    loseWrite: false,
    mutateResponse: false,
  };
  const validation = { status: "SUCCESS", checkResult: { errors: 0, results: [] } };
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    const method = init?.method ?? "GET";
    if (
      !path.startsWith("/v1/policy") &&
      !path.startsWith("/v1/management") &&
      path !== "/v1/vault/accounts/0"
    )
      return fallback(url, init);
    expect(new Headers(init?.headers).get("X-API-Key")).toBe(fields.apiKey);
    if (state.denied) return Response.json({ code: 0, message: "Private error" }, { status: 403 });
    if (path === "/v1/policy/active_policy") {
      expect(parsed.searchParams.get("policyType")).toBe("TRANSFER");
      return Response.json({ policy: { rules: state.rules, metadata: {} }, validation });
    }
    if (path === "/v1/management/users")
      return Response.json({
        users: [
          {
            id: "human-owner",
            firstName: "Thomas",
            lastName: "Fischer",
            enabled: true,
            status: "READY",
            role: "OWNER",
            userType: "CONSOLE",
          },
          {
            id: "human-approver",
            firstName: "Keegan",
            lastName: "Thompson",
            enabled: true,
            status: "READY",
            role: "APPROVER",
            userType: "CONSOLE",
          },
          { id: "disabled", enabled: false, status: "READY", role: "ADMIN", userType: "CONSOLE" },
        ],
      });
    if (path === "/v1/management/api_users")
      return Response.json({
        users: [{ id: fields.apiKey, name: "SDP API user", enabled: true, userType: "API" }],
      });
    if (path === "/v1/management/user_groups")
      return Response.json([
        {
          id: "humans",
          name: "Treasury approvals",
          status: "APPROVED",
          memberIds: ["human-owner", "human-approver"],
        },
      ]);
    if (path === "/v1/vault/accounts/0")
      return Response.json({ id: "0", name: "Treasury", assets: [{ id: "SOL_TEST" }] });
    if (path === "/v1/policy/draft" && method === "GET")
      return state.draft
        ? Response.json({ draftResponse: state.draft, validation })
        : Response.json({}, { status: 404 });
    if (path === "/v1/policy/draft" && ["PUT", "POST"].includes(method)) {
      const body = JSON.parse(String(init?.body));
      state.writes.push({ method, body });
      expect(body.policyTypes).toEqual(["TRANSFER"]);
      expect(new Headers(init?.headers).get("Idempotency-Key")?.length).toBeLessThanOrEqual(40);
      if (state.loseWrite) throw new Error("Lost response");
      if (method === "POST") return Response.json({ status: "PENDING_CONSOLE_APPROVAL" });
      state.draft = { rules: body.rules, draftId: "draft-1", metadata: {} };
      if (state.mutateResponse) state.draft.rules = [];
      return Response.json({ draftResponse: state.draft, validation });
    }
    throw new Error(`Unexpected policy request ${method} ${path}`);
  });
  return state;
}
function policyRequest(path = "", payload?: unknown, projectId = PROJECT_ID, authToken = token) {
  return api.request(
    `/internal/dashboard/fireblocks/policy${path}${payload === undefined ? `?${new URLSearchParams({ ...selection(), amount: "0.01" })}` : ""}`,
    {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "X-Project-ID": projectId,
        "Content-Type": "application/json",
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    },
    testEnv
  );
}
async function policyDraftBody() {
  const setup = await policyRequest("/setup");
  expect(setup.status, await setup.clone().text()).toBe(200);
  const { data } = await setup.json();
  return {
    selection: { ...selection(), amount: "0.01" },
    revision: data.revision,
    requestId: crypto.randomUUID(),
    form: {
      ...data.defaults,
      approvalGroups: [{ users: [], groups: ["humans"], threshold: 2 }],
      signerIds: ["human-owner"],
    },
  };
}
describe("Fireblocks transfer policy setup", () => {
  it("reports permission denial without treating it as missing and enforces project scope", async () => {
    await ready();
    const provider = policyProvider();
    provider.denied = true;
    const denied = await policyRequest();
    expect((await denied.json()).data).toEqual({
      state: "permission_required",
      canConfigure: false,
    });
    expect((await policyRequest("/setup")).status).toBe(403);
    expect((await policyRequest("", undefined, `${PROJECT_ID}_production`)).status).toBe(404);
    expect(provider.writes).toEqual([]);
  });
  it("refuses policy administration by an SDP API key even with custody permissions", async () => {
    await ready();
    const provider = policyProvider();
    const raw = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await seedProjectApiKey(getDb(env), testEnv, {
      key: { id: "key_policy", raw, prefix: raw.slice(0, 16) },
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      createdBy: USER_ID,
      role: "api_readonly",
      permissions: ["wallets:read", "counterparties:read", "custody:admin"],
    });
    expect((await policyRequest("/setup", undefined, PROJECT_ID, raw)).status).toBe(403);
    expect(provider.writes).toEqual([]);
  });
  it("loads human approvers and signers, enforces defaults, resumes drafts and requires explicit publishing", async () => {
    await ready();
    const provider = policyProvider();
    external = [entry()];
    const payload = await policyDraftBody();
    const response = await policyRequest("/draft", payload);
    expect(response.status, await response.clone().text()).toBe(200);
    const proposal = (await response.json()).data;
    expect(proposal.state).toBe("draft");
    expect(provider.writes).toHaveLength(1);
    const rule = provider.draft?.rules[0];
    expect(rule).toMatchObject({
      name: "Created within SDP — SOL_TEST from Treasury to whitelisted addresses",
      initiator: { users: [fields.apiKey] },
      source: { ids: [{ type: "VAULT", id: "0" }] },
      destination: { addressType: "WHITELISTED", type: ["UNMANAGED"] },
      asset: { assetTypes: ["SOL_TEST"] },
      amount: { currency: "USD", range: { min: "0" } },
      verdict: {
        action: "2-TIER",
        approvers: {
          canInitiatorApprove: false,
          allowOperatorAsAuthorizer: false,
          approvalGroups: [{ groups: ["humans"], threshold: 2 }],
        },
        designatedSigners: { type: "SINGLE", users: ["human-owner"] },
      },
    });
    const duplicate = await policyRequest("/draft", payload);
    expect((await duplicate.json()).data).toEqual(proposal);
    expect(provider.writes).toHaveLength(1);
    const resumed = await policyRequest("/setup");
    expect(resumed.status, await resumed.clone().text()).toBe(200);
    expect((await resumed.json()).data.proposal).toEqual(proposal);
    const published = await policyRequest("/publish", {
      selection: payload.selection,
      proposalId: proposal.proposalId,
    });
    expect(published.status, await published.clone().text()).toBe(200);
    expect((await published.json()).data.state).toBe("submitted");
    await policyRequest("/publish", {
      selection: payload.selection,
      proposalId: proposal.proposalId,
    });
    expect(provider.writes.map((w) => w.method)).toEqual(["PUT", "POST"]);
  });
  it("rejects the API initiator, non-signing humans and impossible approval thresholds", async () => {
    await ready();
    const provider = policyProvider();
    const payload = await policyDraftBody();
    for (const form of [
      { ...payload.form, signerIds: [fields.apiKey] },
      { ...payload.form, signerIds: ["human-approver"] },
      { ...payload.form, approvalGroups: [{ users: [fields.apiKey], groups: [], threshold: 1 }] },
      { ...payload.form, approvalGroups: [{ users: [], groups: ["humans"], threshold: 3 }] },
      { ...payload.form, canInitiatorApprove: true },
    ])
      expect((await policyRequest("/draft", { ...payload, form })).status).toBe(400);
    expect(provider.writes).toEqual([]);
  });
  it("preserves earlier rules and inserts only before the understood default block", async () => {
    await ready();
    const provider = policyProvider();
    external = [entry()];
    const block = {
      id: "default",
      name: "Default block",
      index: 2,
      type: "TRANSFER",
      policyEngineVersion: "v2",
      initiator: "*",
      source: { operator: "INCLUDES", type: ["*"] },
      destination: { operator: "INCLUDES", addressType: "*", type: ["*"] },
      asset: { nftTransfer: false, assetTypes: ["*"] },
      amount: { currency: "USD", range: { min: "0" } },
      verdict: { action: "BLOCK" },
    };
    const earlier = {
      ...block,
      id: "other-vault",
      name: "Preserve me",
      index: 1,
      source: { operator: "INCLUDES", ids: [{ type: "VAULT", id: "2" }] },
    };
    provider.rules = [earlier, block];
    const check = await policyRequest();
    expect((await check.json()).data).toMatchObject({ state: "missing", canConfigure: true });
    const payload = await policyDraftBody();
    const saved = await policyRequest("/draft", payload);
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(provider.draft?.rules[0]).toEqual(earlier);
    expect(provider.draft?.rules[1]).toMatchObject({ name: payload.form.name, index: 2 });
    expect(provider.draft?.rules[2]).toEqual({ ...block, index: 3 });
    expect(provider.writes).toHaveLength(1);
  });
  it("refuses stale policies and unrelated external drafts without overwriting", async () => {
    await ready();
    const provider = policyProvider();
    const payload = await policyDraftBody();
    provider.draft = { rules: [{ name: "External edit" }], draftId: "someone-else", metadata: {} };
    expect((await policyRequest("/draft", payload)).status).toBe(409);
    provider.draft = null;
    provider.rules = [{ name: "Unrecognized new policy" }];
    expect((await policyRequest("/draft", payload)).status).toBe(409);
    expect(provider.writes).toEqual([]);
  });
  it("does not publish a draft changed after review", async () => {
    await ready();
    const provider = policyProvider();
    const payload = await policyDraftBody();
    const proposal = (await (await policyRequest("/draft", payload)).json()).data;
    if (!provider.draft) throw new Error("Expected saved draft");
    provider.draft.rules[0].name = "Changed elsewhere";
    expect(
      (
        await policyRequest("/publish", {
          selection: payload.selection,
          proposalId: proposal.proposalId,
        })
      ).status
    ).toBe(409);
    expect(provider.writes).toHaveLength(1);
  });
  it("does not retry an uncertain remote write or publish an altered provider response", async () => {
    await ready();
    const provider = policyProvider();
    const payload = await policyDraftBody();
    provider.loseWrite = true;
    expect((await policyRequest("/draft", payload)).status).toBe(503);
    const retry = await policyRequest("/draft", payload);
    expect((await retry.json()).data.state).toBe("unknown");
    expect(provider.writes).toHaveLength(1);
  });
  it("rejects a provider response that does not preserve the reviewed rules", async () => {
    await ready();
    const provider = policyProvider();
    const payload = await policyDraftBody();
    provider.mutateResponse = true;
    const response = await policyRequest("/draft", payload);
    expect((await response.json()).data.state).toBe("invalid");
    expect(provider.writes).toHaveLength(1);
  });
});
