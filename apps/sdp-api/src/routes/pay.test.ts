import type { SdpEnvironment } from "@sdp/types/api-keys";
import { getSdpDocsOrigin } from "@sdp/types/site";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import {
  AccountRole,
  blockhash,
  decompileTransactionMessage,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import {
  getTransferSolInstructionDataDecoder,
  SYSTEM_PROGRAM_ADDRESS,
} from "@solana-program/system";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { createPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { app } from "@/index";
import { createTenantScope } from "@/lib/tenant-scope";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import {
  clusterOfRpcClient,
  ENVIRONMENT_CLUSTER_CASES,
  installClusterRpcResponder,
} from "@/test/helpers/cluster-rpc";
import { seedUnreadPrivyWallet } from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import {
  getRecentBlockhashMock,
  installPaymentsRouteTestHooks,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PRODUCTION_PROJECT_ID,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import { required } from "@/test/helpers/required";

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

const PAYER = TEST_SOLANA_ADDRESSES.wallet2;

const PAY_BLOCKHASH = blockhash("2Z8oHviEbrqDD5kg2sW8h8kYceqdVTnrrPL6Lk2nBfRG");

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

const transactionResponseSchema = z.object({ transaction: z.string(), message: z.string() });

const signaturesForAddressParamsSchema = z.tuple([
  z.string(),
  z.object({ commitment: z.string() }),
]);

const CONFIRMED_PAYMENT_SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(9));

describe("Public payment request routes", () => {
  installPaymentsRouteTestHooks();
  const rpc = installClusterRpcResponder();

  beforeEach(() => {
    rpc.answer("getSignaturesForAddress", []);
    getRecentBlockhashMock.mockResolvedValue({
      blockhash: PAY_BLOCKHASH,
      lastValidBlockHeight: 1_000n,
    });
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

  function postTransaction(publicToken: string) {
    return app.request(
      `/pay/${publicToken}/tx`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: PAYER }),
      },
      env
    );
  }

  async function updateOrganization(sql: string) {
    await getDb(env).prepare(sql).bind(TEST_ORG.id).run();
  }

  it.for(ENVIRONMENT_CLUSTER_CASES)(
    "reports and reads a $environment request on $cluster only",
    async ({ environment, cluster }) => {
      const request = await createAwaitingPaymentRequest(
        await REQUEST_WALLET_BY_ENVIRONMENT[environment](),
        SOL_PAYMENT
      );

      const response = await getPayView(request.public_token);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: "awaiting_payment",
        network: cluster,
      });
      expect(rpc.calls).toContainEqual({ cluster, method: "getSignaturesForAddress" });
      expect(calledClusters()).toEqual(new Set([cluster]));
    }
  );

  it("keeps an unresolved legacy request readable but refuses to build its transaction", async () => {
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

    const transactionResponse = await postTransaction(request.public_token);

    expect(transactionResponse.status).toBe(409);
    await expect(transactionResponse.json()).resolves.toMatchObject({
      error: { code: "CONFLICT" },
    });
    expect(getRecentBlockhashMock).not.toHaveBeenCalled();
  });

  describe("payment link", () => {
    it("links an awaiting request to its transaction request", async () => {
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET, SOL_PAYMENT);

      const response = await getPayView(request.public_token);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        amount: "1.5",
        token: SOL_MINT,
        tokenSymbol: "SOL",
        recipient: SANDBOX_REQUEST_WALLET.publicKey,
        reference: request.reference,
        status: "awaiting_payment",
        expiresAt: null,
        network: "devnet",
        solanaPayUrl: `solana:https://localhost/pay/${request.public_token}/tx`,
      });
    });

    it("stops linking a production request once its organization loses the entitlement (APE-351)", async () => {
      const request = await createAwaitingPaymentRequest(
        await seedProductionRequestWallet(),
        SOL_PAYMENT
      );
      await expect((await getPayView(request.public_token)).json()).resolves.toMatchObject({
        solanaPayUrl: `solana:https://localhost/pay/${request.public_token}/tx`,
      });

      await updateOrganization("UPDATE organizations SET settings = NULL WHERE id = ?");
      const refused = await getPayView(request.public_token);

      expect(refused.status).toBe(200);
      await expect(refused.json()).resolves.toMatchObject({
        status: "awaiting_payment",
        solanaPayUrl: null,
      });
    });

    it("stops linking every request once its organization is deleted (HOO-1955)", async () => {
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET, SOL_PAYMENT);
      await updateOrganization("UPDATE organizations SET status = 'deleted' WHERE id = ?");

      const refused = await getPayView(request.public_token);

      expect(refused.status).toBe(200);
      await expect(refused.json()).resolves.toMatchObject({
        status: "awaiting_payment",
        solanaPayUrl: null,
      });
    });

    it("keeps linking a sandbox request without the production entitlement", async () => {
      await updateOrganization("UPDATE organizations SET settings = NULL WHERE id = ?");
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET, SOL_PAYMENT);

      await expect((await getPayView(request.public_token)).json()).resolves.toMatchObject({
        solanaPayUrl: `solana:https://localhost/pay/${request.public_token}/tx`,
      });
    });
  });

  describe("transaction request", () => {
    it("describes the request to the wallet before it posts its account", async () => {
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET, SOL_PAYMENT);

      const response = await app.request(`/pay/${request.public_token}/tx`, {}, env);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        label: "Solana Developer Platform",
        icon: `${getSdpDocsOrigin()}/icon.svg`,
      });
    });

    it.for(ENVIRONMENT_CLUSTER_CASES)(
      "builds a $environment SOL request as an unsigned payer-paid transfer on $cluster only",
      async ({ environment, cluster }) => {
        const wallet = await REQUEST_WALLET_BY_ENVIRONMENT[environment]();
        const request = await createAwaitingPaymentRequest(wallet, {
          token: SOL_MINT,
          amount: "0.123456789",
        });

        const response = await postTransaction(request.public_token);

        expect(response.status).toBe(200);
        const body = transactionResponseSchema.parse(await response.json());
        expect(body.message).toBe("Pay 0.123456789 SOL to Solana Developer Platform");
        const transaction = getTransactionDecoder().decode(
          getBase64Encoder().encode(body.transaction)
        );
        expect(transaction.signatures).toEqual({ [PAYER]: null });
        const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
        expect(compiled.lifetimeToken).toBe(PAY_BLOCKHASH);
        const message = decompileTransactionMessage(compiled);
        expect(message.feePayer.address).toBe(PAYER);
        expect(message.instructions).toHaveLength(1);
        const [transfer] = message.instructions;
        expect(transfer.programAddress).toBe(SYSTEM_PROGRAM_ADDRESS);
        expect(transfer.accounts).toEqual([
          { address: PAYER, role: AccountRole.WRITABLE_SIGNER },
          { address: wallet.publicKey, role: AccountRole.WRITABLE },
          { address: request.reference, role: AccountRole.READONLY },
        ]);
        expect(getTransferSolInstructionDataDecoder().decode(required(transfer.data)).amount).toBe(
          123_456_789n
        );
        expect(
          new Set(getRecentBlockhashMock.mock.calls.map(([client]) => clusterOfRpcClient(client)))
        ).toEqual(new Set([cluster]));
        expect(calledClusters()).toEqual(new Set([cluster]));
      }
    );

    it.for([
      {
        state: "canceled",
        close: async (requestId: string) => {
          required(
            await createPaymentRequestsRepository(
              env,
              createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
            ).markPaymentRequest({
              requestId,
              organizationId: TEST_ORG.id,
              projectId: TEST_PROJECT.id,
              status: "canceled",
              fulfilledByTransferId: null,
              canceledBy: TEST_USER.id,
            })
          );
        },
      },
      {
        state: "expired",
        close: async (requestId: string) => {
          await getDb(env)
            .prepare("UPDATE payment_requests SET expires_at = ? WHERE id = ?")
            .bind("2026-01-01T00:00:00.000Z", requestId)
            .run();
        },
      },
    ])("refuses to build a $state request's transaction", async ({ close }) => {
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET, SOL_PAYMENT);
      await close(request.id);

      const response = await postTransaction(request.public_token);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "BAD_REQUEST", message: "Payment request is no longer payable" },
      });
      expect(getRecentBlockhashMock).not.toHaveBeenCalled();
    });

    it("refuses to build while a payment for the request is already confirmed", async () => {
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET, SOL_PAYMENT);
      rpc.respond("getSignaturesForAddress", (call) => {
        const [, { commitment }] = signaturesForAddressParamsSchema.parse(call.params);
        return {
          result:
            commitment === "confirmed"
              ? [
                  {
                    signature: CONFIRMED_PAYMENT_SIGNATURE,
                    slot: 1,
                    err: null,
                    memo: null,
                    blockTime: null,
                    confirmationStatus: "confirmed",
                  },
                ]
              : [],
        };
      });

      const response = await postTransaction(request.public_token);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "CONFLICT", message: "A payment for this request is already on its way" },
      });
      expect(getRecentBlockhashMock).not.toHaveBeenCalled();
    });

    it("refuses to build a transaction once the organization is deleted (HOO-1955)", async () => {
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET, SOL_PAYMENT);
      await updateOrganization("UPDATE organizations SET status = 'deleted' WHERE id = ?");

      const response = await postTransaction(request.public_token);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "FORBIDDEN", message: "Organization is not active" },
      });
      expect(getRecentBlockhashMock).not.toHaveBeenCalled();
    });

    it("refuses to build a production request's transaction once the organization loses the entitlement (APE-351)", async () => {
      const request = await createAwaitingPaymentRequest(
        await seedProductionRequestWallet(),
        SOL_PAYMENT
      );
      await updateOrganization("UPDATE organizations SET settings = NULL WHERE id = ?");

      const response = await postTransaction(request.public_token);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "FORBIDDEN", message: "Production is not enabled for this organization" },
      });
      expect(getRecentBlockhashMock).not.toHaveBeenCalled();
    });
  });
});
