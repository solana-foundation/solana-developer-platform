import { formatDecimalAmount } from "@sdp/solana/amount";
import { type RampProviderId, SOL_MINT, SUCCESSFUL_PAYMENT_TRANSFER_STATUSES } from "@sdp/types";
import type { Signature } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import app from "@/index";
import { TEST_PRODUCTION_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
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
  seedCachedKey,
  seedCounterparty,
  seedProductionPrivyWallet,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_KORA_FEE_PAYER,
  TEST_ORG,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import { seedRateLimit } from "@/test/mocks/kv";

const observedTransfersResponseSchema = z.object({
  data: z.array(z.object({ signature: z.string().nullable(), amount: z.string() })),
});

describe("Payments routes — list transfers", () => {
  installPaymentsRouteTestHooks();
  const rpc = installClusterRpcStub();

  function answerObservedSolDeposit(walletAddress: string): Signature {
    const observedSig = syntheticSignature(30);
    getSignaturesForAddressMock.mockReset();
    rpc.answer("getSignaturesForAddress", [
      {
        signature: observedSig,
        slot: 104,
        err: null,
        memo: null,
        blockTime: 1700000400,
        confirmationStatus: "confirmed",
      },
    ]);
    rpc.answer(
      "getTransaction",
      parsedTransactionResult({
        signature: observedSig,
        slot: 104,
        blockTime: 1700000400,
        accountKeys: [TEST_SOLANA_ADDRESSES.wallet2, walletAddress],
        instructions: [
          parsedSystemTransfer({
            source: TEST_SOLANA_ADDRESSES.wallet2,
            destination: walletAddress,
            lamports: 2_000_000,
          }),
        ],
        preTokenBalances: [],
        postTokenBalances: [],
      })
    );
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

  beforeEach(async () => {
    await seedProjectApiKey(getDb(env), env, {
      key: TEST_PRODUCTION_API_KEY,
      organizationId: TEST_ORG.id,
      projectId: `${TEST_PROJECT.id}_production`,
      createdBy: TEST_USER.id,
      role: "api_admin",
      permissions: ["payments:read"],
    });
  });

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
      vi.clearAllMocks();
    });

    it("matches a token filter against every form the ledger stores it in", async () => {
      const solMint = "So11111111111111111111111111111111111111112";
      await seedTransfer({ id: "xfr_tok_sym_1", status: "confirmed", token: "SOL" });
      await seedTransfer({ id: "xfr_tok_sym_2", status: "confirmed", token: "SOL" });
      await seedTransfer({ id: "xfr_tok_mint_1", status: "confirmed", token: solMint });

      for (const spelling of ["SOL", solMint]) {
        const res = await app.request(
          `/v1/payments/transfers?token=${encodeURIComponent(spelling)}`,
          { method: "GET", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
          env
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as { data: Array<{ id: string }> };
        expect(body.data.map((row) => row.id).sort()).toEqual([
          "xfr_tok_mint_1",
          "xfr_tok_sym_1",
          "xfr_tok_sym_2",
        ]);
      }
    });

    it("does not widen a token filter to an unrelated asset", async () => {
      await seedTransfer({ id: "xfr_tok_sol", status: "confirmed", token: "SOL" });
      await seedTransfer({ id: "xfr_tok_usdc", status: "confirmed", token: "USDC" });

      const res = await app.request(
        "/v1/payments/transfers?token=SOL",
        { method: "GET", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string }> };
      expect(body.data.map((row) => row.id)).toEqual(["xfr_tok_sol"]);
    });

    it("returns confirmed + pending transfers when wallet filter is provided", async () => {
      const confirmedSig =
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy";

      await seedTransfer({ id: "xfr_confirmed_1", status: "confirmed", signature: confirmedSig });
      await seedTransfer({ id: "xfr_pending_1", status: "pending" });

      getSignaturesForAddressMock.mockResolvedValueOnce([
        {
          signature: confirmedSig as unknown as Signature,
          slot: 100n,
          blockTime: 1700000000n,
          err: null,
        },
      ]);

      const res = await app.request(
        `/v1/payments/transfers?custodyWalletId=${TEST_CUSTODY_WALLET_ID}&includeObserved=true`,
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
      expect(body.meta.total).toBe(2);
      expect(body.data).toHaveLength(2);
      const statuses = body.data.map((t) => t.status).sort();
      expect(statuses).toEqual(["confirmed", "pending"]);
    });

    it("keeps older exact ledger rows when observed history has no matching signature", async () => {
      await seedTransfer({
        id: "xfr_exact_older_than_observed_window",
        status: "finalized",
        signature: "older-exact-signature",
      });
      getSignaturesForAddressMock.mockResolvedValueOnce([]);

      const res = await app.request(
        `/v1/payments/transfers?custodyWalletId=${TEST_CUSTODY_WALLET_ID}&includeObserved=true`,
        { method: "GET", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ id: string }>;
        meta: { total: number };
      };
      expect(body.data.map((transfer) => transfer.id)).toEqual([
        "xfr_exact_older_than_observed_window",
      ]);
      expect(body.meta.total).toBe(1);
    });

    it("rejects the removed walletAddress selector without pulling on-chain history", async () => {
      await seedTransfer({ id: "xfr_db_only_1", status: "pending" });

      const res = await app.request(
        `/v1/payments/transfers?walletAddress=${TEST_SOLANA_ADDRESSES.wallet3}`,
        { method: "GET", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );

      expect(res.status).toBe(400);
      expect(getSignaturesForAddressMock).not.toHaveBeenCalled();
    });

    it("pulls on-chain history only for an exact wallet with explicit opt-in", async () => {
      const res = await app.request(
        `/v1/payments/transfers?custodyWalletId=${TEST_CUSTODY_WALLET_ID}&includeObserved=true`,
        { method: "GET", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );

      expect(res.status).toBe(200);
      expect(getSignaturesForAddressMock).toHaveBeenCalled();
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
      expect(getSignaturesForAddressMock).not.toHaveBeenCalled();
    });

    it("surfaces observed inbound transfers for wallet history even without a DB record", async () => {
      const observedSig = syntheticSignature(21);
      const sourceTokenAccount = syntheticAddress(21);
      const destinationTokenAccount = syntheticAddress(22);
      const usdcBalance = (accountIndex: number, owner: string, amount: string) =>
        parsedTokenBalance({
          accountIndex,
          mint: DEVNET_USDC_MINT,
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
          slot: 101,
          blockTime: 1700000100,
          accountKeys: [sourceTokenAccount, destinationTokenAccount],
          instructions: [
            parsedTransferChecked({
              source: sourceTokenAccount,
              destination: destinationTokenAccount,
              mint: DEVNET_USDC_MINT,
              authority: TEST_SOLANA_ADDRESSES.wallet2,
              tokenAmount: { amount: "10000000", decimals: 6, uiAmountString: "10" },
            }),
          ],
          preTokenBalances: [
            usdcBalance(0, TEST_SOLANA_ADDRESSES.wallet2, "10000000"),
            usdcBalance(1, TEST_SOLANA_ADDRESSES.wallet1, "0"),
          ],
          postTokenBalances: [
            usdcBalance(0, TEST_SOLANA_ADDRESSES.wallet2, "0"),
            usdcBalance(1, TEST_SOLANA_ADDRESSES.wallet1, "10000000"),
          ],
        })
      );

      getSignaturesForAddressMock.mockResolvedValueOnce([
        {
          signature: observedSig,
          slot: 101n,
          blockTime: 1700000100n,
          err: null,
        },
      ]);

      const res = await app.request(
        `/v1/payments/transfers?custodyWalletId=${TEST_CUSTODY_WALLET_ID}&includeObserved=true`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{
          id: string;
          amount: string;
          direction: string;
          signature: string | null;
          status: string;
          token: string;
        }>;
        meta: { total: number };
      };
      expect(body.meta.total).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        amount: "10",
        direction: "inbound",
        signature: observedSig,
        status: "confirmed",
        token: DEVNET_USDC_MINT,
      });
      expect(body.data[0]?.id).toMatch(/^xfr_observed_/);
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
          accountKeys: [sourceTokenAccount, destinationTokenAccount],
          instructions: [
            parsedTransferChecked({
              source: sourceTokenAccount,
              destination: destinationTokenAccount,
              mint: customMint,
              authority: TEST_SOLANA_ADDRESSES.wallet2,
              tokenAmount: { amount: "25000000", decimals: 6, uiAmountString: "25" },
            }),
          ],
          preTokenBalances: [
            customBalance(0, TEST_SOLANA_ADDRESSES.wallet2, "25000000"),
            customBalance(1, TEST_SOLANA_ADDRESSES.wallet1, "0"),
          ],
          postTokenBalances: [
            customBalance(0, TEST_SOLANA_ADDRESSES.wallet2, "0"),
            customBalance(1, TEST_SOLANA_ADDRESSES.wallet1, "25000000"),
          ],
        })
      );

      getSplTokenAccountAddressesMock.mockResolvedValueOnce([destinationTokenAccount]);
      getSignaturesForAddressMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          signature: observedSig,
          slot: 102n,
          blockTime: 1700000200n,
          err: null,
        },
      ]);

      const res = await app.request(
        `/v1/payments/transfers?custodyWalletId=${TEST_CUSTODY_WALLET_ID}&includeObserved=true`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      expect(getSignaturesForAddressMock).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        TEST_SOLANA_ADDRESSES.wallet1,
        expect.objectContaining({ commitment: "confirmed" })
      );
      expect(getSignaturesForAddressMock).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        destinationTokenAccount,
        expect.objectContaining({ commitment: "confirmed" })
      );

      const body = (await res.json()) as {
        data: Array<{
          amount: string;
          direction: string;
          signature: string | null;
          status: string;
          token: string;
        }>;
        meta: { total: number };
      };
      expect(body.meta.total).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        amount: "25",
        direction: "inbound",
        signature: observedSig,
        status: "confirmed",
        token: customMint,
      });
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

      getSplTokenAccountAddressesMock.mockResolvedValueOnce([destinationTokenAccount]);
      getSignaturesForAddressMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          signature: observedSig,
          slot: 103n,
          blockTime: 1700000300n,
          err: null,
        },
      ]);

      const res = await app.request(
        `/v1/payments/transfers?custodyWalletId=${TEST_CUSTODY_WALLET_ID}&includeObserved=true`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{
          amount: string;
          destination: string;
          direction: string;
          signature: string | null;
          source: string;
          status: string;
          token: string;
        }>;
        meta: { total: number };
      };
      expect(body.meta.total).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        amount: "500",
        destination: TEST_SOLANA_ADDRESSES.wallet1,
        direction: "inbound",
        signature: observedSig,
        source: mintAuthority,
        status: "confirmed",
        token: customMint,
      });
    });

    it("reads a Sandbox wallet's observed history on devnet only", async () => {
      const observedSig = answerObservedSolDeposit(TEST_SOLANA_ADDRESSES.wallet1);

      const body = await listObservedTransfers(TEST_CUSTODY_WALLET_ID);

      expect(body.data.map((row) => ({ signature: row.signature, amount: row.amount }))).toEqual([
        { signature: observedSig, amount: formatDecimalAmount(2_000_000n, 9) },
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
      const observedSig = answerObservedSolDeposit(TEST_SOLANA_ADDRESSES.wallet3);

      const body = await listObservedTransfers("cwlt_observed_production");

      expect(body.data.map((row) => ({ signature: row.signature, amount: row.amount }))).toEqual([
        { signature: observedSig, amount: formatDecimalAmount(2_000_000n, 9) },
      ]);
      expect(rpc.calls).toContainEqual({
        cluster: "mainnet-beta",
        method: "getSignaturesForAddress",
      });
      expect(rpc.calls).toContainEqual({ cluster: "mainnet-beta", method: "getTransaction" });
      expect(rpc.calls.filter((call) => call.cluster === "devnet")).toEqual([]);
    });

    it("returns all transfers via DB-only path when no wallet filter is provided", async () => {
      await seedTransfer({ id: "xfr_db_1", status: "confirmed" });
      await seedTransfer({ id: "xfr_db_2", status: "pending" });
      await seedTransfer({ id: "xfr_db_3", status: "failed" });

      const res = await app.request(
        "/v1/payments/transfers",
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
      expect(body.data).toHaveLength(3);
      expect(body.meta.total).toBe(3);
      expect(getSignaturesForAddressMock).not.toHaveBeenCalled();
    });

    it("scopes database-backed history to the exact wallet row", async () => {
      await seedTransfer({
        id: "xfr_address_resolved_outbound",
        status: "confirmed",
        source: TEST_SOLANA_ADDRESSES.wallet1,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
      });
      await seedTransfer({
        id: "xfr_address_resolved_inbound",
        status: "confirmed",
        source: TEST_SOLANA_ADDRESSES.wallet2,
        destination: TEST_SOLANA_ADDRESSES.wallet1,
        direction: "inbound",
      });
      await seedTransfer({
        id: "xfr_address_other_wallet",
        status: "confirmed",
        custodyWalletId: null,
        walletId: "wal_payments_other",
        source: TEST_SOLANA_ADDRESSES.wallet2,
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
        "xfr_address_resolved_inbound",
        "xfr_address_resolved_outbound",
      ]);
      expect(body.meta.total).toBe(2);
      expect(getSignaturesForAddressMock).not.toHaveBeenCalled();
    });

    it("does not infer exact ownership from matching ledger addresses", async () => {
      await seedTransfer({
        id: "xfr_address_external_outbound",
        status: "confirmed",
        custodyWalletId: null,
        walletId: "wal_external_outbound",
        source: TEST_SOLANA_ADDRESSES.wallet2,
        destination: TEST_SOLANA_ADDRESSES.wallet3,
      });
      await seedTransfer({
        id: "xfr_address_external_inbound",
        status: "confirmed",
        custodyWalletId: null,
        walletId: "wal_external_inbound",
        source: TEST_SOLANA_ADDRESSES.wallet3,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        direction: "inbound",
      });
      await seedTransfer({
        id: "xfr_address_external_unrelated",
        status: "confirmed",
        custodyWalletId: null,
        walletId: "wal_external_unrelated",
        source: TEST_SOLANA_ADDRESSES.wallet3,
        destination: TEST_KORA_FEE_PAYER,
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
      expect(body.data).toEqual([]);
      expect(body.meta.total).toBe(0);
    });

    it("enforces payments:read wallet grants for database-backed transfer lists", async () => {
      const writeOnlyCustodyWalletId = "cwlt_payments_write_only";
      await getDb(env)
        .prepare(
          `INSERT INTO custody_wallets
             (id, custody_config_id, wallet_id, public_key, label, purpose, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          writeOnlyCustodyWalletId,
          "cust_cfg_payments_test",
          "wal_payments_write_only",
          TEST_SOLANA_ADDRESSES.wallet2,
          "Write-only wallet",
          "transfer",
          "active"
        )
        .run();
      await seedTransfer({ id: "xfr_wallet_readable", status: "confirmed" });
      await seedTransfer({
        id: "xfr_wallet_write_only",
        status: "confirmed",
        custodyWalletId: writeOnlyCustodyWalletId,
        walletId: "wal_payments_write_only",
      });
      await seedCachedKey({
        walletBindings: [
          {
            walletId: TEST_WALLET_ID,
            custodyWalletId: TEST_CUSTODY_WALLET_ID,
            permissions: ["payments:read"],
          },
          {
            walletId: "wal_payments_write_only",
            custodyWalletId: writeOnlyCustodyWalletId,
            permissions: ["payments:write"],
          },
        ],
      });

      const listRes = await app.request(
        "/v1/payments/transfers?includeObserved=false",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as { data: Array<{ id: string }> };
      expect(listBody.data.map((transfer) => transfer.id)).toEqual(["xfr_wallet_readable"]);

      const forbiddenRes = await app.request(
        `/v1/payments/transfers?custodyWalletId=${writeOnlyCustodyWalletId}&includeObserved=false`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );
      expect(forbiddenRes.status).toBe(403);
    });

    it("keeps authorized legacy null-pin transfers visible to selected keys", async () => {
      await seedTransfer({
        id: "xfr_legacy_authorized",
        status: "confirmed",
        custodyWalletId: null,
        walletId: TEST_WALLET_ID,
      });
      await seedTransfer({
        id: "xfr_legacy_unauthorized",
        status: "confirmed",
        custodyWalletId: null,
        walletId: "wal_legacy_unauthorized",
      });
      await seedCachedKey({
        walletBindings: [
          {
            walletId: TEST_WALLET_ID,
            custodyWalletId: TEST_CUSTODY_WALLET_ID,
            permissions: ["payments:read"],
          },
        ],
      });

      const response = await app.request(
        "/v1/payments/transfers?includeObserved=false",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: Array<{ id: string }> };
      expect(body.data.map((transfer) => transfer.id)).toEqual(["xfr_legacy_authorized"]);
    });

    it("returns no rows when selected wallets grant no payments:read access", async () => {
      await seedTransfer({ id: "xfr_wallet_not_readable", status: "confirmed" });
      await seedCachedKey({
        walletBindings: [
          {
            walletId: TEST_WALLET_ID,
            custodyWalletId: TEST_CUSTODY_WALLET_ID,
            permissions: ["payments:write"],
          },
        ],
      });

      const res = await app.request(
        "/v1/payments/transfers?includeObserved=false",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[]; meta: { total: number } };
      expect(body.data).toEqual([]);
      expect(body.meta.total).toBe(0);
    });

    it("enforces payments:read on exact provider-reference lookups", async () => {
      await seedTransfer({
        id: "xfr_provider_reference_private",
        status: "completed",
        type: "offramp",
        provider: "moonpay",
        providerReference: "private-provider-reference",
      });
      await seedCachedKey({
        walletBindings: [
          {
            walletId: TEST_WALLET_ID,
            custodyWalletId: TEST_CUSTODY_WALLET_ID,
            permissions: ["payments:write"],
          },
        ],
      });

      const res = await app.request(
        "/v1/payments/transfers?provider=moonpay&providerReference=private-provider-reference",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.message).toContain("requested wallet");
    });

    it("composes exact provider-reference lookups with every ledger filter and pagination", async () => {
      const counterpartyId = await seedCounterparty({ id: "cpty_exact_reference" });
      await seedTransfer({
        id: "xfr_exact_reference_match",
        status: "completed",
        counterpartyId,
        source: TEST_SOLANA_ADDRESSES.wallet1,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: DEVNET_USDC_MINT,
        memo: "Quarterly invoice",
        type: "offramp",
        direction: "outbound",
        provider: "moonpay",
        providerReference: "exact-reference-42",
        createdAt: "2026-01-02T12:00:00.000Z",
      });

      const matchingQuery = new URLSearchParams({
        provider: "moonpay",
        providerReference: "exact-reference-42",
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
        search: "quarterly",
        status: "completed",
        category: "ramp",
        type: "offramp",
        counterpartyId,
        token: "USDC",
        direction: "outbound",
        from: "2026-01-02T16:00:00+05:00",
        to: "2026-01-02T08:00:00-05:00",
        sortBy: "amount",
        sortDirection: "asc",
        pageSize: "1",
      });

      const firstPageRes = await app.request(
        `/v1/payments/transfers?${matchingQuery}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );
      expect(firstPageRes.status).toBe(200);
      const firstPage = (await firstPageRes.json()) as {
        data: Array<{ id: string }>;
        meta: { page: number; pageSize: number; total: number };
      };
      expect(firstPage.data.map((transfer) => transfer.id)).toEqual(["xfr_exact_reference_match"]);
      expect(firstPage.meta).toMatchObject({ page: 1, pageSize: 1, total: 1 });

      matchingQuery.set("page", "2");
      const secondPageRes = await app.request(
        `/v1/payments/transfers?${matchingQuery}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );
      expect(secondPageRes.status).toBe(200);
      const secondPage = (await secondPageRes.json()) as {
        data: unknown[];
        meta: { hasMore: boolean; page: number; total: number };
      };
      expect(secondPage.data).toEqual([]);
      expect(secondPage.meta).toMatchObject({ hasMore: false, page: 2, total: 1 });

      matchingQuery.set("page", "1");
      matchingQuery.set("status", "failed");
      const mismatchedFilterRes = await app.request(
        `/v1/payments/transfers?${matchingQuery}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );
      expect(mismatchedFilterRes.status).toBe(200);
      const mismatchedFilter = (await mismatchedFilterRes.json()) as {
        data: unknown[];
        meta: { total: number };
      };
      expect(mismatchedFilter.data).toEqual([]);
      expect(mismatchedFilter.meta.total).toBe(0);
      expect(getSignaturesForAddressMock).not.toHaveBeenCalled();
    });

    it("matches native SOL rows whether the token filter is SOL, sol, or the mint", async () => {
      await seedTransfer({ id: "xfr_native_sol", status: "confirmed", token: SOL_MINT });
      await seedTransfer({ id: "xfr_usdc", status: "confirmed", token: DEVNET_USDC_MINT });
      await seedTransfer({ id: "xfr_native_sol_pending", status: "pending", token: SOL_MINT });

      for (const filter of ["SOL", "sol", SOL_MINT]) {
        const res = await app.request(
          `/v1/payments/transfers?token=${filter}`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
          },
          env
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as { data: Array<{ id: string }> };
        expect(body.data.map((transfer) => transfer.id).sort()).toEqual([
          "xfr_native_sol",
          "xfr_native_sol_pending",
        ]);
        const walletRes = await app.request(
          `/v1/payments/transfers?custodyWalletId=${TEST_CUSTODY_WALLET_ID}&token=${filter}&includeObserved=true`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
          },
          env
        );

        expect(walletRes.status).toBe(200);
        const walletBody = (await walletRes.json()) as { data: Array<{ id: string }> };
        expect(walletBody.data.map((transfer) => transfer.id).sort()).toEqual([
          "xfr_native_sol",
          "xfr_native_sol_pending",
        ]);
      }

      for (const filter of ["USDC", "usdc", DEVNET_USDC_MINT]) {
        const res = await app.request(
          `/v1/payments/transfers?token=${filter}`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
          },
          env
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as { data: Array<{ id: string }> };
        expect(body.data.map((transfer) => transfer.id)).toEqual(["xfr_usdc"]);
      }
    });

    it("filters by status when status query param is provided", async () => {
      await seedTransfer({ id: "xfr_status_confirmed", status: "confirmed" });
      await seedTransfer({ id: "xfr_status_pending", status: "pending" });

      const res = await app.request(
        "/v1/payments/transfers?status=confirmed",
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
      expect(body.data).toHaveLength(1);
      expect(body.data[0]?.status).toBe("confirmed");
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
      expect(body.data).toHaveLength(2);
      expect(body.data.map((transfer) => transfer.status).sort()).toEqual(
        SUCCESSFUL_PAYMENT_TRANSFER_STATUSES.filter((status) => status !== "finalized").sort()
      );
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

    it("applies search, date filters, and amount sorting to observed wallet history", async () => {
      const counterpartyId = await seedCounterparty({ id: "cpty_observed_search" });
      const matchingLowSignature = "observed-filter-match-low-signature";
      const matchingHighSignature = "observed-filter-match-high-signature";
      const outsideDateSignature = "observed-filter-outside-date-signature";
      const otherCounterpartySignature = "observed-filter-other-counterparty-signature";

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
      getSignaturesForAddressMock.mockResolvedValueOnce(
        [
          matchingLowSignature,
          matchingHighSignature,
          outsideDateSignature,
          otherCounterpartySignature,
        ].map((signature, index) => ({
          signature: signature as unknown as Signature,
          slot: BigInt(200 + index),
          blockTime: 1_767_225_600n + BigInt(index),
          err: null,
        }))
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

    it("uses database-backed pagination for wallet filters when observed history is disabled", async () => {
      await seedTransfer({ id: "xfr_wallet_recorded", status: "confirmed" });

      const res = await app.request(
        `/v1/payments/transfers?custodyWalletId=${TEST_CUSTODY_WALLET_ID}&includeObserved=false`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string }>; meta: { total: number } };
      expect(body.data.map((transfer) => transfer.id)).toEqual(["xfr_wallet_recorded"]);
      expect(body.meta.total).toBe(1);
      expect(getSignaturesForAddressMock).not.toHaveBeenCalled();
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
      expect(getSignaturesForAddressMock).not.toHaveBeenCalled();
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

    it("enforces payments:read when getting a transfer by ID", async () => {
      await seedTransfer({ id: "xfr_single_write_only", status: "confirmed" });
      await seedCachedKey({
        walletBindings: [
          {
            walletId: TEST_WALLET_ID,
            custodyWalletId: TEST_CUSTODY_WALLET_ID,
            permissions: ["payments:write"],
          },
        ],
      });

      const res = await app.request(
        "/v1/payments/transfers/xfr_single_write_only",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("returns 404 for another project's transfer", async () => {
      await seedTransfer({ id: "xfr_sandbox_owned", status: "confirmed" });
      const res = await app.request(
        "/v1/payments/transfers/xfr_sandbox_owned",
        {
          headers: { Authorization: `Bearer ${TEST_PRODUCTION_API_KEY.raw}` },
        },
        env
      );
      expect(res.status).toBe(404);
    });
  });
});
