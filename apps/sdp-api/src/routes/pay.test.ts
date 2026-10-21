import type { SdpEnvironment } from "@sdp/types/api-keys";
import { SOL_MINT } from "@sdp/types/well-known-tokens";

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { createPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { app } from "@/index";
import { createTenantScope } from "@/lib/tenant-scope";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { ENVIRONMENT_CLUSTER_CASES, installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { seedUnreadPrivyWallet } from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import {
  DEVNET_USDC_MINT,
  installPaymentsRouteTestHooks,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PRODUCTION_PROJECT_ID,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";

interface RequestWallet {
  projectId: string;
  custodyWalletId: string;
  walletId: string;
  publicKey: string;
}

interface RequestPayment {
  token: string;
  amount: string;
}

const SANDBOX_REQUEST_WALLET: RequestWallet = {
  projectId: TEST_PROJECT.id,
  custodyWalletId: TEST_CUSTODY_WALLET_ID,
  walletId: TEST_WALLET_ID,
  publicKey: TEST_SOLANA_ADDRESSES.wallet1,
};

const PRODUCTION_REQUEST_WALLET: RequestWallet = {
  projectId: TEST_PRODUCTION_PROJECT_ID,
  custodyWalletId: "cwlt_pay_production",
  walletId: "privy_pay_production",
  publicKey: TEST_SOLANA_ADDRESSES.wallet3,
};

const SOL_PAYMENT: RequestPayment = { token: SOL_MINT, amount: "1.5" };

async function seedProductionRequestWallet(): Promise<RequestWallet> {
  await seedUnreadPrivyWallet(getDb(env), {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    ...PRODUCTION_REQUEST_WALLET,
  });
  return PRODUCTION_REQUEST_WALLET;
}

const REQUEST_WALLET_BY_ENVIRONMENT = {
  sandbox: async () => SANDBOX_REQUEST_WALLET,
  production: seedProductionRequestWallet,
} as const satisfies Record<SdpEnvironment, () => Promise<RequestWallet>>;

const payableViewSchema = z.object({ solanaPayUrl: z.string() });

describe("Public payment request routes", () => {
  installPaymentsRouteTestHooks();
  const rpc = installClusterRpcStub();

  beforeEach(() => {
    rpc.answer("getSignaturesForAddress", []);
  });

  function createAwaitingPaymentRequest(wallet: RequestWallet, payment: RequestPayment) {
    return createPaymentRequestsRepository(
      env,
      createTenantScope({ organizationId: TEST_ORG.id, projectId: wallet.projectId })
    ).createPaymentRequest({
      organizationId: TEST_ORG.id,
      projectId: wallet.projectId,
      custodyWalletId: wallet.custodyWalletId,
      walletId: wallet.walletId,
      destinationAddress: wallet.publicKey,
      token: payment.token,
      amount: payment.amount,
      expiresAt: null,
      createdBy: TEST_USER.id,
    });
  }

  function calledClusters() {
    return new Set(rpc.calls.map((call) => call.cluster));
  }

  function getPayView(publicToken: string) {
    return app.request(`/pay/${publicToken}`, {}, env);
  }

  async function payableUrl(publicToken: string): Promise<URL> {
    const response = await getPayView(publicToken);
    expect(response.status).toBe(200);
    return new URL(payableViewSchema.parse(await response.json()).solanaPayUrl);
  }

  it.for(ENVIRONMENT_CLUSTER_CASES)(
    "reports and reads a $environment request on $cluster only",
    async ({ environment, cluster }) => {
      const request = await createAwaitingPaymentRequest(
        await REQUEST_WALLET_BY_ENVIRONMENT[environment](),
        SOL_PAYMENT
      );

      const response = await app.request(`/pay/${request.public_token}`, {}, env);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: "awaiting_payment",
        network: cluster,
      });
      expect(rpc.calls).toContainEqual({ cluster, method: "getSignaturesForAddress" });
      expect(calledClusters()).toEqual(new Set([cluster]));
    }
  );

  it("keeps an unresolved legacy request readable with no payable link", async () => {
    const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET, SOL_PAYMENT);
    await getDb(env)
      .prepare("UPDATE payment_requests SET custody_wallet_id = NULL WHERE id = ?")
      .bind(request.id)
      .run();

    const detailResponse = await getPayView(request.public_token);

    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      status: "awaiting_payment",
      solanaPayUrl: null,
    });
  });

  describe("transfer request link", () => {
    it("asks for the exact stored amount of an awaiting SPL request", async () => {
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET, {
        token: DEVNET_USDC_MINT,
        amount: "1234567.123456",
      });

      const url = await payableUrl(request.public_token);

      expect(url.protocol).toBe("solana:");
      expect(url.pathname).toBe(TEST_SOLANA_ADDRESSES.wallet1);
      expect([...url.searchParams]).toEqual([
        ["spl-token", DEVNET_USDC_MINT],
        ["reference", request.reference],
        ["label", "Solana Developer Platform"],
        ["message", "Pay 1234567.123456 USDC to Solana Developer Platform"],
        ["amount", "1234567.123456"],
      ]);
    });

    it("names no spl-token for a SOL request", async () => {
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET, SOL_PAYMENT);

      const url = await payableUrl(request.public_token);

      expect(url.pathname).toBe(TEST_SOLANA_ADDRESSES.wallet1);
      expect([...url.searchParams]).toEqual([
        ["reference", request.reference],
        ["label", "Solana Developer Platform"],
        ["message", "Pay 1.5 SOL to Solana Developer Platform"],
        ["amount", "1.5"],
      ]);
    });

    it("stops advertising a production request's link once its organization loses the entitlement (APE-351)", async () => {
      const request = await createAwaitingPaymentRequest(
        await seedProductionRequestWallet(),
        SOL_PAYMENT
      );
      expect((await payableUrl(request.public_token)).pathname).toBe(
        PRODUCTION_REQUEST_WALLET.publicKey
      );

      await getDb(env)
        .prepare("UPDATE organizations SET settings = NULL WHERE id = ?")
        .bind(TEST_ORG.id)
        .run();
      const refused = await getPayView(request.public_token);

      expect(refused.status).toBe(200);
      await expect(refused.json()).resolves.toMatchObject({
        status: "awaiting_payment",
        solanaPayUrl: null,
      });
    });

    it("stops advertising every request's link once its organization is deleted (HOO-1955)", async () => {
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET, SOL_PAYMENT);
      await getDb(env)
        .prepare("UPDATE organizations SET status = 'deleted' WHERE id = ?")
        .bind(TEST_ORG.id)
        .run();

      const refused = await getPayView(request.public_token);

      expect(refused.status).toBe(200);
      await expect(refused.json()).resolves.toMatchObject({
        status: "awaiting_payment",
        solanaPayUrl: null,
      });
    });

    it("keeps advertising a sandbox request's link without the production entitlement", async () => {
      await getDb(env)
        .prepare("UPDATE organizations SET settings = NULL WHERE id = ?")
        .bind(TEST_ORG.id)
        .run();
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET, SOL_PAYMENT);

      expect((await payableUrl(request.public_token)).pathname).toBe(TEST_SOLANA_ADDRESSES.wallet1);
    });
  });
});
