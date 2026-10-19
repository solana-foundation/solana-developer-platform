import type { Action } from "@sdp/types/actions";
import { wellKnownMint } from "@sdp/types/well-known-tokens";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { createPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { app } from "@/index";
import { createTenantScope } from "@/lib/tenant-scope";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

/**
 * APE-849: a payment request's public token is the bearer credential of its
 * `/pay/:token` link. Reads never disclose it; only create and the
 * `payment_requests.manage` link read return it.
 */
const ORGANIZATION_ID = "org_payment_request_token";
const PROJECT_ID = "prj_payment_request_token";
const USER_ID = "usr_payment_request_token";
const WALLET_ADDRESS = "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ";
const DEVNET_USDC = devnetUsdc();

function devnetUsdc(): string {
  const mint = wellKnownMint("USDC", "devnet");
  if (!mint) throw new Error("USDC has no devnet mint");
  return mint;
}

const READ_KEY = { id: "key_request_reader", raw: "sk_test_request_reader", prefix: "sk_test_rqr" };
const MANAGE_KEY = {
  id: "key_request_manager",
  raw: "sk_test_request_manager",
  prefix: "sk_test_rqm",
};

async function seedKey(key: typeof READ_KEY, grants: Action[]): Promise<void> {
  await seedProjectApiKey(getDb(env), env, {
    key,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    createdBy: USER_ID,
    grants,
  });
}

async function get(path: string, key: typeof READ_KEY): Promise<Response> {
  return app.request(path, { headers: { Authorization: `Bearer ${key.raw}` } }, env);
}

describe("payment request public tokens", () => {
  // Reads reconcile an awaiting request on chain; nothing has paid it, so
  // every read returns the stored row.
  const rpc = installClusterRpcStub();
  let requestId: string;
  let publicToken: string;

  beforeEach(async () => {
    rpc.answer("getSignaturesForAddress", []);
    await seedTestDatabase(env);
    const db = getDb(env);
    await db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'enterprise', 'active')"
      )
      .bind(ORGANIZATION_ID, "Payment request token", "payment-request-token")
      .run();
    await db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER_ID, "payment-request-token@example.com")
      .run();
    await seedDefaultProjects(db, {
      organizationId: ORGANIZATION_ID,
      createdBy: USER_ID,
      members: [],
      ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
    });
    await db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted)
         VALUES ('cfg_request_token', ?, ?, 'local', 'synthetic')`
      )
      .bind(ORGANIZATION_ID, PROJECT_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES ('cwlt_request_token', 'cfg_request_token', 'wlt_request_token', ?, 'Receiving', 'transfer', 'active')`
      )
      .bind(WALLET_ADDRESS)
      .run();
    await seedKey(READ_KEY, ["payment_requests.read"]);
    await seedKey(MANAGE_KEY, ["payment_requests.manage"]);

    const request = await createPaymentRequestsRepository(
      env,
      createTenantScope({ organizationId: ORGANIZATION_ID, projectId: PROJECT_ID })
    ).createPaymentRequest({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      counterpartyId: null,
      custodyWalletId: "cwlt_request_token",
      walletId: "wlt_request_token",
      destinationAddress: WALLET_ADDRESS,
      token: DEVNET_USDC,
      amount: "25.00",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      createdBy: USER_ID,
    });
    requestId = request.id;
    publicToken = request.public_token;
  });

  it.each([
    ["payment_requests.read", READ_KEY],
    ["payment_requests.manage", MANAGE_KEY],
  ] as const)("never lists the token, even to a key holding %s", async (_grant, key) => {
    const res = await get("/v1/payments/requests?status=awaiting_payment", key);

    expect(res.status).toBe(200);
    const body = z
      .object({ data: z.object({ paymentRequests: z.array(z.record(z.string(), z.unknown())) }) })
      .parse(await res.json());
    expect(body.data.paymentRequests).toHaveLength(1);
    expect(body.data.paymentRequests[0]).not.toHaveProperty("publicToken");
    expect(JSON.stringify(body)).not.toContain(publicToken);
  });

  it("never returns the token on a single read", async () => {
    const res = await get(`/v1/payments/requests/${requestId}`, MANAGE_KEY);

    expect(res.status).toBe(200);
    const body = z.object({ data: z.record(z.string(), z.unknown()) }).parse(await res.json());
    expect(body.data.id).toBe(requestId);
    expect(body.data).not.toHaveProperty("publicToken");
  });

  it("refuses the link to a key without payment_requests.manage, naming the action", async () => {
    const res = await get(`/v1/payments/requests/${requestId}/link`, READ_KEY);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { code: "INSUFFICIENT_PERMISSIONS", details: { action: "payment_requests.manage" } },
    });
  });

  it("returns the link token with payment_requests.manage", async () => {
    const res = await get(`/v1/payments/requests/${requestId}/link`, MANAGE_KEY);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { id: requestId, publicToken },
      meta: expect.anything(),
    });
  });

  it("refuses create to a key that can only read", async () => {
    const res = await app.request(
      "/v1/payments/requests",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${READ_KEY.raw}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          walletId: "wlt_request_token",
          token: DEVNET_USDC,
          amount: "1.00",
        }),
      },
      env
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { details: { action: "payment_requests.manage" } },
    });
  });

  it("refuses the link to a wallet-bound key without payments:write on the receiving wallet", async () => {
    await getDb(env)
      .prepare(
        `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
         VALUES ('akw_request_token', ?, 'wlt_request_token', '["payments:read"]')`
      )
      .bind(MANAGE_KEY.id)
      .run();

    const res = await get(`/v1/payments/requests/${requestId}/link`, MANAGE_KEY);

    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain(publicToken);
  });

  it("answers 404 for a request in another project", async () => {
    const res = await get("/v1/payments/requests/preq_missing", MANAGE_KEY);
    expect(res.status).toBe(404);
  });
});
