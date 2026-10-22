import type { SdpEnvironment } from "@sdp/types/api-keys";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import {
  createPaymentRequestsRepository,
  createSystemPaymentRequestsRepository,
} from "@/db/repositories/repository-factory";
import { app } from "@/index";
import { createTenantScope } from "@/lib/tenant-scope";
import { AuditService } from "@/services/audit.service";
import * as sponsorshipService from "@/services/sponsorship.service";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import {
  clusterOfRpcClient,
  ENVIRONMENT_CLUSTER_CASES,
  installClusterRpcStub,
} from "@/test/helpers/cluster-rpc";
import { seedUnreadPrivyWallet } from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import {
  createKoraAdapterMock,
  getRecentBlockhashMock,
  installPaymentsRouteTestHooks,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PRODUCTION_PROJECT_ID,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import {
  sponsorSignTestTransaction,
  TEST_MOCK_FEE_PAYER,
  TEST_MOCK_FEE_PAYER_KEY_PAIR,
} from "@/test/helpers/sponsor-signing";

interface RequestWallet {
  projectId: string;
  custodyWalletId: string;
  walletId: string;
  publicKey: string;
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

const sponsoredTransactionResponseSchema = z.object({ transaction: z.string() });

const sponsoredGrantAuditSchema = z.object({
  action: z.string(),
  organization_id: z.string(),
  metadata: z.string(),
});

const sponsoredGrantMetadataSchema = z.object({
  sponsoredAccount: z.string(),
  signature: z.string().min(1),
});

describe("Public payment request routes", () => {
  installPaymentsRouteTestHooks();
  const rpc = installClusterRpcStub();

  beforeEach(() => {
    rpc.answer("getSignaturesForAddress", []);
    rpc.answer("getBlockHeight", 900);
  });

  function createAwaitingPaymentRequest(wallet: RequestWallet) {
    return createPaymentRequestsRepository(
      env,
      createTenantScope({ organizationId: TEST_ORG.id, projectId: wallet.projectId })
    ).createPaymentRequest({
      organizationId: TEST_ORG.id,
      projectId: wallet.projectId,
      custodyWalletId: wallet.custodyWalletId,
      walletId: wallet.walletId,
      destinationAddress: wallet.publicKey,
      token: SOL_MINT,
      amount: "1.5",
      expiresAt: null,
      createdBy: TEST_USER.id,
    });
  }

  function calledClusters() {
    return new Set(rpc.calls.map((call) => call.cluster));
  }

  function postTransaction(publicToken: string) {
    return app.request(
      `/pay/${publicToken}/tx`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: TEST_SOLANA_ADDRESSES.wallet2 }),
      },
      env
    );
  }

  function stubSponsorship() {
    return vi.spyOn(sponsorshipService, "createSponsorshipFeePayment").mockImplementation(() => ({
      providerId: "test",
      getFeePayer: async () => TEST_MOCK_FEE_PAYER,
      signAsFeePayer: sponsorSignTestTransaction,
      getSponsorshipConfiguration: () => Promise.reject(new Error("not used")),
      prepareOwnedSubmission: () => Promise.reject(new Error("not used")),
    }));
  }

  it.for(ENVIRONMENT_CLUSTER_CASES)(
    "reports and reads a $environment request on $cluster only",
    async ({ environment, cluster }) => {
      const request = await createAwaitingPaymentRequest(
        await REQUEST_WALLET_BY_ENVIRONMENT[environment]()
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

  it("keeps an unresolved legacy request readable but refuses to build its transaction", async () => {
    const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET);
    await getDb(env)
      .prepare("UPDATE payment_requests SET custody_wallet_id = NULL WHERE id = ?")
      .bind(request.id)
      .run();

    const detailResponse = await app.request(`/pay/${request.public_token}`, {}, env);

    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      status: "awaiting_payment",
      solanaPayUrl: null,
    });

    const transactionResponse = await app.request(
      `/pay/${request.public_token}/tx`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: TEST_SOLANA_ADDRESSES.wallet2 }),
      },
      env
    );

    expect(transactionResponse.status).toBe(409);
    await expect(transactionResponse.json()).resolves.toMatchObject({
      error: { code: "CONFLICT" },
    });
    expect(createKoraAdapterMock).not.toHaveBeenCalled();
    expect(getRecentBlockhashMock).not.toHaveBeenCalled();
  });

  describe("sponsored transaction window", () => {
    it.for(ENVIRONMENT_CLUSTER_CASES)(
      "refuses the sponsor as payer for a $environment request before claiming or signing",
      async ({ environment }) => {
        const sign = vi.fn(sponsorSignTestTransaction);
        stubSponsorship().mockImplementation(() => ({
          providerId: "test",
          getFeePayer: async () => TEST_MOCK_FEE_PAYER,
          signAsFeePayer: sign,
          getSponsorshipConfiguration: () => Promise.reject(new Error("not used")),
          prepareOwnedSubmission: () => Promise.reject(new Error("not used")),
        }));
        const request = await createAwaitingPaymentRequest(
          await REQUEST_WALLET_BY_ENVIRONMENT[environment]()
        );

        const response = await app.request(
          `/pay/${request.public_token}/tx`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ account: TEST_MOCK_FEE_PAYER }),
          },
          env
        );

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: { code: "BAD_REQUEST", message: "Payment payer cannot be the fee sponsor" },
        });
        expect(sign).not.toHaveBeenCalled();
        expect(getRecentBlockhashMock).not.toHaveBeenCalled();
        expect(
          await createSystemPaymentRequestsRepository(env).getSponsoredTransactionClaim(request.id)
        ).toBeNull();
        expect((await postTransaction(request.public_token)).status).toBe(200);
      }
    );

    it.for(["unsigned", "signed"] as const)(
      "refuses a stored $0 claim whose payer is its original sponsor",
      async (state) => {
        const sponsorship = stubSponsorship();
        const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET);
        const transaction = compileTransaction(
          pipe(
            createTransactionMessage({ version: 0 }),
            (message) => setTransactionMessageFeePayer(TEST_MOCK_FEE_PAYER, message),
            (message) =>
              setTransactionMessageLifetimeUsingBlockhash(
                {
                  blockhash: blockhash(getBase58Decoder().decode(new Uint8Array(32).fill(7))),
                  lastValidBlockHeight: 1_000n,
                },
                message
              ),
            (message) =>
              appendTransactionMessageInstruction(
                getTransferSolInstruction({
                  source: createNoopSigner(TEST_MOCK_FEE_PAYER),
                  destination: address(SANDBOX_REQUEST_WALLET.publicKey),
                  amount: 1_500_000_000n,
                }),
                message
              )
          )
        );
        const unsignedTransaction = getBase64EncodedWireTransaction(transaction);
        const repository = createSystemPaymentRequestsRepository(env);
        expect(
          await repository.claimSponsoredTransactionWindow({
            requestId: request.id,
            account: TEST_MOCK_FEE_PAYER,
            unsignedTransaction,
            lastValidBlockHeight: 1_000n,
            currentBlockHeight: 900n,
          })
        ).toBe(true);
        if (state === "signed") {
          expect(
            await repository.storeSponsoredTransactionSignature({
              requestId: request.id,
              account: TEST_MOCK_FEE_PAYER,
              unsignedTransaction,
              signedTransaction: getBase64EncodedWireTransaction(
                await partiallySignTransaction([TEST_MOCK_FEE_PAYER_KEY_PAIR], transaction)
              ),
            })
          ).toBe(true);
        }

        const response = await app.request(
          `/pay/${request.public_token}/tx`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ account: TEST_MOCK_FEE_PAYER }),
          },
          env
        );

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: { code: "BAD_REQUEST", message: "Payment payer cannot be the fee sponsor" },
        });
        expect(sponsorship).not.toHaveBeenCalled();
      }
    );

    it.for(ENVIRONMENT_CLUSTER_CASES)(
      "builds a $environment request's sponsored transaction on $cluster only",
      async ({ environment, cluster }) => {
        const sponsorship = stubSponsorship();
        const wallet = await REQUEST_WALLET_BY_ENVIRONMENT[environment]();
        const request = await createAwaitingPaymentRequest(wallet);

        expect((await postTransaction(request.public_token)).status).toBe(200);
        expect(sponsorship).toHaveBeenCalledWith(
          env,
          expect.objectContaining({ projectId: wallet.projectId }),
          "payments.pay_request"
        );
        expect(rpc.calls).toContainEqual({ cluster, method: "getSignaturesForAddress" });
        expect(rpc.calls).toContainEqual({ cluster, method: "getBlockHeight" });
        expect(calledClusters()).toEqual(new Set([cluster]));
        expect(
          new Set(getRecentBlockhashMock.mock.calls.map(([client]) => clusterOfRpcClient(client)))
        ).toEqual(new Set([cluster]));
      }
    );

    it("signs once per window and replays the stored transaction for the same account", async () => {
      const sponsorship = stubSponsorship();
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET);

      const first = await postTransaction(request.public_token);
      expect(first.status).toBe(200);
      const firstBody = sponsoredTransactionResponseSchema.parse(await first.json());

      const second = await postTransaction(request.public_token);
      expect(second.status).toBe(200);
      const secondBody = sponsoredTransactionResponseSchema.parse(await second.json());

      expect(secondBody.transaction).toBe(firstBody.transaction);
      expect(sponsorship).toHaveBeenCalledTimes(1);
    });

    it("stops sponsoring a production request once its organization loses the entitlement (APE-351)", async () => {
      const sponsorship = stubSponsorship();
      const request = await createAwaitingPaymentRequest(await seedProductionRequestWallet());

      expect((await postTransaction(request.public_token)).status).toBe(200);

      await getDb(env)
        .prepare("UPDATE organizations SET settings = NULL WHERE id = ?")
        .bind(TEST_ORG.id)
        .run();
      const refused = await postTransaction(request.public_token);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        error: { code: "FORBIDDEN", message: "Production is not enabled for this organization" },
      });
      expect(sponsorship).toHaveBeenCalledTimes(1);
    });

    it("stops sponsoring every request once its organization is deleted (HOO-1955)", async () => {
      const sponsorship = stubSponsorship();
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET);
      await getDb(env)
        .prepare("UPDATE organizations SET status = 'deleted' WHERE id = ?")
        .bind(TEST_ORG.id)
        .run();

      const refused = await postTransaction(request.public_token);

      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        error: { code: "FORBIDDEN", message: "Organization is not active" },
      });
      expect(sponsorship).not.toHaveBeenCalled();
    });

    it("keeps sponsoring a sandbox request without the production entitlement", async () => {
      stubSponsorship();
      await getDb(env)
        .prepare("UPDATE organizations SET settings = NULL WHERE id = ?")
        .bind(TEST_ORG.id)
        .run();
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET);
      expect((await postTransaction(request.public_token)).status).toBe(200);
    });

    it("answers a different account with 429 and Retry-After while the claim is live", async () => {
      stubSponsorship();
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET);
      expect((await postTransaction(request.public_token)).status).toBe(200);

      const other = await app.request(
        `/pay/${request.public_token}/tx`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: TEST_SOLANA_ADDRESSES.wallet3 }),
        },
        env
      );
      expect(other.status).toBe(429);
      expect(Number(other.headers.get("Retry-After"))).toBeGreaterThan(0);
    });

    it("lets a new account claim after the window expires", async () => {
      const sponsorship = stubSponsorship();
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET);
      expect((await postTransaction(request.public_token)).status).toBe(200);

      rpc.answer("getBlockHeight", 2_000);

      const other = await app.request(
        `/pay/${request.public_token}/tx`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: TEST_SOLANA_ADDRESSES.wallet3 }),
        },
        env
      );
      expect(other.status).toBe(200);
      expect(sponsorship).toHaveBeenCalledTimes(2);
    });

    it("keeps the claim when signing fails and signs the stored bytes on retry", async () => {
      const sponsorship = stubSponsorship();
      sponsorship.mockImplementationOnce(() => ({
        providerId: "test",
        getFeePayer: async () => TEST_MOCK_FEE_PAYER,
        signAsFeePayer: () => Promise.reject(new Error("signing timed out")),
        getSponsorshipConfiguration: () => Promise.reject(new Error("not used")),
        prepareOwnedSubmission: () => Promise.reject(new Error("not used")),
      }));
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET);

      expect((await postTransaction(request.public_token)).status).toBe(500);
      const retried = await postTransaction(request.public_token);
      expect(retried.status).toBe(200);
      expect(sponsorship).toHaveBeenCalledTimes(2);
    });

    it("audits a fresh sponsored grant exactly once and keeps replay polls off the ledger", async () => {
      stubSponsorship();
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET);

      expect((await postTransaction(request.public_token)).status).toBe(200);
      expect((await postTransaction(request.public_token)).status).toBe(200);

      const rows = await getDb(env)
        .prepare(
          "SELECT action, organization_id, metadata FROM audit_logs WHERE resource_type = 'payment_request' AND resource_id = ?"
        )
        .bind(request.id)
        .all();
      expect(rows.results).toHaveLength(1);
      const entry = sponsoredGrantAuditSchema.parse(rows.results[0]);
      expect(entry).toMatchObject({ action: "sign", organization_id: TEST_ORG.id });
      expect(sponsoredGrantMetadataSchema.parse(JSON.parse(entry.metadata))).toMatchObject({
        sponsoredAccount: TEST_SOLANA_ADDRESSES.wallet2,
      });
    });

    it("refuses and does not store the grant when its audit entry cannot be persisted", async () => {
      stubSponsorship();
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET);
      const failure = vi
        .spyOn(AuditService.prototype, "log")
        .mockRejectedValueOnce(new Error("checkpoint store down"));

      const response = await postTransaction(request.public_token);

      expect(response.status).toBe(500);
      expect(failure).toHaveBeenCalledTimes(1);
      const claim = await getDb(env)
        .prepare("SELECT sponsored_tx_signed FROM payment_requests WHERE id = ?")
        .bind(request.id)
        .first<{ sponsored_tx_signed: string | null }>();
      expect(claim).toEqual({ sponsored_tx_signed: null });

      const retried = await postTransaction(request.public_token);
      expect(retried.status).toBe(200);
      const rows = await getDb(env)
        .prepare(
          "SELECT id FROM audit_logs WHERE resource_type = 'payment_request' AND resource_id = ?"
        )
        .bind(request.id)
        .all();
      expect(rows.results).toHaveLength(1);
    });

    it("does not open a claim for a payload it cannot build a transaction from", async () => {
      const sponsorship = stubSponsorship();
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET);

      const malformed = await app.request(
        `/pay/${request.public_token}/tx`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: "not-a-solana-address" }),
        },
        env
      );
      expect(malformed.status).toBe(400);
      expect(sponsorship).not.toHaveBeenCalled();

      expect((await postTransaction(request.public_token)).status).toBe(200);
    });
  });
});
