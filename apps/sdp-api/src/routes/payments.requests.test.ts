import type { createRpc } from "@sdp/rpc/solana";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { errorResponseSchema, successResponseSchema, z } from "@/openapi/schemas/base";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  createFeePaymentAdapterMock,
  createOrgSignerForCustodyWalletMock,
  createRpcMock,
  DEVNET_USDC_MINT,
  installPaymentsRouteTestHooks,
  seedCachedKey,
  seedCounterparty,
  TEST_API_KEY,
  TEST_CONFIG_ID,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import { seedDefaultProjects } from "@/test/helpers/projects";

const requestFieldsSchema = z.object({
  id: z.string().min(1),
  publicToken: z.string().min(1),
  reference: z.string().min(1),
  custodyWalletId: z.string().min(1).regex(/^\S+$/).nullable(),
  walletId: z.string().min(1),
  destinationAddress: z.string().min(1),
  token: z.string().min(1),
  amount: z.string().min(1),
  counterpartyId: z.string().nullable(),
  expiresAt: z.string().nullable(),
  status: z.string().min(1),
});
const requestResponseSchema = successResponseSchema(requestFieldsSchema);
const requestsResponseSchema = successResponseSchema(
  z.object({
    paymentRequests: z.array(requestFieldsSchema),
    total: z.number().int().nonnegative(),
  })
);

const HEADERS = {
  Authorization: `Bearer ${TEST_API_KEY.raw}`,
  "Content-Type": "application/json",
};

function createRequest(selector: Record<string, unknown>) {
  return app.request(
    "/v1/payments/requests",
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ token: DEVNET_USDC_MINT, amount: "25.00", ...selector }),
    },
    env
  );
}

async function selectWallet(permissions: ("payments:read" | "payments:write")[]) {
  await getDb(env)
    .prepare(
      `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
       VALUES ('akw_requests_selected', ?, ?, ?)`
    )
    .bind(TEST_API_KEY.id, TEST_WALLET_ID, JSON.stringify(permissions))
    .run();
  await seedCachedKey({
    walletScope: "selected",
    walletBindings: [
      { walletId: TEST_WALLET_ID, custodyWalletId: TEST_CUSTODY_WALLET_ID, permissions },
    ],
  });
}

async function seedConnectionWallet(projectId = TEST_PROJECT.id) {
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO provider_credentials
           (id, organization_id, project_id, provider, label, scope, source,
            storage_backend, encrypted_secret_payload, status, credential_version, created_by)
         VALUES ('pcred_requests_connection', ?, ?, 'privy', 'Request recipient', 'project',
                 'stored', 'encrypted_db', 'not-read', 'active', 1, ?)`
      )
      .bind(TEST_ORG.id, projectId, TEST_USER.id),
    getDb(env)
      .prepare(
        `INSERT INTO custody_connections
           (id, organization_id, project_id, provider, scope, provider_credential_id,
            provider_credential_scope_key, status, created_by)
         VALUES ('cconn_requests', ?, ?, 'privy', 'project', 'pcred_requests_connection',
                 ?, 'pending', ?)`
      )
      .bind(TEST_ORG.id, projectId, projectId, TEST_USER.id),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_connection_id, wallet_id, public_key, label, purpose, status)
         VALUES ('cwlt_requests_connection', 'cconn_requests', 'wal_requests_connection',
                 ?, 'Request recipient', 'transfer', 'active')`
      )
      .bind(TEST_SOLANA_ADDRESSES.wallet2),
    getDb(env).prepare(
      `UPDATE custody_connections
         SET status = 'active', last_check_status = 'success',
             last_check_at = sdp_iso_now(), activated_at = sdp_iso_now(),
             provider_account_fingerprint = 'sha256:requests-connection',
             default_custody_wallet_id = 'cwlt_requests_connection'
         WHERE id = 'cconn_requests'`
    ),
  ]);
}

