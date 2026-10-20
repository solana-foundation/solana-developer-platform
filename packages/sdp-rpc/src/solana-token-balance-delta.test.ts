import assert from "node:assert/strict";
import test from "node:test";
import {
  address,
  createSolanaRpcFromTransport,
  type RpcTransport,
  type Signature,
  signature,
  stringifiedBigInt,
  stringifiedNumber,
  unixTimestamp,
} from "@solana/kit";
import { getTransaction, type SolanaRpc, tokenBalanceDelta } from "./solana";
import {
  type JsonParsedTransactionResponse,
  jsonParsedTransactionMeta,
  jsonParsedTransactionResponse,
} from "./test-fixtures";

const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SHARE = "DvMCm7Xjirn7xmf3j4kWV49NGJUQqh7jVTAEvNNPAYiw";
const OWNER = "3HArNo1CCY8AekuckdiZW3SBw2zZxKX3sdqYksgD9eVm";
const VAULT = "CApPBBp8Fgb8zvRzDojfSe9bqzq6LejvDxFtucHoQaUk";
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

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
        send: async () =>
          jsonParsedTransactionResponse({
            meta: jsonParsedTransactionMeta({
              err: null,
              preTokenBalances: [
                {
                  accountIndex: 1,
                  mint: address(USDC),
                  owner: address(OWNER),
                  programId: TOKEN_PROGRAM,
                  uiTokenAmount: {
                    amount: stringifiedBigInt("1"),
                    decimals: 6,
                    uiAmount: 0.000001,
                    uiAmountString: stringifiedNumber("0.000001"),
                  },
                },
              ],
              postTokenBalances: [
                {
                  accountIndex: 1,
                  mint: address(USDC),
                  programId: TOKEN_PROGRAM,
                  uiTokenAmount: {
                    amount: stringifiedBigInt("3"),
                    decimals: 6,
                    uiAmount: 0.000003,
                    uiAmountString: stringifiedNumber("0.000003"),
                  },
                },
              ],
            }),
            instructions: [],
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

test("getTransaction surfaces the block time, null when the RPC has none", async () => {
  const read = (blockTime?: JsonParsedTransactionResponse["blockTime"]) => {
    const transport: RpcTransport = async <TResponse>() =>
      // SAFETY: getTransaction sends this transport its one request, so this envelope is its response.
      ({
        jsonrpc: "2.0",
        id: 1,
        result: jsonParsedTransactionResponse({ meta: null, instructions: [], blockTime }),
      }) as TResponse;
    return getTransaction(
      createSolanaRpcFromTransport(transport),
      signature(
        "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"
      )
    );
  };

  assert.equal((await read(unixTimestamp(1_792_000_000n)))?.blockTime, 1_792_000_000n);
  assert.equal((await read())?.blockTime, null);
});

for (const { name, meta, known } of [
  { name: "null metadata", meta: null, known: false },
  {
    name: "successful execution",
    meta: jsonParsedTransactionMeta({ err: null, preTokenBalances: [], postTokenBalances: [] }),
    known: true,
  },
  {
    name: "failed execution",
    meta: jsonParsedTransactionMeta({
      err: "InsufficientFundsForFee",
      preTokenBalances: [],
      postTokenBalances: [],
    }),
    known: true,
  },
]) {
  test(`getTransaction identifies ${name}`, async () => {
    const rpc = {
      getTransaction: () => ({
        send: async () => jsonParsedTransactionResponse({ meta, instructions: [] }),
      }),
    } as unknown as SolanaRpc;

    const parsed = await getTransaction(rpc, "sig" as Signature, "finalized");

    assert.ok(parsed);
    assert.equal(parsed.executionResultKnown, known);
  });
}
