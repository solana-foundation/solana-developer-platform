import { formatDecimalAmount } from "@sdp/solana/amount";
import { PAYMENT_TRANSFER_STATUSES } from "@sdp/types/payments";
import type { RampProviderId } from "@sdp/types/provider-access";
import { SOL_MINT, type SolanaCluster, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import type { Signature } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { TEST_PRODUCTION_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import {
  type ClusterRpcRequest,
  installClusterRpcResponder,
  type JsonRpcResult,
  type StubTokenAccount,
  tokenAccountsByOwnerResult,
} from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import {
  parsedMintTo,
  parsedSystemTransfer,
  parsedTokenBalance,
  parsedTransactionResult,
  parsedTransferChecked,
  syntheticAddress,
  syntheticSignature,
} from "@/test/helpers/parsed-transactions";
import {
  DEVNET_USDC_MINT,
  getSignaturesForAddressMock,
  getSplTokenAccountAddressesMock,
  installPaymentsRouteTestHooks,
  seedCounterparty,
  seedProductionPrivyWallet,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PRODUCTION_PROJECT_ID,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import { seedRateLimit } from "@/test/mocks/kv";

const observedTransfersResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      signature: z.string().nullable(),
      amount: z.string(),
      direction: z.string(),
      status: z.enum(PAYMENT_TRANSFER_STATUSES),
      token: z.string(),
      source: z.string(),
      destination: z.string(),
    })
  ),
  meta: z.object({ total: z.number() }),
});

const signaturesForAddressParamsSchema = z.tuple([z.string(), z.unknown()]);

const tokenAccountsByOwnerParamsSchema = z.tuple([
  z.string(),
  z.object({ programId: z.string() }),
  z.unknown(),
]);

function confirmedHistoryEntry(entry: {
  signature: Signature;
  slot: number;
  blockTime: number;
}): JsonRpcResult {
  return {
    signature: entry.signature,
    slot: entry.slot,
    err: null,
    memo: null,
    blockTime: entry.blockTime,
    confirmationStatus: "confirmed",
  };
}

function historyRead(cluster: SolanaCluster, searchAddress: string): ClusterRpcRequest {
  return {
    cluster,
    method: "getSignaturesForAddress",
    params: [searchAddress, { limit: 100, commitment: "confirmed" }],
  };
}

