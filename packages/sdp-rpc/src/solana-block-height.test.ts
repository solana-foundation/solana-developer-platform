import assert from "node:assert/strict";
import test from "node:test";
import { createSolanaRpcFromTransport } from "@solana/kit";
import { getChainHeight, getRecentBlockhash } from "./solana";

const BLOCKHASH = "29d2S7vB453rNYFdR5Ycwt7y9haRT5fwVwL9zTmBhfV2";

test("asks for the latest blockhash from a node at or past minContextSlot", async () => {
  const payloads: unknown[] = [];
  const rpc = createSolanaRpcFromTransport(async ({ payload }) => {
    payloads.push(payload);
    return JSON.parse(
      `{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":40},"value":{"blockhash":"${BLOCKHASH}","lastValidBlockHeight":200}}}`
    );
  });
  const latest = await getRecentBlockhash(rpc, "confirmed", 37n);
  assert.deepEqual(latest, { blockhash: BLOCKHASH, lastValidBlockHeight: 200n });
  assert.equal(payloads.length, 1);
  assert.partialDeepStrictEqual(payloads[0], {
    method: "getLatestBlockhash",
    params: [{ commitment: "confirmed", minContextSlot: 37n }],
  });
});

test("reads the chain height and slot from one epoch info response", async () => {
  const rpc = createSolanaRpcFromTransport(async () =>
    JSON.parse(
      '{"jsonrpc":"2.0","id":1,"result":{"absoluteSlot":300,"blockHeight":250,"epoch":1,"slotIndex":12,"slotsInEpoch":432000,"transactionCount":null}}'
    )
  );
  assert.deepEqual(await getChainHeight(rpc, "finalized"), {
    blockHeight: 250n,
    absoluteSlot: 300n,
  });
});

test("refuses a latest blockhash answered from below minContextSlot", async () => {
  const rpc = createSolanaRpcFromTransport(async () =>
    JSON.parse(
      `{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":36},"value":{"blockhash":"${BLOCKHASH}","lastValidBlockHeight":200}}}`
    )
  );
  await assert.rejects(getRecentBlockhash(rpc, "confirmed", 37n), {
    name: "SdpRpcError",
    code: "SOLANA_RPC_ERROR",
  });
});
