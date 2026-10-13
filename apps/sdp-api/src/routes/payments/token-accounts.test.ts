import { createClusterRpc } from "@sdp/rpc/factory";
import { runInClusterScope } from "@sdp/rpc/scope";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKENS } from "@sdp/types";
import { type Address, address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import {
  installClusterRpcRequestLog,
  tokenAccountsByOwnerResult,
} from "@/test/helpers/cluster-rpc";
import {
  getLamportsBalance,
  getSplTokenBalances,
  resolveTokenLabel,
  withIssuedTokenLabels,
} from "./token-accounts";

describe("resolveTokenLabel", () => {
  it("uses the issued token symbol for a known mint", () => {
    const mint = "HZWQBKZW8HXMN6BF2YFZNRHT3C2IXXZPKCFU7UBEDKTR";
    const labels = new Map([[mint, "MINT"]]);

    expect(resolveTokenLabel(mint, labels)).toBe("MINT");
  });

  it("falls back to the well-known token symbol", () => {
    expect(resolveTokenLabel(WELL_KNOWN_TOKENS.USDC.mints.devnet.address)).toBe("USDC");
  });

  it("falls back to the mint address when no symbol is known", () => {
    const mint = "UnknownMint1111111111111111111111111111111111";

    expect(resolveTokenLabel(mint)).toBe(mint);
  });
});

describe("withIssuedTokenLabels", () => {
  it("renames only the balances whose mint the organization issued", () => {
    const issued = "IssuedMint111111111111111111111111111111111";
    const usdc = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;
    const balances = [
      { token: issued, mint: issued, amount: "1" },
      { token: "USDC", mint: usdc, amount: "2" },
    ];

    expect(withIssuedTokenLabels(balances, new Map([[issued, " ISS "]]))).toEqual([
      { token: "ISS", mint: issued, amount: "1" },
      { token: "USDC", mint: usdc, amount: "2" },
    ]);
  });
});

describe("getSplTokenBalances", () => {
  it("asks both token programs before either answers", async () => {
    const asked: string[] = [];
    const answers: Array<() => void> = [];
    const rpc = {
      getTokenAccountsByOwner: (_owner: Address, { programId }: { programId: string }) => ({
        send: () =>
          new Promise((resolve) => {
            asked.push(programId);
            answers.push(() => resolve({ context: { slot: 1n }, value: [] }));
          }),
      }),
    } as unknown as SolanaRpc;

    const balances = getSplTokenBalances(rpc, "Owner111" as Address);
    await Promise.resolve();

    expect(asked).toEqual([SPL_TOKEN_PROGRAMS["spl-token"], SPL_TOKEN_PROGRAMS["token-2022"]]);
    for (const answer of answers) answer();
    await expect(balances).resolves.toEqual([]);
  });
});

describe("balance read bounds", () => {
  const rpc = installClusterRpcRequestLog();
  const owner = address(TEST_SOLANA_ADDRESSES.wallet1);

  function readOnDevnet<T>(read: (clusterRpc: SolanaRpc) => Promise<T>): Promise<T> {
    return runInClusterScope({ projectId: "prj_balance_read_bounds", environment: "sandbox" }, () =>
      read(createClusterRpc())
    );
  }

  function requestsFor(method: string) {
    return rpc.requests.filter((request) => request.method === method);
  }

  it("sends minContextSlot on the lamports read and refuses an answer from an older bank", async () => {
    rpc.answer("getBalance", { context: { slot: 99 }, value: 5 });

    await expect(
      readOnDevnet((clusterRpc) => getLamportsBalance(clusterRpc, owner, { minContextSlot: 100n }))
    ).rejects.toThrow("RPC balance read is behind the confirmed transaction slot");
    expect(requestsFor("getBalance")).toEqual([
      {
        cluster: "devnet",
        method: "getBalance",
        params: [owner, { commitment: "confirmed", minContextSlot: 100 }],
      },
    ]);
  });

  it("refuses a bounded lamports read whose answer carries no context slot", async () => {
    rpc.answer("getBalance", { context: {}, value: 5 });

    await expect(
      readOnDevnet((clusterRpc) => getLamportsBalance(clusterRpc, owner, { minContextSlot: 100n }))
    ).rejects.toThrow("RPC balance read is behind the confirmed transaction slot");
  });

  it("refuses a bounded token balance read whose answer carries no context slot", async () => {
    rpc.answer("getTokenAccountsByOwner", { context: {}, value: [] });

    await expect(
      readOnDevnet((clusterRpc) => getSplTokenBalances(clusterRpc, owner, { minContextSlot: 100n }))
    ).rejects.toThrow("RPC balance read is behind the confirmed transaction slot");
  });

  it("sends minContextSlot on both token program reads and refuses an answer from an older bank", async () => {
    rpc.answer("getTokenAccountsByOwner", tokenAccountsByOwnerResult(99, []));

    await expect(
      readOnDevnet((clusterRpc) => getSplTokenBalances(clusterRpc, owner, { minContextSlot: 100n }))
    ).rejects.toThrow("RPC balance read is behind the confirmed transaction slot");
    expect(requestsFor("getTokenAccountsByOwner")).toHaveLength(2);
    expect(requestsFor("getTokenAccountsByOwner")).toEqual(
      expect.arrayContaining(
        [SPL_TOKEN_PROGRAMS["spl-token"], SPL_TOKEN_PROGRAMS["token-2022"]].map((programId) => ({
          cluster: "devnet",
          method: "getTokenAccountsByOwner",
          params: [
            owner,
            { programId },
            { encoding: "jsonParsed", commitment: "confirmed", minContextSlot: 100 },
          ],
        }))
      )
    );
  });

  it("sends no minContextSlot on unbounded token program reads", async () => {
    rpc.answer("getTokenAccountsByOwner", tokenAccountsByOwnerResult(1, []));

    await expect(
      readOnDevnet((clusterRpc) => getSplTokenBalances(clusterRpc, owner))
    ).resolves.toEqual([]);
    expect(requestsFor("getTokenAccountsByOwner")).toHaveLength(2);
    expect(requestsFor("getTokenAccountsByOwner")).toEqual(
      expect.arrayContaining(
        [SPL_TOKEN_PROGRAMS["spl-token"], SPL_TOKEN_PROGRAMS["token-2022"]].map((programId) => ({
          cluster: "devnet",
          method: "getTokenAccountsByOwner",
          params: [owner, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }],
        }))
      )
    );
  });
});