describe("Payments routes — Payment Requests exact recipient", () => {
  installPaymentsRouteTestHooks();

  beforeEach(() => {
    createRpcMock.mockReturnValue({
      getSignaturesForAddress: () => ({ send: async () => [] }),
    } as unknown as ReturnType<typeof createRpc>);
  });

  it("creates and lists the exact recipient without changing Request terms", async () => {
    const response = await createRequest({ custodyWalletId: TEST_CUSTODY_WALLET_ID });
    expect(response.status).toBe(201);
    const created = requestResponseSchema.parse(await response.json());
    expect(created.data).toMatchObject({
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      walletId: TEST_WALLET_ID,
      token: DEVNET_USDC_MINT,
      amount: "25.00",
      status: "awaiting_payment",
    });

    const list = await app.request("/v1/payments/requests", { headers: HEADERS }, env);
    expect(list.status).toBe(200);
    expect(requestsResponseSchema.parse(await list.json())).toMatchObject({
      data: {
        total: 1,
        paymentRequests: [
          {
            id: created.data.id,
            publicToken: created.data.publicToken,
            reference: created.data.reference,
            custodyWalletId: TEST_CUSTODY_WALLET_ID,
          },
        ],
      },
    });
  });

  it("counts retained aliases when proving a legacy selector without changing exact eligibility", async () => {
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs
             (id, organization_id, project_id, provider, config_encrypted, encryption_version, status)
           VALUES ('cust_cfg_requests_retained', ?, ?, 'privy', 'test-config',
                   'sdp-custody-encryption-v1', 'archived')`
        )
        .bind(TEST_ORG.id, TEST_PROJECT.id),
      getDb(env)
        .prepare(
          `INSERT INTO custody_wallets
             (id, custody_config_id, wallet_id, public_key, status)
           VALUES ('cwlt_requests_retained', 'cust_cfg_requests_retained', ?, ?, 'inactive')`
        )
        .bind(TEST_WALLET_ID, TEST_SOLANA_ADDRESSES.wallet1),
    ]);
    expect((await createRequest({ custodyWalletId: TEST_CUSTODY_WALLET_ID })).status).toBe(201);
    expect((await createRequest({ custodyWalletId: "cwlt_requests_retained" })).status).toBe(404);
    expect((await createRequest({ walletId: TEST_WALLET_ID })).status).toBe(409);
  });

  it("keeps duplicate provider, address and label aliases distinct for exact creation", async () => {
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs
             (id, organization_id, project_id, provider, config_encrypted, encryption_version, status)
           VALUES ('cust_cfg_requests_duplicate', ?, ?, 'privy', 'test-config',
                   'sdp-custody-encryption-v1', 'active')`
        )
        .bind(TEST_ORG.id, TEST_PROJECT.id),
      getDb(env)
        .prepare(
          `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, label, status)
           VALUES ('cwlt_requests_duplicate', 'cust_cfg_requests_duplicate', ?, ?, 'Payments Wallet', 'active')`
        )
        .bind(TEST_WALLET_ID, TEST_SOLANA_ADDRESSES.wallet1),
    ]);

    for (const custodyWalletId of [TEST_CUSTODY_WALLET_ID, "cwlt_requests_duplicate"]) {
      const response = await createRequest({ custodyWalletId });
      expect(response.status).toBe(201);
      expect(requestResponseSchema.parse(await response.json())).toMatchObject({
        data: { custodyWalletId },
      });
    }
    expect((await createRequest({ walletId: TEST_WALLET_ID })).status).toBe(409);
    await selectWallet(["payments:write"]);
    expect((await createRequest({ custodyWalletId: TEST_CUSTODY_WALLET_ID })).status).toBe(403);
    expect((await createRequest({ custodyWalletId: "cwlt_requests_duplicate" })).status).toBe(403);
  });

  it.each([
    {},
    { custodyWalletId: TEST_CUSTODY_WALLET_ID, walletId: TEST_WALLET_ID },
    { custodyWalletId: TEST_CUSTODY_WALLET_ID, walletId: "wal_other" },
    { custodyWalletId: null },
    { custodyWalletId: 12 },
    { custodyWalletId: "" },
    { walletId: "" },
    { custodyWalletId: " " },
    { walletId: " " },
    { custodyWalletId: TEST_CUSTODY_WALLET_ID, custodyWaleltId: "cwlt_other" },
    { walletId: TEST_WALLET_ID, recipientWalletId: "cwlt_other" },
    { walletId: TEST_WALLET_ID, metadata: { walletId: "cwlt_other" } },
  ])("rejects missing, conflicting, malformed or unknown fields: %j", async (selector) => {
    expect((await createRequest(selector)).status).toBe(400);
    const list = await app.request("/v1/payments/requests", { headers: HEADERS }, env);
    expect(requestsResponseSchema.parse(await list.json())).toMatchObject({
      data: { total: 0, paymentRequests: [] },
    });
  });

  it("retains the unambiguous legacy selector and response fields", async () => {
    const response = await createRequest({ walletId: TEST_WALLET_ID });
    expect(response.status).toBe(201);
    expect(requestResponseSchema.parse(await response.json())).toMatchObject({
      data: {
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
        walletId: TEST_WALLET_ID,
        destinationAddress: TEST_SOLANA_ADDRESSES.wallet1,
      },
    });
  });

  it.each([
    { field: "amount", value: 25 },
    { field: "token", value: null },
    { field: "counterpartyId", value: 12 },
    { field: "expiresAt", value: 12 },
  ])("identifies malformed $field terms for both creation selectors", async ({ field, value }) => {
    for (const selector of [
      { walletId: TEST_WALLET_ID },
      { custodyWalletId: TEST_CUSTODY_WALLET_ID },
    ]) {
      const response = await createRequest({ ...selector, [field]: value });
      expect(response.status).toBe(400);
      const body = errorResponseSchema.parse(await response.json());
      expect(body.error.message).toContain(`→ at ${field}`);
    }
  });

  it("rejects unknown prototype fields from the original JSON body", async () => {
    const response = await app.request(
      "/v1/payments/requests",
      {
        method: "POST",
        headers: HEADERS,
        body: `{"walletId":"${TEST_WALLET_ID}","token":"${DEVNET_USDC_MINT}","amount":"25.00","__proto__":{}}`,
      },
      env
    );
    expect(response.status).toBe(400);
    const body = errorResponseSchema.parse(await response.json());
    expect(body.error.message).toContain("__proto__");
  });

  it("does not rescue a failed exact lookup using a matching provider reference", async () => {
    expect((await createRequest({ custodyWalletId: TEST_WALLET_ID })).status).toBe(404);
  });

  it("allows the current project's Config and Connection recipients without acquiring a signer", async () => {
    await seedConnectionWallet();
    const response = await createRequest({ custodyWalletId: "cwlt_requests_connection" });
    expect(response.status).toBe(201);
    expect(requestResponseSchema.parse(await response.json())).toMatchObject({
      data: {
        custodyWalletId: "cwlt_requests_connection",
        destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
      },
    });
    expect(createRpcMock).not.toHaveBeenCalled();
    expect(createFeePaymentAdapterMock).not.toHaveBeenCalled();
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
  });

  it("rejects a recipient belonging to another project", async () => {
    await seedConnectionWallet(`${TEST_PROJECT.id}_production`);
    expect((await createRequest({ custodyWalletId: "cwlt_requests_connection" })).status).toBe(404);
  });

  it("rejects an inactive Connection recipient", async () => {
    await seedConnectionWallet();
    await getDb(env)
      .prepare(
        "UPDATE custody_connections SET status = 'deactivated', deactivated_at = sdp_iso_now() WHERE id = 'cconn_requests'"
      )
      .run();
    expect((await createRequest({ custodyWalletId: "cwlt_requests_connection" })).status).toBe(404);
  });

  it("rejects another organization's exact recipient", async () => {
    await getDb(env)
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES ('org_requests_other', 'Other', 'requests-other', 'enterprise', 'active')"
      )
      .run();
    const other = await seedDefaultProjects(getDb(env), {
      organizationId: "org_requests_other",
      createdBy: TEST_USER.id,
      members: [],
    });
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs
             (id, organization_id, project_id, provider, config_encrypted, encryption_version, status)
           VALUES ('cust_cfg_requests_other', 'org_requests_other', ?, 'local', 'test-config',
                   'sdp-custody-encryption-v1', 'active')`
        )
        .bind(other.sandbox.id),
      getDb(env)
        .prepare(
          `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
           VALUES ('cwlt_requests_other', 'cust_cfg_requests_other', ?, ?, 'active')`
        )
        .bind(TEST_WALLET_ID, TEST_SOLANA_ADDRESSES.wallet1),
    ]);
    expect((await createRequest({ custodyWalletId: "cwlt_requests_other" })).status).toBe(404);
    expect((await createRequest({ walletId: TEST_WALLET_ID })).status).toBe(201);
  });

  it.each([
    { table: "custody_wallets", id: TEST_CUSTODY_WALLET_ID, status: "inactive" },
    { table: "custody_configs", id: TEST_CONFIG_ID, status: "inactive" },
    { table: "custody_configs", id: TEST_CONFIG_ID, status: "archived" },
  ])("preserves creation eligibility for unavailable $table", async ({ table, id, status }) => {
    await getDb(env).prepare(`UPDATE ${table} SET status = ? WHERE id = ?`).bind(status, id).run();
    expect((await createRequest({ custodyWalletId: TEST_CUSTODY_WALLET_ID })).status).toBe(404);
  });

  it("checks per-wallet payments:write independently of the route permissions", async () => {
    await selectWallet(["payments:read"]);
    expect((await createRequest({ custodyWalletId: TEST_CUSTODY_WALLET_ID })).status).toBe(403);
  });

  it("rejects a freshly revoked wallet grant despite the cached authorization", async () => {
    await selectWallet(["payments:write"]);
    expect((await createRequest({ custodyWalletId: TEST_CUSTODY_WALLET_ID })).status).toBe(201);
    await getDb(env)
      .prepare(
        "UPDATE api_key_wallet_permissions SET permissions = '[]'::jsonb WHERE api_key_id = ?"
      )
      .bind(TEST_API_KEY.id)
      .run();
    expect((await createRequest({ custodyWalletId: TEST_CUSTODY_WALLET_ID })).status).toBe(403);
    const list = await app.request("/v1/payments/requests", { headers: HEADERS }, env);
    expect(requestsResponseSchema.parse(await list.json())).toMatchObject({ data: { total: 1 } });
  });

  it("preserves the wallets:read route permission", async () => {
    await seedCachedKey({ permissions: ["payments:write"] });
    expect((await createRequest({ custodyWalletId: TEST_CUSTODY_WALLET_ID })).status).toBe(403);
  });

  it("preserves counterparty, expiry and amount semantics", async () => {
    const counterpartyId = await seedCounterparty();
    const response = await createRequest({
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      counterpartyId,
      expiresAt: "2000-01-01T00:00:00.000Z",
      amount: "0.125",
    });
    expect(response.status).toBe(201);
    expect(requestResponseSchema.parse(await response.json())).toMatchObject({
      data: {
        counterpartyId,
        expiresAt: "2000-01-01T00:00:00.000Z",
        amount: "0.125",
        status: "expired",
      },
    });
  });

  it("lists project history across wallet grants including nullable terminal recipients", async () => {
    const first = await createRequest({ custodyWalletId: TEST_CUSTODY_WALLET_ID });
    expect(first.status).toBe(201);
    const created = requestResponseSchema.parse(await first.json());
    await seedConnectionWallet();
    expect((await createRequest({ custodyWalletId: "cwlt_requests_connection" })).status).toBe(201);
    await getDb(env)
      .prepare(
        "UPDATE payment_requests SET custody_wallet_id = NULL, status = 'canceled' WHERE id = ?"
      )
      .bind(created.data.id)
      .run();
    await selectWallet(["payments:read"]);

    const list = await app.request("/v1/payments/requests", { headers: HEADERS }, env);
    expect(list.status).toBe(200);
    const listed = requestsResponseSchema.parse(await list.json());
    expect(listed.data.total).toBe(2);
    expect(listed.data.paymentRequests).toContainEqual(
      expect.objectContaining({
        id: created.data.id,
        publicToken: created.data.publicToken,
        reference: created.data.reference,
        custodyWalletId: null,
        walletId: TEST_WALLET_ID,
        destinationAddress: TEST_SOLANA_ADDRESSES.wallet1,
        status: "canceled",
      })
    );
    expect(listed.data.paymentRequests).toContainEqual(
      expect.objectContaining({ custodyWalletId: "cwlt_requests_connection" })
    );

    await seedCachedKey({
      projectId: `${TEST_PROJECT.id}_production`,
      walletScope: "all",
      walletBindings: [],
    });
    const otherProject = await app.request("/v1/payments/requests", { headers: HEADERS }, env);
    expect(otherProject.status).toBe(200);
    expect(requestsResponseSchema.parse(await otherProject.json())).toMatchObject({
      data: { total: 0, paymentRequests: [] },
    });
  });
});
