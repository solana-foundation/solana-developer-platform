import assert from "node:assert/strict";
import test from "node:test";
import type { Address } from "@solana/kit";
import { getBalanceLamports, type SolanaRpc } from "./solana";

const A = "11111111111111111111111111111111" as Address;

function rpcAnswering(value: bigint): { rpc: SolanaRpc; asked: () => unknown[][] } {
  const asked: unknown[][] = [];
  const rpc = {
    getBalance: (address: Address, config: unknown) => {
      asked.push([address, config]);
      return { send: async () => ({ value }) };
    },
  } as unknown as SolanaRpc;
  return { rpc, asked: () => asked };
}

test("reads one address's lamports from its own call", async () => {
  const { rpc, asked } = rpcAnswering(5n);

  assert.equal(await getBalanceLamports(rpc, A), 5n);
  // One call, naming only the address asked about, at the confirmed commitment.
  assert.deepEqual(asked(), [[A, { commitment: "confirmed" }]]);
});
