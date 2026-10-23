import { NATIVE_ASSET } from "@sdp/solana/asset-ref";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import { SOL_MINT, SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  getTransferSolInstruction,
  getTransferSolInstructionDataDecoder,
  SYSTEM_PROGRAM_ADDRESS,
} from "@solana-program/system";
import { getTransferCheckedWithFeeInstructionDataDecoder } from "@solana-program/token-2022";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import {
  createPaymentRequestsRepository,
  createSystemPaymentRequestsRepository,
} from "@/db/repositories/repository-factory";
import { recordedLegQuote } from "@/db/repositories/token-movement-legs.repository";
import { app } from "@/index";
import { createTenantScope } from "@/lib/tenant-scope";
import { AuditService } from "@/services/audit.service";
import * as sponsorshipService from "@/services/sponsorship.service";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import {
  clusterOfRpcClient,
  ENVIRONMENT_CLUSTER_CASES,
  epochInfoResult,
  installClusterRpcResponder,
  tokenAccountsByOwnerResult,
} from "@/test/helpers/cluster-rpc";
import { seedUnreadPrivyWallet } from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
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
import { required } from "@/test/helpers/required";
import {
  sponsorSignTestTransaction,
  TEST_MOCK_FEE_PAYER,
  TEST_MOCK_FEE_PAYER_KEY_PAIR,
} from "@/test/helpers/sponsor-signing";
import { scaledUiAmountConfig } from "@/test/helpers/token-mints";
import {
  answerMovementAccounts,
  associatedTokenAccount,
  mintRpcAccount,
  nativeQuote,
  sentInstructions,
  testExpectation,
  transferFeeExtension,
} from "@/test/helpers/token-movement";

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

const sponsoredTransactionResponseSchema = z.object({
  transaction: z.string(),
  message: z.string(),
});

const sponsoredGrantAuditSchema = z.object({
  action: z.string(),
  organization_id: z.string(),
  metadata: z.string(),
});

const sponsoredGrantMetadataSchema = z.object({
  sponsoredAccount: z.string(),
  signature: z.string().min(1),
});

const sponsoredOutcomeAuditSchema = z.object({ status: z.string(), metadata: z.string() });

const sponsoredIntentMetadataSchema = z.object({
  auditPhase: z.literal("intent"),
  target: z.object({
    action: z.string(),
    resourceType: z.string(),
    metadata: z.record(z.string(), z.unknown()),
  }),
});