describe("Payments routes — list transfers", () => {
  installPaymentsRouteTestHooks();
  const rpc = installClusterRpcResponder();

  function respondSignatureHistory(
    historyByAddress: ReadonlyMap<string, readonly JsonRpcResult[]>
  ) {
    rpc.respond("getSignaturesForAddress", (request) => {
      const [searchAddress] = signaturesForAddressParamsSchema.parse(request.params);
      const history = historyByAddress.get(searchAddress);
      if (history === undefined) {
        throw new Error(`No signature history stubbed for ${searchAddress}`);
      }
      return { result: history };
    });
  }

  function respondOwnedTokenAccounts(tokenAccounts: readonly StubTokenAccount[]) {
    rpc.respond("getTokenAccountsByOwner", (request) => {
      const [, filter] = tokenAccountsByOwnerParamsSchema.parse(request.params);
      return {
        result: tokenAccountsByOwnerResult(
          1,
          filter.programId === TOKEN_PROGRAM_ADDRESS ? tokenAccounts : []
        ),
      };
    });
  }

  function signatureHistoryReads() {
    return rpc.requests.filter((request) => request.method === "getSignaturesForAddress");
  }

  /** Answers every getTransaction with a 0.002 SOL deposit from wallet2 into `walletAddress`. */
  function answerSolDepositTransaction(deposit: {
    signature: Signature;
    walletAddress: string;
    slot: number;
    blockTime: number;
  }) {
    rpc.answer(
      "getTransaction",
      parsedTransactionResult({
        signature: deposit.signature,
        slot: deposit.slot,
        blockTime: deposit.blockTime,
        accountKeys: [TEST_SOLANA_ADDRESSES.wallet2, deposit.walletAddress],
        instructions: [
          parsedSystemTransfer({
            source: TEST_SOLANA_ADDRESSES.wallet2,
            destination: deposit.walletAddress,
            lamports: 2_000_000,
          }),
        ],
        innerInstructions: [],
        preTokenBalances: [],
        postTokenBalances: [],
      })
    );
  }

  function answerObservedSolDeposit(
    walletAddress: string,
    ownedTokenAccounts: readonly StubTokenAccount[]
  ): Signature {
    const observedSig = syntheticSignature(30);
    const historyByAddress = new Map<string, readonly JsonRpcResult[]>([
      [
        walletAddress,
        [confirmedHistoryEntry({ signature: observedSig, slot: 104, blockTime: 1700000400 })],
      ],
    ]);
    for (const tokenAccount of ownedTokenAccounts) {
      historyByAddress.set(tokenAccount.pubkey, []);
    }
    respondOwnedTokenAccounts(ownedTokenAccounts);
    respondSignatureHistory(historyByAddress);
    answerSolDepositTransaction({
      signature: observedSig,
      walletAddress,
      slot: 104,
      blockTime: 1700000400,
    });
    return observedSig;
  }

  async function listObservedTransfers(custodyWalletId: string) {
    const res = await app.request(
      `/v1/payments/transfers?custodyWalletId=${custodyWalletId}&includeObserved=true`,
      { method: "GET", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
    expect(res.status).toBe(200);
    return observedTransfersResponseSchema.parse(await res.json());
  }

  async function seedTransfer(params: {
    id: string;
    status: string;
    signature?: string | null;
    custodyWalletId?: string | null;
    walletId?: string;
    counterpartyId?: string | null;
    destination?: string;
    source?: string;
    token?: string;
    amount?: string;
    memo?: string | null;
    type?: "transfer" | "transfer_batch" | "onramp" | "offramp";
    direction?: "inbound" | "outbound";
    provider?: RampProviderId;
    providerReference?: string | null;
    createdAt?: string;
  }): Promise<void> {
    const now = params.createdAt ?? new Date().toISOString();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers
           (id, organization_id, project_id, custody_wallet_id, wallet_id, counterparty_id, source_address, destination_address, token, amount, memo, type, direction, status, provider, provider_reference, signature, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        params.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        params.custodyWalletId === undefined ? TEST_CUSTODY_WALLET_ID : params.custodyWalletId,
        params.walletId ?? TEST_WALLET_ID,
        params.counterpartyId ?? null,
        params.source ?? TEST_SOLANA_ADDRESSES.wallet1,
        params.destination ?? TEST_SOLANA_ADDRESSES.wallet2,
        params.token ?? "SOL",
        params.amount ?? "1",
        params.memo ?? null,
        params.type ?? "transfer",
        params.direction ?? "outbound",
        params.status,
        params.provider ?? null,
        params.providerReference ?? null,
        params.signature ?? null,
        now,
        now
      )
      .run();
  }

  describe("list transfers", () => {
    beforeEach(() => {
      getSignaturesForAddressMock.mockReset();
      getSplTokenAccountAddressesMock.mockReset();
      rpc.answer("getSignaturesForAddress", []);
      rpc.answer("getTokenAccountsByOwner", tokenAccountsByOwnerResult(1, []));
    });

    // A ramp or batch row is that module's record: transfers.read alone shows
    // neither, here or in the unified feed (HOO-2099).
    describe("with transfers.read alone", () => {
      const TRANSFERS_ONLY_KEY = {
        id: "key_transfers_read_only",
        raw: "sk_test_transfers_read_only",
        prefix: "sk_test_tro",
      };
      const asTransfersOnly = (path: string) =>
        app.request(
          path,
          { method: "GET", headers: { Authorization: `Bearer ${TRANSFERS_ONLY_KEY.raw}` } },
          env
        );
      const transferIdsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

      beforeEach(async () => {
        await seedProjectApiKey(getDb(env), env, {
          key: TRANSFERS_ONLY_KEY,
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT.id,
          createdBy: TEST_USER.id,
          grants: ["transfers.read"],
        });
        await seedTransfer({ id: "xfr_scope_plain", status: "confirmed" });
        await seedTransfer({ id: "xfr_scope_onramp", status: "confirmed", type: "onramp" });
        await seedTransfer({ id: "xfr_scope_batch", status: "confirmed", type: "transfer_batch" });
      });

      it("lists only plain transfers", async () => {
        const res = await asTransfersOnly("/v1/payments/transfers");

        expect(res.status).toBe(200);
        expect(
          transferIdsSchema.parse(await res.json()).data.map((transfer) => transfer.id)
        ).toEqual(["xfr_scope_plain"]);
      });

      it("answers a category it can read nothing of with an empty page", async () => {
        const res = await asTransfersOnly("/v1/payments/transfers?category=ramp");

        expect(res.status).toBe(200);
        expect(transferIdsSchema.parse(await res.json()).data).toEqual([]);
      });

      it("refuses a type filter it cannot read, naming the read", async () => {
        const res = await asTransfersOnly("/v1/payments/transfers?type=onramp");

        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({
          error: { code: "INSUFFICIENT_PERMISSIONS", details: { action: "onramp.read" } },
        });
      });

      it("does not disclose another module's row by id", async () => {
        expect((await asTransfersOnly("/v1/payments/transfers/xfr_scope_onramp")).status).toBe(404);
        expect((await asTransfersOnly("/v1/payments/transfers/xfr_scope_batch")).status).toBe(404);
        expect((await asTransfersOnly("/v1/payments/transfers/xfr_scope_plain")).status).toBe(200);
      });
    });

    // A channel without Ramps discloses no ramp rows, whatever the caller holds (APE SOLA9-698).
    describe("on a release channel without Ramps", () => {
      const asStable = (path: string) =>
        app.request(
          path,
          { method: "GET", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
          { ...env, SDP_RELEASE_CHANNEL: "stable" }
        );
      const transferIdsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

      beforeEach(async () => {
        await seedTransfer({ id: "xfr_stable_plain", status: "confirmed" });
        await seedTransfer({ id: "xfr_stable_onramp", status: "confirmed", type: "onramp" });
        await seedTransfer({ id: "xfr_stable_offramp", status: "confirmed", type: "offramp" });
      });

      it("leaves ramp rows out of the default list", async () => {
        const res = await asStable("/v1/payments/transfers");

        expect(res.status).toBe(200);
        expect(
          transferIdsSchema.parse(await res.json()).data.map((transfer) => transfer.id)
        ).toEqual(["xfr_stable_plain"]);
      });

      it.each(["/v1/payments/transfers?category=ramp", "/v1/payments/transfers?type=onramp"])(
        "refuses %s as outside the channel",
        async (path) => {
          const res = await asStable(path);

          expect(res.status).toBe(403);
          expect(await res.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
        }
      );

      it("does not disclose a ramp row by id", async () => {
        expect((await asStable("/v1/payments/transfers/xfr_stable_onramp")).status).toBe(404);
        expect((await asStable("/v1/payments/transfers/xfr_stable_offramp")).status).toBe(404);
        expect((await asStable("/v1/payments/transfers/xfr_stable_plain")).status).toBe(200);
      });
    });

    it("matches a token filter in any spelling against both forms the ledger stores, and no other asset", async () => {
      await seedTransfer({ id: "xfr_tok_symbol", status: "confirmed", token: "SOL" });
      await seedTransfer({ id: "xfr_tok_mint", status: "pending", token: SOL_MINT });
      await seedTransfer({ id: "xfr_tok_usdc", status: "confirmed", token: DEVNET_USDC_MINT });

      for (const spelling of ["sol", SOL_MINT]) {
        const res = await app.request(
          `/v1/payments/transfers?token=${spelling}`,
          { method: "GET", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
          env
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as { data: Array<{ id: string }> };
        expect(body.data.map((row) => row.id).sort()).toEqual(["xfr_tok_mint", "xfr_tok_symbol"]);
      }
    });

    it("merges a wallet's ledger rows with its on-chain history, one row per signature", async () => {
      const recordedSig = syntheticSignature(20);
      await seedTransfer({ id: "xfr_ledger_onchain", status: "confirmed", signature: recordedSig });
      await seedTransfer({
        id: "xfr_ledger_older",
        status: "finalized",
        signature: syntheticSignature(19),
      });
      await seedTransfer({ id: "xfr_ledger_pending", status: "pending" });
      respondSignatureHistory(
        new Map([
          [
            TEST_SOLANA_ADDRESSES.wallet1,
            [confirmedHistoryEntry({ signature: recordedSig, slot: 100, blockTime: 1700000000 })],
          ],
        ])
      );
      // The chain would describe the recorded signature too; the ledger row answers for it.
      answerSolDepositTransaction({
        signature: recordedSig,
        walletAddress: TEST_SOLANA_ADDRESSES.wallet1,
        slot: 100,
        blockTime: 1700000000,
      });

      const body = await listObservedTransfers(TEST_CUSTODY_WALLET_ID);

      expect(body.data.map((transfer) => transfer.id).sort()).toEqual([
        "xfr_ledger_older",
        "xfr_ledger_onchain",
        "xfr_ledger_pending",
      ]);
      expect(body.meta.total).toBe(3);
    });

    it("429s the observed-transfer path before any RPC call once the metered quota is exhausted", async () => {
      await seedRateLimit(
        env,
        `metered:observed-transfers:org:${TEST_ORG.id}:key:${TEST_API_KEY.id}`,
        30
      );

      const res = await app.request(
        `/v1/payments/transfers?custodyWalletId=${TEST_CUSTODY_WALLET_ID}&includeObserved=true`,
        { method: "GET", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );

      expect(res.status).toBe(429);
      expect(rpc.calls).toEqual([]);
    });

    it("discovers observed custom token deposits from owned token account history", async () => {
      const observedSig = syntheticSignature(23);
      const customMint = syntheticAddress(23);
      const destinationTokenAccount = syntheticAddress(24);
      const sourceTokenAccount = syntheticAddress(25);
      const customBalance = (accountIndex: number, owner: string, amount: string) =>
        parsedTokenBalance({
          accountIndex,
          mint: customMint,
          owner,
          tokenAmount: {
            amount,
            decimals: 6,
            uiAmountString: formatDecimalAmount(BigInt(amount), 6),
          },
        });
      rpc.answer(
        "getTransaction",
        parsedTransactionResult({
          signature: observedSig,
          slot: 102,
          blockTime: 1700000200,
          accountKeys: [TEST_SOLANA_ADDRESSES.wallet2, sourceTokenAccount, destinationTokenAccount],
          instructions: [
            parsedTransferChecked({
              source: sourceTokenAccount,
              destination: destinationTokenAccount,
              mint: customMint,
              authority: TEST_SOLANA_ADDRESSES.wallet2,
              tokenAmount: { amount: "25000000", decimals: 6, uiAmountString: "25" },
            }),
          ],
          innerInstructions: [],
          preTokenBalances: [
            customBalance(1, TEST_SOLANA_ADDRESSES.wallet2, "25000000"),
            customBalance(2, TEST_SOLANA_ADDRESSES.wallet1, "0"),
          ],
          postTokenBalances: [
            customBalance(1, TEST_SOLANA_ADDRESSES.wallet2, "0"),
            customBalance(2, TEST_SOLANA_ADDRESSES.wallet1, "25000000"),
          ],
        })
      );
      respondOwnedTokenAccounts([
        {
          pubkey: destinationTokenAccount,
          mint: customMint,
          amount: "25000000",
          decimals: 6,
          uiAmountString: "25",
          state: "initialized",
        },
      ]);
      respondSignatureHistory(
        new Map([
          [TEST_SOLANA_ADDRESSES.wallet1, []],
          [
            destinationTokenAccount,
            [confirmedHistoryEntry({ signature: observedSig, slot: 102, blockTime: 1700000200 })],
          ],
        ])
      );

      const body = await listObservedTransfers(TEST_CUSTODY_WALLET_ID);

      expect(signatureHistoryReads()).toEqual([
        historyRead("devnet", TEST_SOLANA_ADDRESSES.wallet1),
        historyRead("devnet", destinationTokenAccount),
      ]);
      expect(body.meta.total).toBe(1);
      expect(body.data).toEqual([
        expect.objectContaining({
          amount: "25",
          direction: "inbound",
          signature: observedSig,
          status: "confirmed",
          token: customMint,
        }),
      ]);
    });

    it("surfaces observed token mints into owned token accounts", async () => {
      const observedSig = syntheticSignature(26);
      const customMint = syntheticAddress(26);
      const destinationTokenAccount = syntheticAddress(27);
      const mintAuthority = syntheticAddress(28);
      rpc.answer(
        "getTransaction",
        parsedTransactionResult({
          signature: observedSig,
          slot: 103,
          blockTime: 1700000300,
          accountKeys: [mintAuthority, customMint, destinationTokenAccount],
          instructions: [
            parsedMintTo({
              mint: customMint,
              account: destinationTokenAccount,
              mintAuthority,
              amount: "500000000",
            }),
          ],
          innerInstructions: [],
          preTokenBalances: [],
          postTokenBalances: [
            parsedTokenBalance({
              accountIndex: 2,
              mint: customMint,
              owner: TEST_SOLANA_ADDRESSES.wallet1,
              tokenAmount: { amount: "500000000", decimals: 6, uiAmountString: "500" },
            }),
          ],
        })
      );

      respondOwnedTokenAccounts([
        {
          pubkey: destinationTokenAccount,
          mint: customMint,
          amount: "500000000",
          decimals: 6,
          uiAmountString: "500",
          state: "initialized",
        },
      ]);
      respondSignatureHistory(
        new Map([
          [TEST_SOLANA_ADDRESSES.wallet1, []],
          [
            destinationTokenAccount,
            [confirmedHistoryEntry({ signature: observedSig, slot: 103, blockTime: 1700000300 })],
          ],
        ])
      );

      const body = await listObservedTransfers(TEST_CUSTODY_WALLET_ID);

      expect(body.meta.total).toBe(1);
      expect(body.data).toEqual([
        expect.objectContaining({
          amount: "500",
          destination: TEST_SOLANA_ADDRESSES.wallet1,
          direction: "inbound",
          signature: observedSig,
          source: mintAuthority,
          status: "confirmed",
          token: customMint,
        }),
      ]);
    });

    it("reads a Sandbox wallet's observed history on devnet only", async () => {
      const observedSig = answerObservedSolDeposit(TEST_SOLANA_ADDRESSES.wallet1, []);

      const body = await listObservedTransfers(TEST_CUSTODY_WALLET_ID);

      expect(body.data.map((row) => ({ signature: row.signature, amount: row.amount }))).toEqual([
        { signature: observedSig, amount: "0.002" },
      ]);
      expect(rpc.calls).toContainEqual({ cluster: "devnet", method: "getSignaturesForAddress" });
      expect(rpc.calls).toContainEqual({ cluster: "devnet", method: "getTransaction" });
      expect(rpc.calls.filter((call) => call.cluster === "mainnet-beta")).toEqual([]);
    });

    it("reads a Production wallet's observed history on mainnet-beta only", async () => {
      await seedProductionPrivyWallet({
        custodyWalletId: "cwlt_observed_production",
        publicKey: TEST_SOLANA_ADDRESSES.wallet3,
      });
      const productionTokenAccount = syntheticAddress(31);
      const observedSig = answerObservedSolDeposit(TEST_SOLANA_ADDRESSES.wallet3, [
        {
          pubkey: productionTokenAccount,
          mint: WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].address,
          amount: "0",
          decimals: 6,
          uiAmountString: "0",
          state: "initialized",
        },
      ]);

      const body = await listObservedTransfers("cwlt_observed_production");

      expect(body.data.map((row) => ({ signature: row.signature, amount: row.amount }))).toEqual([
        { signature: observedSig, amount: "0.002" },
      ]);
      expect(rpc.calls).toContainEqual({
        cluster: "mainnet-beta",
        method: "getTokenAccountsByOwner",
      });
      expect(signatureHistoryReads()).toEqual([
        historyRead("mainnet-beta", TEST_SOLANA_ADDRESSES.wallet3),
        historyRead("mainnet-beta", productionTokenAccount),
      ]);
      expect(rpc.calls).toContainEqual({ cluster: "mainnet-beta", method: "getTransaction" });
      expect(rpc.calls.filter((call) => call.cluster === "devnet")).toEqual([]);
    });

    it("withholds a batch chunk's signed transaction bytes, keeping its signature", async () => {
      await seedTransfer({ id: "xfr_bytes_plain", status: "confirmed", signature: "sig_plain" });
      await seedTransfer({
        id: "xfr_bytes_batch",
        status: "confirmed",
        type: "transfer_batch",
        signature: "sig_batch",
      });
      await getDb(env)
        .prepare("UPDATE payment_transfers SET serialized_tx = ? WHERE id IN (?, ?)")
        .bind("AQID", "xfr_bytes_plain", "xfr_bytes_batch")
        .run();

      const res = await app.request(
        "/v1/payments/transfers",
        { method: "GET", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );

      expect(res.status).toBe(200);
      const body = z
        .object({
          data: z.array(
            z.object({
              id: z.string(),
              signature: z.string().nullable(),
              serializedTx: z.string().nullable(),
            })
          ),
        })
        .parse(await res.json());
      const byId = new Map(body.data.map((transfer) => [transfer.id, transfer]));
      expect(byId.get("xfr_bytes_batch")).toMatchObject({
        signature: "sig_batch",
        serializedTx: null,
      });
      expect(byId.get("xfr_bytes_plain")).toMatchObject({ serializedTx: "AQID" });
    });

    it("scopes a wallet's ledger history to rows of that wallet, not of its address, without reading the chain", async () => {
      await seedTransfer({
        id: "xfr_wallet_outbound",
        status: "confirmed",
        source: TEST_SOLANA_ADDRESSES.wallet1,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
      });
      await seedTransfer({
        id: "xfr_wallet_inbound",
        status: "confirmed",
        source: TEST_SOLANA_ADDRESSES.wallet2,
        destination: TEST_SOLANA_ADDRESSES.wallet1,
        direction: "inbound",
      });
      // Same address as the wallet, recorded against no SDP wallet.
      await seedTransfer({
        id: "xfr_same_address_other_wallet",
        status: "confirmed",
        custodyWalletId: null,
        walletId: "wal_payments_other",
        source: TEST_SOLANA_ADDRESSES.wallet1,
        destination: TEST_SOLANA_ADDRESSES.wallet3,
      });

      const res = await app.request(
        `/v1/payments/transfers?custodyWalletId=${TEST_CUSTODY_WALLET_ID}&includeObserved=false`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ id: string }>;
        meta: { total: number };
      };
      expect(body.data.map((transfer) => transfer.id).sort()).toEqual([
        "xfr_wallet_inbound",
        "xfr_wallet_outbound",
      ]);
      expect(body.meta.total).toBe(2);
      expect(rpc.calls).toEqual([]);
    });

    it("finds a ramp transfer by its provider reference from the ledger alone, still honoring the other filters", async () => {
      await seedTransfer({
        id: "xfr_reference_match",
        status: "completed",
        type: "offramp",
        provider: "moonpay",
        providerReference: "exact-reference-42",
      });
      await seedTransfer({
        id: "xfr_reference_other",
        status: "completed",
        type: "offramp",
        provider: "moonpay",
        providerReference: "exact-reference-43",
      });
      const listIds = async (query: Record<string, string>) => {
        const res = await app.request(
          `/v1/payments/transfers?${new URLSearchParams(query)}`,
          { method: "GET", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
          env
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { data: Array<{ id: string }> };
        return body.data.map((transfer) => transfer.id);
      };
      const lookup = {
        provider: "moonpay",
        providerReference: "exact-reference-42",
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
        includeObserved: "true",
      };

      expect(await listIds(lookup)).toEqual(["xfr_reference_match"]);
      expect(await listIds({ ...lookup, status: "failed" })).toEqual([]);
      expect(rpc.calls).toEqual([]);
    });

    it("refuses a provider reference without its provider", async () => {
      const res = await app.request(
        "/v1/payments/transfers?providerReference=exact-reference-42",
        { method: "GET", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: {
          code: "BAD_REQUEST",
          message: "provider is required for provider reference lookup",
        },
      });
    });

    it("filters by multiple statuses when status query param is comma-separated", async () => {
      await seedTransfer({
        id: "xfr_multi_completed",
        status: "completed",
        type: "offramp",
        provider: "moonpay",
        providerReference: "provider_multi_completed",
        custodyWalletId: null,
      });
      await seedTransfer({ id: "xfr_multi_confirmed", status: "confirmed" });
      await seedTransfer({ id: "xfr_multi_pending", status: "pending" });

      const res = await app.request(
        "/v1/payments/transfers?status=completed,confirmed,finalized",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ id: string; status: string }>;
        meta: { total: number };
      };
      expect(body.data.map((transfer) => transfer.id).sort()).toEqual([
        "xfr_multi_completed",
        "xfr_multi_confirmed",
      ]);
      expect(body.meta.total).toBe(2);
    });

    it("composes search, type, provider, and stable database pagination", async () => {
      const counterpartyId = await seedCounterparty({ id: "cpty_searchable" });
      await seedTransfer({
        id: "xfr_search_old",
        status: "completed",
        counterpartyId,
        type: "offramp",
        provider: "moonpay",
        providerReference: "merchant-reference-42",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      await seedTransfer({
        id: "xfr_search_new",
        status: "completed",
        counterpartyId,
        type: "offramp",
        provider: "moonpay",
        providerReference: "merchant-reference-43",
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      await seedTransfer({
        id: "xfr_wrong_provider",
        status: "completed",
        counterpartyId,
        type: "offramp",
        provider: "stripe",
      });

      const query = new URLSearchParams({
        search: "MoonPay Test Counterparty",
        type: "offramp",
        provider: "moonpay",
        status: "completed",
        sortBy: "createdAt",
        sortDirection: "asc",
        page: "2",
        pageSize: "1",
      });
      const res = await app.request(
        `/v1/payments/transfers?${query}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ custodyWalletId: string | null; id: string; providerWalletId: string }>;
        meta: { total: number; page: number; pageSize: number; hasMore: boolean };
      };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        id: "xfr_search_new",
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
        providerWalletId: TEST_WALLET_ID,
        counterpartyId,
        counterpartyDisplayName: "MoonPay Test Counterparty",
      });
      expect(body.meta).toMatchObject({ total: 2, page: 2, pageSize: 1, hasMore: false });
    });

    it("applies search, date filters, and amount sorting to ledger and on-chain rows alike", async () => {
      const counterpartyId = await seedCounterparty({ id: "cpty_observed_search" });
      const matchingLowSignature = syntheticSignature(40);
      const matchingHighSignature = syntheticSignature(41);
      const outsideDateSignature = syntheticSignature(42);
      const otherCounterpartySignature = syntheticSignature(43);

      await seedTransfer({
        id: "xfr_observed_filter_low",
        status: "confirmed",
        signature: matchingLowSignature,
        counterpartyId,
        amount: "2",
        createdAt: "2026-01-02T16:00:00.000Z",
      });
      await seedTransfer({
        id: "xfr_observed_filter_high",
        status: "confirmed",
        signature: matchingHighSignature,
        counterpartyId,
        amount: "20",
        createdAt: "2026-01-03T00:00:00.000Z",
      });
      await seedTransfer({
        id: "xfr_observed_filter_outside_date",
        status: "confirmed",
        signature: outsideDateSignature,
        counterpartyId,
        amount: "1",
        createdAt: "2025-12-31T23:59:59.000Z",
      });
      await seedTransfer({
        id: "xfr_observed_filter_other_counterparty",
        status: "confirmed",
        signature: otherCounterpartySignature,
        amount: "0.5",
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      // An on-chain deposit with no ledger row, inside the date window but not the search.
      const unrecordedDepositSignature = syntheticSignature(44);
      answerSolDepositTransaction({
        signature: unrecordedDepositSignature,
        walletAddress: TEST_SOLANA_ADDRESSES.wallet1,
        slot: 210,
        // 2026-01-03T00:00:00Z
        blockTime: 1_767_398_400,
      });
      respondSignatureHistory(
        new Map([
          [
            TEST_SOLANA_ADDRESSES.wallet1,
            [
              ...[
                matchingLowSignature,
                matchingHighSignature,
                outsideDateSignature,
                otherCounterpartySignature,
              ].map((signature, index) =>
                confirmedHistoryEntry({
                  signature,
                  slot: 200 + index,
                  blockTime: 1_767_225_600 + index,
                })
              ),
              confirmedHistoryEntry({
                signature: unrecordedDepositSignature,
                slot: 210,
                blockTime: 1_767_398_400,
              }),
            ],
          ],
        ])
      );

      const query = new URLSearchParams({
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
        includeObserved: "true",
        search: "moonpay test",
        from: "2026-01-02T20:00:00+05:00",
        to: "2026-01-03T19:00:00-05:00",
        sortBy: "amount",
        sortDirection: "asc",
      });
      const res = await app.request(
        `/v1/payments/transfers?${query}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ amount: string; counterpartyDisplayName?: string; id: string }>;
        meta: { total: number };
      };
      expect(body.data).toEqual([
        expect.objectContaining({
          id: "xfr_observed_filter_low",
          amount: "2",
          counterpartyDisplayName: "MoonPay Test Counterparty",
        }),
        expect.objectContaining({
          id: "xfr_observed_filter_high",
          amount: "20",
          counterpartyDisplayName: "MoonPay Test Counterparty",
        }),
      ]);
      expect(body.meta.total).toBe(2);
    });

    it("keeps exact persisted history readable after the wallet becomes inactive", async () => {
      await seedTransfer({ id: "xfr_inactive_wallet_history", status: "confirmed" });
      await getDb(env)
        .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE id = ?")
        .bind(TEST_CUSTODY_WALLET_ID)
        .run();

      const res = await app.request(
        `/v1/payments/transfers?custodyWalletId=${TEST_CUSTODY_WALLET_ID}&includeObserved=false`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string }> };
      expect(body.data.map((transfer) => transfer.id)).toEqual(["xfr_inactive_wallet_history"]);
      expect(rpc.calls).toEqual([]);
    });

    it("returns bad request for invalid transfer status query param", async () => {
      const res = await app.request(
        "/v1/payments/transfers?status=settled",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; message: string; details?: { errors?: Record<string, string[]> } };
      };
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toContain("Invalid query parameters");
    });

    it("allows blank searches but rejects searches shorter than three characters", async () => {
      await seedTransfer({ id: "xfr_search_contract", status: "confirmed" });

      const blankRes = await app.request(
        "/v1/payments/transfers?search=%20%20%20&includeObserved=false",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );
      expect(blankRes.status).toBe(200);
      const blankBody = (await blankRes.json()) as { data: Array<{ id: string }> };
      expect(blankBody.data.map((transfer) => transfer.id)).toEqual(["xfr_search_contract"]);

      const shortRes = await app.request(
        "/v1/payments/transfers?search=xy&includeObserved=false",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );
      expect(shortRes.status).toBe(400);
      const shortBody = (await shortRes.json()) as {
        error: { code: string; message: string };
      };
      expect(shortBody.error.code).toBe("BAD_REQUEST");
      expect(shortBody.error.message).toContain("Invalid query parameters");
    });

    it("returns a single transfer by ID", async () => {
      await seedTransfer({ id: "xfr_single_1", status: "confirmed" });

      const res = await app.request(
        "/v1/payments/transfers/xfr_single_1",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { transfer: Record<string, unknown> };
      };
      expect(body.data.transfer).toEqual({
        id: "xfr_single_1",
        organizationId: TEST_ORG.id,
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
        providerWalletId: TEST_WALLET_ID,
        projectId: TEST_PROJECT.id,
        type: "transfer",
        kind: "pay",
        direction: "outbound",
        status: "confirmed",
        signature: null,
        serializedTx: null,
        slot: null,
        blockTime: null,
        fee: null,
        error: null,
        source: TEST_SOLANA_ADDRESSES.wallet1,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        rampsMemo: {},
        token: "SOL",
        amount: "1",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
    });

    it("does not disclose another project's transfer by id", async () => {
      await seedProjectApiKey(getDb(env), env, {
        key: TEST_PRODUCTION_API_KEY,
        organizationId: TEST_ORG.id,
        projectId: TEST_PRODUCTION_PROJECT_ID,
        createdBy: TEST_USER.id,
        grants: ["transfers.read"],
      });
      await seedTransfer({ id: "xfr_sandbox_owned", status: "confirmed" });

      const res = await app.request(
        "/v1/payments/transfers/xfr_sandbox_owned",
        { headers: { Authorization: `Bearer ${TEST_PRODUCTION_API_KEY.raw}` } },
        env
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({
        error: { code: "NOT_FOUND", message: "Transfer not found" },
      });
    });
  });
});
