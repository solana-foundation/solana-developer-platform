import assert from "node:assert/strict";
import test from "node:test";
import type { Signature } from "@solana/kit";
import { getTransaction, type SolanaRpc, tokenBalanceDelta } from "./solana";

const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SHARE = "DvMCm7Xjirn7xmf3j4kWV49NGJUQqh7jVTAEvNNPAYiw";
const OWNER = "3HArNo1CCY8AekuckdiZW3SBw2zZxKX3sdqYksgD9eVm";
const VAULT = "CApPBBp8Fgb8zvRzDojfSe9bqzq6LejvDxFtucHoQaUk";

const balance = (accountIndex: number, mint: string, owner: string, amount: string) => ({
  accountIndex,
  mint,
  owner,
  amount,
  decimals: 6,
});

test("sums the receiver's post-minus-pre balance for one mint, ignoring other owners", () => {
  const delta = tokenBalanceDelta(
    {
      preTokenBalances: [
        balance(1, USDC, OWNER, "1000000"),
        balance(2, SHARE, OWNER, "3000000"),
        balance(3, USDC, VAULT, "900000000"),
      ],
      postTokenBalances: [
        balance(1, USDC, OWNER, "2004500"),
        balance(2, SHARE, OWNER, "2000000"),
        balance(3, USDC, VAULT, "898995500"),
      ],
    },
    { mint: USDC, owner: OWNER }
  );
  assert.deepEqual(delta, { baseUnits: 1004500n, decimals: 6 });
});

test("counts a token account the transaction created from zero", () => {
  const delta = tokenBalanceDelta(
    { preTokenBalances: [], postTokenBalances: [balance(4, USDC, OWNER, "250000")] },
    { mint: USDC, owner: OWNER }
  );
  assert.deepEqual(delta, { baseUnits: 250000n, decimals: 6 });
});

test("reports a payout across several accounts of the same owner as one delta", () => {
  const delta = tokenBalanceDelta(
    {
      preTokenBalances: [balance(1, USDC, OWNER, "10"), balance(5, USDC, OWNER, "20")],
      postTokenBalances: [balance(1, USDC, OWNER, "15"), balance(5, USDC, OWNER, "30")],
    },
    { mint: USDC, owner: OWNER }
  );
  assert.deepEqual(delta, { baseUnits: 15n, decimals: 6 });
});

test("answers null, not zero, when neither side names the pair", () => {
  const delta = tokenBalanceDelta(
    {
      preTokenBalances: [balance(2, SHARE, OWNER, "1")],
      postTokenBalances: [balance(2, SHARE, OWNER, "0")],
    },
    { mint: USDC, owner: OWNER }
  );
  assert.equal(delta, null);
  assert.equal(tokenBalanceDelta({}, { mint: USDC, owner: OWNER }), null);
});

test("getTransaction surfaces pre/post token balances from jsonParsed meta", async () => {
  let request: unknown;
  const rpc = {
    getTransaction: (_signature: unknown, config: unknown) => {
      request = config;
      return {
        send: async () => ({
          slot: 42n,
          meta: {
            err: null,
            fee: 5000n,
            preBalances: [],
            postBalances: [],
            preTokenBalances: [
              {
                accountIndex: 1,
                mint: USDC,
                owner: OWNER,
                uiTokenAmount: { amount: "1", decimals: 6 },
              },
            ],
            postTokenBalances: [
              { accountIndex: 1, mint: USDC, uiTokenAmount: { amount: "3", decimals: 6 } },
            ],
          },
          transaction: { message: { instructions: [] } },
        }),
      };
    },
  } as unknown as SolanaRpc;

  const parsed = await getTransaction(rpc, "sig" as Signature);
  assert.deepEqual(request, {
    commitment: "confirmed",
    encoding: "jsonParsed",
    maxSupportedTransactionVersion: 0,
  });
  assert.deepEqual(parsed?.preTokenBalances, [
    { accountIndex: 1, mint: USDC, owner: OWNER, amount: "1", decimals: 6 },
  ]);
  // A missing owner is kept as null so a delta can never be attributed by accident.
  assert.deepEqual(parsed?.postTokenBalances, [
    { accountIndex: 1, mint: USDC, owner: null, amount: "3", decimals: 6 },
  ]);
});
