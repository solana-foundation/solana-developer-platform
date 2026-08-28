import { SOL_MINT } from "@sdp/types";
import type { Address, Signature } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  DEVNET_USDC_MINT,
  getSignaturesForAddressMock,
  getSplTokenAccountAddressesMock,
  installPaymentsRouteTestHooks,
  seedCachedKey,
  seedCounterparty,
  TEST_API_KEY,
  TEST_KORA_FEE_PAYER,
  TEST_ORG,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import { seedRateLimit } from "@/test/mocks/kv";

describe("Payments routes — list transfers", () => {
  installPaymentsRouteTestHooks();

  async function seedTransfer(params: {
    id: string;
    status: string;
    signature?: string | null;
    walletId?: string;
    counterpartyId?: string | null;
    destination?: string;
    source?: string;
    token?: string;
    amount?: string;
    memo?: string | null;
    type?: "transfer" | "transfer_confidential" | "transfer_batch" | "onramp" | "offramp";
    direction?: "inbound" | "outbound";
    provider?: "moonpay" | "lightspark" | "bvnk" | "moneygram" | "coinbase" | "mural" | "stripe";
    providerReference?: string | null;
    createdAt?: string;
  }): Promise<void> {
    const now = params.createdAt ?? new Date().toISOString();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers
           (id, organization_id, project_id, wallet_id, counterparty_id, source_address, destination_address, token, amount, memo, type, direction, status, provider, provider_reference, signature, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        params.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
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
      // pt.token is written inconsistently: the same asset is a mint on some rows
      // and a bare symbol on others. An exact match returned 2 for the symbol and
      // 1 for the mint when the right answer was 3, so either spelling has to
      // answer with all of them. This is the HTTP hop over the repository fix.
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
        `/v1/payments/transfers?wallet=${TEST_WALLET_ID}`,
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

    it("does not pull on-chain history for a walletAddress the org does not own", async () => {
      await seedTransfer({ id: "xfr_db_only_1", status: "pending" });

      const res = await app.request(
        `/v1/payments/transfers?walletAddress=${TEST_SOLANA_ADDRESSES.wallet3}`,
        { method: "GET", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );

      expect(res.status).toBe(200);
      expect(getSignaturesForAddressMock).not.toHaveBeenCalled();
    });

    it("still pulls on-chain history for a tenant-owned walletAddress", async () => {
      const res = await app.request(
        `/v1/payments/transfers?walletAddress=${TEST_SOLANA_ADDRESSES.wallet1}`,
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
        `/v1/payments/transfers?wallet=${TEST_WALLET_ID}`,
        { method: "GET", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );

      expect(res.status).toBe(429);
      expect(getSignaturesForAddressMock).not.toHaveBeenCalled();
    });

    it("surfaces observed inbound transfers for wallet history even without a DB record", async () => {
      const observedSig =
        "3o9XWnJ7CyD6be8xXh8hFXRrM9rPzGQhE1mQ4Z8VjYkU7LZtP4R3WnV5uA2sD1fG6hJ7kL8mN9pQ1rS2tU3v";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              blockTime: 1700000100,
              slot: 101,
              meta: {
                err: null,
                fee: 5000,
                preTokenBalances: [
                  {
                    accountIndex: 0,
                    mint: DEVNET_USDC_MINT,
                    owner: TEST_SOLANA_ADDRESSES.wallet2,
                    uiTokenAmount: {
                      amount: "10000000",
                      decimals: 6,
                      uiAmountString: "10",
                    },
                  },
                  {
                    accountIndex: 1,
                    mint: DEVNET_USDC_MINT,
                    owner: TEST_SOLANA_ADDRESSES.wallet1,
                    uiTokenAmount: {
                      amount: "0",
                      decimals: 6,
                      uiAmountString: "0",
                    },
                  },
                ],
                postTokenBalances: [
                  {
                    accountIndex: 0,
                    mint: DEVNET_USDC_MINT,
                    owner: TEST_SOLANA_ADDRESSES.wallet2,
                    uiTokenAmount: {
                      amount: "0",
                      decimals: 6,
                      uiAmountString: "0",
                    },
                  },
                  {
                    accountIndex: 1,
                    mint: DEVNET_USDC_MINT,
                    owner: TEST_SOLANA_ADDRESSES.wallet1,
                    uiTokenAmount: {
                      amount: "10000000",
                      decimals: 6,
                      uiAmountString: "10",
                    },
                  },
                ],
              },
              transaction: {
                message: {
                  accountKeys: [
                    "SrcTokenAcct111111111111111111111111111111",
                    "DstTokenAcct111111111111111111111111111111",
                  ],
                  instructions: [
                    {
                      program: "spl-token",
                      parsed: {
                        type: "transferChecked",
                        info: {
                          source: "SrcTokenAcct111111111111111111111111111111",
                          destination: "DstTokenAcct111111111111111111111111111111",
                          mint: DEVNET_USDC_MINT,
                          tokenAmount: {
                            amount: "10000000",
                            decimals: 6,
                            uiAmountString: "10",
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      );

      getSignaturesForAddressMock.mockResolvedValueOnce([
        {
          signature: observedSig as unknown as Signature,
          slot: 101n,
          blockTime: 1700000100n,
          err: null,
        },
      ]);

      try {
        const res = await app.request(
          `/v1/payments/transfers?wallet=${TEST_WALLET_ID}`,
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
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("discovers observed custom token deposits from owned token account history", async () => {
      const observedSig =
        "5o9XWnJ7CyD6be8xXh8hFXRrM9rPzGQhE1mQ4Z8VjYkU7LZtP4R3WnV5uA2sD1fG6hJ7kL8mN9pQ1rS2tU3w";
      const customMint = "CustomMint1111111111111111111111111111111";
      const destinationTokenAccount = "DstTokenAcct111111111111111111111111111111";
      const sourceTokenAccount = "SrcTokenAcct111111111111111111111111111111";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              blockTime: 1700000200,
              slot: 102,
              meta: {
                err: null,
                fee: 5000,
                preTokenBalances: [
                  {
                    accountIndex: 0,
                    mint: customMint,
                    owner: TEST_SOLANA_ADDRESSES.wallet2,
                    uiTokenAmount: {
                      amount: "25000000",
                      decimals: 6,
                      uiAmountString: "25",
                    },
                  },
                  {
                    accountIndex: 1,
                    mint: customMint,
                    owner: TEST_SOLANA_ADDRESSES.wallet1,
                    uiTokenAmount: {
                      amount: "0",
                      decimals: 6,
                      uiAmountString: "0",
                    },
                  },
                ],
                postTokenBalances: [
                  {
                    accountIndex: 0,
                    mint: customMint,
                    owner: TEST_SOLANA_ADDRESSES.wallet2,
                    uiTokenAmount: {
                      amount: "0",
                      decimals: 6,
                      uiAmountString: "0",
                    },
                  },
                  {
                    accountIndex: 1,
                    mint: customMint,
                    owner: TEST_SOLANA_ADDRESSES.wallet1,
                    uiTokenAmount: {
                      amount: "25000000",
                      decimals: 6,
                      uiAmountString: "25",
                    },
                  },
                ],
              },
              transaction: {
                message: {
                  accountKeys: [sourceTokenAccount, destinationTokenAccount],
                  instructions: [
                    {
                      program: "spl-token",
                      parsed: {
                        type: "transferChecked",
                        info: {
                          source: sourceTokenAccount,
                          destination: destinationTokenAccount,
                          mint: customMint,
                          tokenAmount: {
                            amount: "25000000",
                            decimals: 6,
                            uiAmountString: "25",
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      );

      getSplTokenAccountAddressesMock.mockResolvedValueOnce([
        destinationTokenAccount as unknown as Address,
      ]);
      getSignaturesForAddressMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          signature: observedSig as unknown as Signature,
          slot: 102n,
          blockTime: 1700000200n,
          err: null,
        },
      ]);

      try {
        const res = await app.request(
          `/v1/payments/transfers?wallet=${TEST_WALLET_ID}`,
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
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("surfaces observed token mints into owned token accounts", async () => {
      const observedSig =
        "4o9XWnJ7CyD6be8xXh8hFXRrM9rPzGQhE1mQ4Z8VjYkU7LZtP4R3WnV5uA2sD1fG6hJ7kL8mN9pQ1rS2tU3m";
      const customMint = "MintedToken111111111111111111111111111111";
      const destinationTokenAccount = "MintDstTokenAcct11111111111111111111111111";
      const mintAuthority = "MintAuthority11111111111111111111111111111";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              blockTime: 1700000300,
              slot: 103,
              meta: {
                err: null,
                fee: 5000,
                preTokenBalances: [],
                postTokenBalances: [
                  {
                    accountIndex: 2,
                    mint: customMint,
                    owner: TEST_SOLANA_ADDRESSES.wallet1,
                    uiTokenAmount: {
                      amount: "500000000",
                      decimals: 6,
                      uiAmountString: "500",
                    },
                  },
                ],
              },
              transaction: {
                message: {
                  accountKeys: [mintAuthority, customMint, destinationTokenAccount],
                  instructions: [
                    {
                      program: "spl-token",
                      parsed: {
                        type: "mintTo",
                        info: {
                          account: destinationTokenAccount,
                          amount: "500000000",
                          mint: customMint,
                          mintAuthority,
                        },
                      },
                    },
                  ],
                },
              },
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      );

      getSplTokenAccountAddressesMock.mockResolvedValueOnce([
        destinationTokenAccount as unknown as Address,
      ]);
      getSignaturesForAddressMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          signature: observedSig as unknown as Signature,
          slot: 103n,
          blockTime: 1700000300n,
          err: null,
        },
      ]);

      try {
        const res = await app.request(
          `/v1/payments/transfers?wallet=${TEST_WALLET_ID}`,
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
      } finally {
        fetchSpy.mockRestore();
      }
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

    it("scopes database-backed wallet-address history to the resolved wallet", async () => {
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
        walletId: "wal_payments_other",
        source: TEST_SOLANA_ADDRESSES.wallet2,
        destination: TEST_SOLANA_ADDRESSES.wallet3,
      });

      const res = await app.request(
        `/v1/payments/transfers?walletAddress=${TEST_SOLANA_ADDRESSES.wallet1}&includeObserved=false`,
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

    it("matches either side of an unowned address in database-backed history", async () => {
      await seedTransfer({
        id: "xfr_address_external_outbound",
        status: "confirmed",
        walletId: "wal_external_outbound",
        source: TEST_SOLANA_ADDRESSES.wallet2,
        destination: TEST_SOLANA_ADDRESSES.wallet3,
      });
      await seedTransfer({
        id: "xfr_address_external_inbound",
        status: "confirmed",
        walletId: "wal_external_inbound",
        source: TEST_SOLANA_ADDRESSES.wallet3,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        direction: "inbound",
      });
      await seedTransfer({
        id: "xfr_address_external_unrelated",
        status: "confirmed",
        walletId: "wal_external_unrelated",
        source: TEST_SOLANA_ADDRESSES.wallet3,
        destination: TEST_KORA_FEE_PAYER,
      });

      const res = await app.request(
        `/v1/payments/transfers?walletAddress=${TEST_SOLANA_ADDRESSES.wallet2}&includeObserved=false`,
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
        "xfr_address_external_inbound",
        "xfr_address_external_outbound",
      ]);
      expect(body.meta.total).toBe(2);
    });

    it("enforces payments:read wallet grants for database-backed transfer lists", async () => {
      await seedTransfer({ id: "xfr_wallet_readable", status: "confirmed" });
      await seedTransfer({
        id: "xfr_wallet_write_only",
        status: "confirmed",
        walletId: "wal_payments_write_only",
      });
      await seedCachedKey({
        walletBindings: [
          { walletId: TEST_WALLET_ID, permissions: ["payments:read"] },
          { walletId: "wal_payments_write_only", permissions: ["payments:write"] },
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
        "/v1/payments/transfers?wallet=wal_payments_write_only&includeObserved=false",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );
      expect(forbiddenRes.status).toBe(403);
    });

    it("returns no rows when selected wallets grant no payments:read access", async () => {
      await seedTransfer({ id: "xfr_wallet_not_readable", status: "confirmed" });
      await seedCachedKey({
        walletBindings: [{ walletId: TEST_WALLET_ID, permissions: ["payments:write"] }],
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
        walletBindings: [{ walletId: TEST_WALLET_ID, permissions: ["payments:write"] }],
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
        wallet: TEST_WALLET_ID,
        walletAddress: TEST_SOLANA_ADDRESSES.wallet1,
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

        // The wallet-scoped merged path fetches non-chain rows through a
        // separate SQL query; the filter must be normalized there as well.
        const walletRes = await app.request(
          `/v1/payments/transfers?wallet=${TEST_WALLET_ID}&token=${filter}`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
          },
          env
        );

        expect(walletRes.status).toBe(200);
        const walletBody = (await walletRes.json()) as { data: Array<{ id: string }> };
        expect(walletBody.data.map((transfer) => transfer.id)).toEqual(["xfr_native_sol_pending"]);
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
      await seedTransfer({ id: "xfr_multi_completed", status: "completed" });
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
      expect(body.data.map((transfer) => transfer.status).sort()).toEqual([
        "completed",
        "confirmed",
      ]);
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
        data: Array<{ id: string; walletId: string }>;
        meta: { total: number; page: number; pageSize: number; hasMore: boolean };
      };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        id: "xfr_search_new",
        walletId: TEST_WALLET_ID,
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
        wallet: TEST_WALLET_ID,
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
        `/v1/payments/transfers?wallet=${TEST_WALLET_ID}&includeObserved=false`,
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
        data: { transfer: { id: string; status: string } };
      };
      expect(body.data.transfer.id).toBe("xfr_single_1");
      expect(body.data.transfer.status).toBe("confirmed");
    });

    it("enforces payments:read when getting a transfer by ID", async () => {
      await seedTransfer({ id: "xfr_single_write_only", status: "confirmed" });
      await seedCachedKey({
        walletBindings: [{ walletId: TEST_WALLET_ID, permissions: ["payments:write"] }],
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

    it("returns 404 when the transfer belongs to a different project in the same org", async () => {
      const otherProjectId = "prj_payments_cross_project";
      const now = new Date().toISOString();

      await getDb(env)
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          otherProjectId,
          TEST_ORG.id,
          "Other Payments Project",
          "other-payments-project",
          "sandbox",
          "active",
          TEST_USER.id
        )
        .run();

      await getDb(env)
        .prepare(
          `INSERT INTO payment_transfers
             (id, organization_id, project_id, wallet_id, source_address, destination_address, token, amount, memo, type, direction, status, signature, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          "xfr_cross_project_iso",
          TEST_ORG.id,
          otherProjectId,
          TEST_WALLET_ID,
          TEST_SOLANA_ADDRESSES.wallet1,
          TEST_SOLANA_ADDRESSES.wallet2,
          "SOL",
          "1",
          null,
          "transfer",
          "outbound",
          "confirmed",
          null,
          now,
          now
        )
        .run();

      const res = await app.request(
        "/v1/payments/transfers/xfr_cross_project_iso",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(404);
    });
  });
});
