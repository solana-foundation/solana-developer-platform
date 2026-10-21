import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { successResponseSchema } from "@/openapi/schemas/base";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import {
  DEVNET_USDC_MINT,
  installPaymentsRouteTestHooks,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";

const requestFieldsSchema = z.object({
  id: z.string(),
  custodyWalletId: z.string(),
  walletId: z.never().optional(),
  publicToken: z.never().optional(),
  destinationAddress: z.string(),
});
const createdResponseSchema = successResponseSchema(
  requestFieldsSchema.extend({ publicToken: z.string().min(1) })
);
const listResponseSchema = successResponseSchema(
  z.object({ paymentRequests: z.array(requestFieldsSchema), total: z.number() })
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

describe("Payments routes — Payment Requests exact recipient", () => {
  installPaymentsRouteTestHooks();
  const rpc = installClusterRpcStub();

  beforeEach(() => {
    rpc.answer("getSignaturesForAddress", []);
  });

  it("creates and lists the selected recipient despite identical provider and address aliases", async () => {
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
          `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
           VALUES ('cwlt_requests_duplicate', 'cust_cfg_requests_duplicate', ?, ?, 'active')`
        )
        .bind(TEST_WALLET_ID, TEST_SOLANA_ADDRESSES.wallet1),
    ]);
    const response = await createRequest({ custodyWalletId: "cwlt_requests_duplicate" });
    expect(response.status).toBe(201);
    const created = createdResponseSchema.parse(await response.json());
    expect(created.data).toMatchObject({
      custodyWalletId: "cwlt_requests_duplicate",
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet1,
    });
    expect(
      await getDb(env)
        .prepare("SELECT custody_wallet_id FROM payment_requests WHERE id = ?")
        .bind(created.data.id)
        .first<{ custody_wallet_id: string }>()
    ).toEqual({ custody_wallet_id: "cwlt_requests_duplicate" });

    const list = await app.request("/v1/payments/requests", { headers: HEADERS }, env);
    expect(list.status).toBe(200);
    expect(listResponseSchema.parse(await list.json())).toMatchObject({
      data: {
        total: 1,
        paymentRequests: [{ id: created.data.id, custodyWalletId: "cwlt_requests_duplicate" }],
      },
    });
  });

  it.each([
    { walletId: TEST_WALLET_ID },
    { custodyWalletId: TEST_CUSTODY_WALLET_ID, walletId: TEST_WALLET_ID },
  ])("rejects the legacy provider selector without creating a Request: %j", async (selector) => {
    expect((await createRequest(selector)).status).toBe(400);
    const list = await app.request("/v1/payments/requests", { headers: HEADERS }, env);
    expect(list.status).toBe(200);
    expect(listResponseSchema.parse(await list.json())).toMatchObject({
      data: { total: 0, paymentRequests: [] },
    });
  });
});
