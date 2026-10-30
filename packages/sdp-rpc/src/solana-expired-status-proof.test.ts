import assert from "node:assert/strict";
import test from "node:test";
import {
  createSolanaRpcFromTransport,
  getBase58Decoder,
  type Signature,
  signature,
} from "@solana/kit";
import { reReadExpiredStatuses, type SolanaRpc } from "./solana";

function signatureOf(fill: number): Signature {
  return signature(getBase58Decoder().decode(new Uint8Array(64).fill(fill)));
}

const LANDED = signatureOf(1);
const ABSENT = signatureOf(2);

function rpcAnswering(responseJson: string): { rpc: SolanaRpc; payloads: unknown[] } {
  const payloads: unknown[] = [];
  const rpc = createSolanaRpcFromTransport(async ({ payload }) => {
    payloads.push(payload);
    return JSON.parse(responseJson);
  });
  return { rpc, payloads };
}

test("asks no node anything when no row expired unseen", async () => {
  const { rpc, payloads } = rpcAnswering("{}");
  assert.deepEqual(await reReadExpiredStatuses(rpc, [null], [], 100n), [null]);
  assert.deepEqual(payloads, []);
});

test("re-reads only the expired rows at the floor and puts each answer in place", async () => {
  const { rpc, payloads } = rpcAnswering(
    '{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":100},"value":[{"slot":7,"confirmations":null,"confirmationStatus":"finalized","err":null},null]}}'
  );

  const statuses = await reReadExpiredStatuses(
    rpc,
    [null, null, null],
    [
      { index: 1, signature: LANDED },
      { index: 2, signature: ABSENT },
    ],
    100n
  );

  assert.deepEqual(statuses, [
    null,
    { slot: 7n, confirmations: null, confirmationStatus: "finalized", err: null },
    null,
  ]);
  assert.equal(payloads.length, 1);
  assert.partialDeepStrictEqual(payloads[0], {
    method: "getSignatureStatuses",
    params: [[LANDED, ABSENT], { searchTransactionHistory: true, minContextSlot: 100n }],
  });
});
