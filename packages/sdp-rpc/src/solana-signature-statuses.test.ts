import assert from "node:assert/strict";
import test from "node:test";
import type { Signature } from "@solana/kit";
import { getSignatureStatuses, type SolanaRpc } from "./solana";

const SIG = "sig111" as Signature;

const STATUS = {
  slot: 100n,
  confirmations: 5n,
  confirmationStatus: "confirmed",
  err: null,
};

function flakyRpc(failures: number): { rpc: SolanaRpc; calls: () => number } {
  let calls = 0;
  const rpc = {
    getSignatureStatuses: () => ({
      send: async () => {
        calls += 1;
        if (calls <= failures) {
          throw new TypeError("fetch failed");
        }
        return { value: [STATUS] };
      },
    }),
  } as unknown as SolanaRpc;
  return { rpc, calls: () => calls };
}

test("retries a transient network failure and returns the statuses", async () => {
  const { rpc, calls } = flakyRpc(1);
  const result = await getSignatureStatuses(rpc, [SIG], { retryDelaysMs: [0] });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.confirmationStatus, "confirmed");
  assert.equal(calls(), 2);
});

test("rethrows once the retry schedule is exhausted", async () => {
  const { rpc, calls } = flakyRpc(10);
  await assert.rejects(
    () => getSignatureStatuses(rpc, [SIG], { retryDelaysMs: [0, 0] }),
    /fetch failed/
  );
  assert.equal(calls(), 3);
});

test("does not retry a persistent error", async () => {
  let calls = 0;
  const rpc = {
    getSignatureStatuses: () => ({
      send: async () => {
        calls += 1;
        throw new Error("invalid param: unsupported value");
      },
    }),
  } as unknown as SolanaRpc;
  await assert.rejects(
    () => getSignatureStatuses(rpc, [SIG], { retryDelaysMs: [0] }),
    /invalid param/
  );
  assert.equal(calls, 1);
});
