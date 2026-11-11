import {
  readStamp,
  withMinimumRpcSlot,
  withReadFloor,
  withRpcReadContext,
} from "@sdp/rpc/read-context";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { PLUME_PROGRAMS, PLUME_VAULTS } from "@sdp/types/plume-programs";
import { SPL_TOKEN_PROGRAMS, wellKnownMint } from "@sdp/types/well-known-tokens";
import {
  address,
  createSolanaRpcFromTransport,
  getAddressEncoder,
  type RpcTransport,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readPlumeVault } from "./chain";

const vault = PLUME_VAULTS[0],
  usdc = wellKnownMint("USDC", "mainnet-beta");
if (!vault || !usdc) throw new Error("Missing pinned deployment fixture");
const owner = "11111111111111111111111111111112",
  tokenProgram = SPL_TOKEN_PROGRAMS["spl-token"];
const pubkey = (value: string) => Buffer.from(getAddressEncoder().encode(address(value)));
function token(mint: string, ownerAddress: string, balance: bigint) {
  const bytes = Buffer.alloc(165);
  pubkey(mint).copy(bytes);
  pubkey(ownerAddress).copy(bytes, 32);
  bytes.writeBigUInt64LE(balance, 64);
  bytes[108] = 1;
  return bytes;
}
function mint() {
  const bytes = Buffer.alloc(82);
  bytes[44] = 6;
  bytes[45] = 1;
  return bytes;
}
function fixture() {
  const deployment = vault,
    depositMint = usdc;
  if (!deployment || !depositMint) throw new Error("Missing fixture");
  const store = Buffer.alloc(113);
  Buffer.from([195, 215, 104, 134, 185, 195, 240, 114]).copy(store);
  store.writeBigUInt64LE(1n, 9);
  pubkey(deployment.shareMint).copy(store, 17);
  pubkey(deployment.tokenEscrow).copy(store, 49);
  pubkey(PLUME_PROGRAMS.endpoint).copy(store, 81);
  let shares = 10_000_000n;
  const keyCounts: number[] = [];
  let failNext = false;
  const accountFor = (key: string): Buffer => {
    switch (key) {
      case deployment.oftStore:
        return store;
      case deployment.tokenEscrow:
        return token(deployment.shareMint, deployment.oftStore, 100_000_000n);
      case deployment.shareMint:
      case depositMint:
        return mint();
      default:
        return token(deployment.shareMint, owner, shares);
    }
  };
  const transport: RpcTransport = async <T>({
    payload,
  }: Parameters<RpcTransport>[0]): Promise<T> => {
    const p = z
      .object({
        method: z.literal("getMultipleAccounts"),
        params: z.array(z.unknown()),
        id: z.union([z.string(), z.number()]),
      })
      .parse(payload);
    const keys = z.array(z.string()).parse(p.params[0]);
    keyCounts.push(keys.length);
    if (failNext) {
      failNext = false;
      throw new Error("RPC unavailable");
    }
    const result = {
      context: { slot: 1n },
      value: keys.map((key) => {
        const data = accountFor(key);
        return {
          owner: key === deployment.oftStore ? PLUME_PROGRAMS.oft : tokenProgram,
          data: [data.toString("base64"), "base64"],
          lamports: 1n,
          executable: false,
          space: BigInt(data.length),
        };
      }),
    };
    // SAFETY: this test transport supplies exactly the JSON-RPC envelope for this one Kit method.
    return { jsonrpc: "2.0", id: p.id, result } as T;
  };
  const rpc: SolanaRpc = createSolanaRpcFromTransport(withRpcReadContext(transport));
  return {
    rpc,
    keyCounts,
    failNext() {
      failNext = true;
    },
    setShares: (value: bigint) => {
      shares = value;
    },
  };
}
describe("Plume RPC budget", () => {
  it("batches five cold and three warm accounts while keeping holdings live", async () => {
    const f = fixture();
    const initial = await readPlumeVault(f.rpc, vault, owner, usdc);
    f.setShares(5_000_000n);
    const next = await readPlumeVault(f.rpc, vault, owner, usdc);
    expect(initial.shares).toBe(10_000_000n);
    expect(next.shares).toBe(5_000_000n);
    expect(f.keyCounts).toEqual([5, 3]);
  });
  it("shares identical concurrent reads", async () => {
    const f = fixture();
    await Promise.all([
      readPlumeVault(f.rpc, vault, owner, usdc),
      readPlumeVault(f.rpc, vault, owner, usdc),
    ]);
    expect(f.keyCounts).toHaveLength(1);
  });
  it("never joins a shared read under a minimum-slot scope", async () => {
    const f = fixture();
    const live = readPlumeVault(f.rpc, vault, owner, usdc);
    const scoped = withMinimumRpcSlot(1, () => readPlumeVault(f.rpc, vault, owner, usdc));
    await Promise.all([live, scoped]);
    // The scoped read sends its own request, so the context-aware transport
    // validates its own scope; a joined response observes no RPC context.
    // Only the request count is asserted: whether the scoped request is sent
    // before or after the live reply warms the mint cache is the event loop's
    // decision, not this test's.
    expect(f.keyCounts).toHaveLength(2);
  });
  it("never joins a request sent before the caller's read floor", async () => {
    const f = fixture();
    const live = readPlumeVault(f.rpc, vault, owner, usdc);
    const floored = withReadFloor(readStamp(), () => readPlumeVault(f.rpc, vault, owner, usdc));
    await Promise.all([live, floored]);
    // Same timing note as the scoped read above: two requests must go out;
    // their cold/warm shapes are not part of this assertion.
    expect(f.keyCounts).toHaveLength(2);
  });
  it("never caches a failed identity proof", async () => {
    const f = fixture();
    f.failNext();
    await expect(readPlumeVault(f.rpc, vault, owner, usdc)).rejects.toThrow();
    await readPlumeVault(f.rpc, vault, owner, usdc);
    expect(f.keyCounts).toEqual([5, 5]);
  });
});
