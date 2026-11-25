import assert from "node:assert/strict";
import test from "node:test";
import {
  createSolanaRpcFromTransport,
  getBase58Decoder,
  type Signature,
  signature,
} from "@solana/kit";
import { proveExpiredAbsence, reReadExpiredStatuses, type SolanaRpc } from "./solana";

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

const AWAITING = { signature: LANDED, lastValidBlockHeight: 50n };
const HEIGHT = { blockHeight: 60n, absoluteSlot: 100n };

test("proves only rows whose blockhash the height shows expired", async () => {
  const { rpc, payloads } = rpcAnswering(
    '{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":100},"value":[null]}}'
  );
  const rows = [AWAITING, null, { signature: ABSENT, lastValidBlockHeight: 60n }];

  const proof = await proveExpiredAbsence(
    rpc,
    rows,
    [null, null, null],
    HEIGHT,
    (row) => row,
    () => assert.fail("the re-read succeeded")
  );

  assert.deepEqual(proof, { statuses: [null, null, null], unproven: new Set() });
  assert.equal(payloads.length, 1);
  assert.partialDeepStrictEqual(payloads[0], {
    method: "getSignatureStatuses",
    params: [[LANDED], { searchTransactionHistory: true, minContextSlot: 100n }],
  });
});

test("leaves every expired row unproven when no node at the height's slot answers", async () => {
  const rpc = createSolanaRpcFromTransport(async () => {
    throw new Error("no node at the floor");
  });
  const failures: Array<{ error: unknown; expired: number }> = [];

  const proof = await proveExpiredAbsence(
    rpc,
    [AWAITING, AWAITING],
    [null, null],
    HEIGHT,
    (row) => row,
    (error, expired) => failures.push({ error, expired })
  );

  assert.deepEqual(proof, { statuses: [null, null], unproven: new Set([0, 1]) });
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.expired, 2);
});