describe("Public payment request routes", () => {
  installPaymentsRouteTestHooks();
  const rpc = installClusterRpcResponder();

  beforeEach(() => {
    rpc.answer("getBlockHeight", 900);
    rpc.respondSignatureStatuses(() => null);
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
      expectation: testExpectation(NATIVE_ASSET, "1.5", 9),
      expiresAt: null,
      createdBy: TEST_USER.id,
    });
  }

  it.each(["1.0000000001", "18446744073.709551616"])(
    "returns 400 for a legacy invalid SOL pay-link amount %s",
    async (amount) => {
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET);
      if (request === null) throw new Error("Expected a payment request fixture");
      // A legacy request: written before expectations, so /pay parses its amount itself.
      await getDb(env)
        .prepare(
          `UPDATE payment_requests
              SET amount = ?, asset_kind = NULL, mint = NULL, token_program = NULL,
                  decimals = NULL, expected_credit = NULL
            WHERE id = ?`
        )
        .bind(amount, request.id)
        .run();
      const response = await postTransaction(request.public_token);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
    }
  );

  function calledClusters() {
    return new Set(rpc.calls.map((call) => call.cluster));
  }

  function postTransaction(publicToken: string, account: string = TEST_SOLANA_ADDRESSES.wallet2) {
    return app.request(
      `/pay/${publicToken}/tx`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account }),
      },
      env
    );
  }

  /** The transaction id of a /pay answer: the sponsor's signature, which it signs first. */
  function issuedSignature(transaction: string): string {
    return getSignatureFromTransaction(
      getTransactionDecoder().decode(getBase64Encoder().encode(transaction))
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
    "reports a $environment request and reads its issued transactions on $cluster only",
    async ({ environment, cluster }) => {
      stubSponsorship();
      const request = await createAwaitingPaymentRequest(
        await REQUEST_WALLET_BY_ENVIRONMENT[environment]()
      );
      expect((await postTransaction(request.public_token)).status).toBe(200);

      const response = await app.request(`/pay/${request.public_token}`, {}, env);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: "awaiting_payment",
        network: cluster,
      });
      expect(rpc.calls).toContainEqual({ cluster, method: "getSignatureStatuses" });
      expect(rpc.calls.map((call) => call.method)).not.toContain("getSignaturesForAddress");
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
            quote: recordedLegQuote(nativeQuote("1.5", "credit")),
          })
        ).toBe(true);
        if (state === "signed") {
          const signed = await partiallySignTransaction(
            [TEST_MOCK_FEE_PAYER_KEY_PAIR],
            transaction
          );
          expect(
            await repository.storeSponsoredTransactionSignature({
              requestId: request.id,
              account: TEST_MOCK_FEE_PAYER,
              unsignedTransaction,
              signedTransaction: getBase64EncodedWireTransaction(signed),
              signature: getSignatureFromTransaction(signed),
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
          "payments.pay_request",
          { custodyWalletId: null }
        );
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

    it("lets a new account claim once the expired window is proven lapsed, not before", async () => {
      stubSponsorship();
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET);
      const first = await postTransaction(request.public_token);
      expect(first.status).toBe(200);
      const { transaction } = z.object({ transaction: z.string() }).parse(await first.json());

      // Past the window's last valid block height, but the window is too young
      // for settlement to read the chain tip, so it may still have landed.
      rpc.answer("getBlockHeight", 2_000);
      expect(
        (await postTransaction(request.public_token, TEST_SOLANA_ADDRESSES.wallet3)).status
      ).toBe(429);

      await getDb(env)
        .prepare("UPDATE payment_request_transactions SET created_at = ? WHERE signature = ?")
        .bind(new Date(Date.now() - 5 * 60_000).toISOString(), issuedSignature(transaction))
        .run();
      rpc.answer("getEpochInfo", epochInfoResult({ absoluteSlot: 1, blockHeight: 2_000 }));

      expect(
        (await postTransaction(request.public_token, TEST_SOLANA_ADDRESSES.wallet3)).status
      ).toBe(200);
      expect(
        await createSystemPaymentRequestsRepository(env).getSponsoredTransactionClaim(request.id)
      ).toMatchObject({ account: TEST_SOLANA_ADDRESSES.wallet3 });
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

    it("files a fresh grant's audit intent under its tenant with the message digest and mint", async () => {
      stubSponsorship();
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET);

      expect((await postTransaction(request.public_token)).status).toBe(200);

      const rows = await getDb(env)
        .prepare(
          "SELECT action, organization_id, metadata FROM audit_logs WHERE resource_type = 'audit_ledger' AND metadata::jsonb -> 'target' ->> 'resourceId' = ?"
        )
        .bind(request.id)
        .all();
      expect(rows.results).toHaveLength(1);
      const intent = sponsoredGrantAuditSchema.parse(rows.results[0]);
      expect(intent.organization_id).toBe(TEST_ORG.id);
      const metadata = sponsoredIntentMetadataSchema.parse(JSON.parse(intent.metadata));
      expect(metadata.target).toMatchObject({ action: "sign", resourceType: "payment_request" });
      expect(metadata.target.metadata).toMatchObject({
        organizationId: TEST_ORG.id,
        projectId: SANDBOX_REQUEST_WALLET.projectId,
        tokenMint: SOL_MINT,
        transactionDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(metadata.target.metadata).not.toHaveProperty("token");
    });

    it("records a failed sponsor sign as a failure outcome and errors the route", async () => {
      const sponsorship = stubSponsorship();
      sponsorship.mockImplementationOnce(() => ({
        providerId: "test",
        getFeePayer: async () => TEST_MOCK_FEE_PAYER,
        signAsFeePayer: () => Promise.reject(new Error("kora refused")),
        getSponsorshipConfiguration: () => Promise.reject(new Error("not used")),
        prepareOwnedSubmission: () => Promise.reject(new Error("not used")),
      }));
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET);

      expect((await postTransaction(request.public_token)).status).toBe(500);

      const rows = await getDb(env)
        .prepare(
          "SELECT status, metadata FROM audit_logs WHERE resource_type = 'payment_request' AND resource_id = ?"
        )
        .bind(request.id)
        .all();
      expect(rows.results).toHaveLength(1);
      const outcome = sponsoredOutcomeAuditSchema.parse(rows.results[0]);
      expect(outcome.status).toBe("failure");
      expect(JSON.parse(outcome.metadata)).toMatchObject({
        auditPhase: "outcome",
        errorCode: "UNCLASSIFIED_ERROR",
      });
      expect(outcome.metadata).not.toContain("kora refused");
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

    it("refuses a payer paying into the request's own wallet, which would move nothing", async () => {
      stubSponsorship();
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET);

      const response = await postTransaction(
        request.public_token,
        SANDBOX_REQUEST_WALLET.publicKey
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          message: "The destination is the source account: the transfer would move nothing",
        },
      });
      const windows = await getDb(env)
        .prepare(
          "SELECT COUNT(*)::integer AS count FROM payment_request_transactions WHERE payment_request_id = ?"
        )
        .bind(request.id)
        .first<{ count: number }>();
      expect(windows).toEqual({ count: 0 });
    });
  });

  describe("payment through the token movement builder (ADR 0012)", () => {
    const pyusd = address(WELL_KNOWN_TOKENS.PYUSD.mints.devnet.address);

    async function createPyusdRequest(options: { amount: string; decimals: number }) {
      return createPaymentRequestsRepository(
        env,
        createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
      ).createPaymentRequest({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
        walletId: TEST_WALLET_ID,
        destinationAddress: SANDBOX_REQUEST_WALLET.publicKey,
        token: pyusd,
        amount: options.amount,
        expectation: testExpectation(
          { kind: "token", mint: pyusd, program: "token-2022" },
          options.amount,
          options.decimals
        ),
        expiresAt: null,
        createdBy: TEST_USER.id,
      });
    }

    /** PYUSD with a 50 bps fee capped at 1 PYUSD, and the payer's account of it. */
    function answerPyusd(decimals: number) {
      answerMovementAccounts(
        rpc,
        new Map([
          [
            pyusd,
            mintRpcAccount("token-2022", {
              decimals,
              extensions: [transferFeeExtension(50, 1_000_000n)],
            }),
          ],
        ])
      );
      rpc.answer(
        "getTokenAccountsByOwner",
        tokenAccountsByOwnerResult(1, [
          {
            pubkey: TEST_SOLANA_ADDRESSES.wallet3,
            mint: pyusd,
            amount: "1000000000",
            decimals,
            uiAmountString: "1000",
            state: "initialized",
          },
        ])
      );
    }

    function instructionsOf(transaction: string) {
      return sentInstructions(new Uint8Array(getBase64Encoder().encode(transaction)));
    }

    async function settledTransfer(requestId: string) {
      return getDb(env)
        .prepare(
          `SELECT pt.amount, pt.signature, leg.basis, leg.quoted_debit, leg.quoted_fee,
                  leg.quoted_credit, leg.verification_state, leg.verification_reason
             FROM payment_requests pr
             JOIN payment_transfers pt ON pt.id = pr.fulfilled_by_transfer_id
             JOIN token_movement_legs leg ON leg.payment_transfer_id = pt.id
            WHERE pr.id = ?`
        )
        .bind(requestId)
        .first();
    }

    it("pays a SOL request with a system transfer carrying the reference, and settles on its signature", async () => {
      stubSponsorship();
      const request = await createAwaitingPaymentRequest(SANDBOX_REQUEST_WALLET);

      const response = await postTransaction(request.public_token);
      expect(response.status).toBe(200);
      const body = sponsoredTransactionResponseSchema.parse(await response.json());
      expect(body.message).toBe("Pay 1.5 SOL to Solana Developer Platform");
      const [transfer] = instructionsOf(body.transaction);
      expect(transfer?.programAddress).toBe(SYSTEM_PROGRAM_ADDRESS);
      expect(getTransferSolInstructionDataDecoder().decode(required(transfer?.data)).amount).toBe(
        1_500_000_000n
      );
      expect(transfer?.accounts.at(-1)).toBe(request.reference);

      const issued = issuedSignature(body.transaction);
      rpc.respondSignatureStatuses((candidate) =>
        candidate === issued
          ? { slot: 77, confirmations: 3, confirmationStatus: "confirmed", err: null }
          : null
      );
      const read = await app.request(`/pay/${request.public_token}`, {}, env);

      await expect(read.json()).resolves.toMatchObject({ status: "paid" });
      expect(await settledTransfer(request.id)).toEqual({
        amount: "1.5",
        signature: issued,
        basis: "credit",
        quoted_debit: "1500000000",
        quoted_fee: "0",
        quoted_credit: "1500000000",
        verification_state: "verified",
        verification_reason: "sdp_built_transfer_landed",
      });
    });

    it("refuses a request in a scaled UI amount mint before claiming, until wallets show token units", async () => {
      stubSponsorship();
      // Balances show the scaled amount until PR 5, so a payer would read one amount and pay another.
      const mint = syntheticAddress(355);
      answerMovementAccounts(
        rpc,
        new Map([
          [
            mint,
            mintRpcAccount("token-2022", {
              decimals: 6,
              extensions: [
                scaledUiAmountConfig({
                  multiplier: 2,
                  newMultiplier: 2,
                  newMultiplierEffectiveTimestamp: 1_750_000_000n,
                }),
              ],
            }),
          ],
        ])
      );
      rpc.answer(
        "getTokenAccountsByOwner",
        tokenAccountsByOwnerResult(1, [
          {
            pubkey: TEST_SOLANA_ADDRESSES.wallet3,
            mint,
            amount: "1000000000",
            decimals: 6,
            uiAmountString: "1000",
            state: "initialized",
          },
        ])
      );
      const request = await createPaymentRequestsRepository(
        env,
        createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
      ).createPaymentRequest({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
        walletId: TEST_WALLET_ID,
        destinationAddress: SANDBOX_REQUEST_WALLET.publicKey,
        token: mint,
        amount: "1.5",
        expectation: testExpectation({ kind: "token", mint, program: "token-2022" }, "1.5", 6),
        expiresAt: null,
        createdBy: TEST_USER.id,
      });

      const response = await postTransaction(request.public_token);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "BAD_REQUEST", details: { reason: "scaled_display" } },
      });
      expect(
        await createSystemPaymentRequestsRepository(env).getSponsoredTransactionClaim(request.id)
      ).toBeNull();
    });

    it("quotes a fee mint's request as a credit: the payer pays the fee, the message shows it", async () => {
      stubSponsorship();
      answerPyusd(6);
      const request = await createPyusdRequest({ amount: "0.995", decimals: 6 });

      const response = await postTransaction(request.public_token);
      const text = await response.text();
      expect(response.status, text).toBe(200);
      const body = sponsoredTransactionResponseSchema.parse(JSON.parse(text));
      expect(body.message).toBe(
        "Pay 1 PYUSD to Solana Developer Platform, including a 0.005 PYUSD transfer fee; the recipient receives 0.995 PYUSD"
      );
      const instructions = instructionsOf(body.transaction);
      const transfer = required(
        instructions.find(
          (instruction) => instruction.programAddress === SPL_TOKEN_PROGRAMS["token-2022"]
        )
      );
      expect(
        getTransferCheckedWithFeeInstructionDataDecoder().decode(required(transfer.data))
      ).toMatchObject({ amount: 1_000_000n, decimals: 6, fee: 5_000n });
      expect(transfer.accounts).toContain(
        await associatedTokenAccount("token-2022", pyusd, SANDBOX_REQUEST_WALLET.publicKey)
      );
      // The Solana Pay reference rides the transfer, last.
      expect(transfer.accounts.at(-1)).toBe(request.reference);

      const issued = issuedSignature(body.transaction);
      rpc.respondSignatureStatuses((candidate) =>
        candidate === issued
          ? { slot: 77, confirmations: 3, confirmationStatus: "confirmed", err: null }
          : null
      );
      await reconcileByRead(request.public_token);

      expect(await settledTransfer(request.id)).toEqual({
        amount: "0.995",
        signature: issued,
        basis: "credit",
        quoted_debit: "1000000",
        quoted_fee: "5000",
        quoted_credit: "995000",
        verification_state: "verified",
        verification_reason: "sdp_built_transfer_landed",
      });
    });

    it("refuses to pay a request whose mint changed its decimals since creation, before claiming", async () => {
      const sponsorship = stubSponsorship();
      answerPyusd(9);
      const request = await createPyusdRequest({ amount: "0.995", decimals: 6 });

      const response = await postTransaction(request.public_token);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "BAD_REQUEST", message: expect.stringContaining("mint changed") },
      });
      expect(
        await createSystemPaymentRequestsRepository(env).getSponsoredTransactionClaim(request.id)
      ).toBeNull();
      expect(sponsorship).toHaveBeenCalledTimes(1);
    });

    async function reconcileByRead(publicToken: string) {
      const read = await app.request(`/pay/${publicToken}`, {}, env);
      await expect(read.json()).resolves.toMatchObject({ status: "paid" });
    }
  });
});
