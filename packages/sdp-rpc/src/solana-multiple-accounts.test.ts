import assert from "node:assert/strict";
import test from "node:test";
import type { Address } from "@solana/kit";
import { GET_MULTIPLE_ACCOUNTS_LIMIT, getMultipleAccountsLamports, type SolanaRpc } from "./solana";

const A = "11111111111111111111111111111111" as Address;
const B = "So11111111111111111111111111111111111111112" as Address;

function rpcAnswering(value: unknown[]): { rpc: SolanaRpc; asked: () => unknown[][] } {
  const asked: unknown[][] = [];
  const rpc = {
    getMultipleAccounts: (addresses: Address[], config: unknown) => {
      asked.push([addresses, config]);
      return { send: async () => ({ value }) };
    },
  } as unknown as SolanaRpc;
  return { rpc, asked: () => asked };
}

test("reads every balance in one call, a missing account as zero", async () => {
  const { rpc, asked } = rpcAnswering([{ lamports: 5n }, null]);

  assert.deepEqual(await getMultipleAccountsLamports(rpc, [A, B]), [5n, 0n]);
  assert.equal(asked().length, 1);
  assert.deepEqual(asked()[0], [
    [A, B],
    { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 } },
  ]);
});

test("refuses more addresses than one call accepts, without calling", async () => {
  const { rpc, asked } = rpcAnswering([]);
  const addresses = Array.from({ length: GET_MULTIPLE_ACCOUNTS_LIMIT + 1 }, () => A);

  await assert.rejects(() => getMultipleAccountsLamports(rpc, addresses), RangeError);
  assert.equal(asked().length, 0);
});

test("refuses an answer for a different number of accounts", async () => {
  const { rpc } = rpcAnswering([{ lamports: 5n }]);

  await assert.rejects(() => getMultipleAccountsLamports(rpc, [A, B]), /1 accounts for 2/);
});

test("makes no call for no addresses", async () => {
  const { rpc, asked } = rpcAnswering([]);

  assert.deepEqual(await getMultipleAccountsLamports(rpc, []), []);
  assert.equal(asked().length, 0);
});
