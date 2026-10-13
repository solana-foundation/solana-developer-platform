import { describe, expect, it } from "vitest";
import {
  installClusterRpcStub,
  type JsonRpcResult,
  runInJobClusterScope,
} from "@/test/helpers/cluster-rpc";
import { readOwnerMintBalance } from "./owner-token-balance";

const OWNER = "3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("readOwnerMintBalance", () => {
  const stub = installClusterRpcStub();

  it("sums every matching token account in exact atoms", async () => {
    stub.answer("getTokenAccountsByOwner", {
      context: { slot: 1 },
      value: [tokenAccount("9007199254740993"), tokenAccount("9007199254740995")],
    });

    await expect(readBalance()).resolves.toEqual({
      atoms: 18_014_398_509_481_988n,
      decimals: 6,
    });
  });

  it("accepts an empty account list as an exact zero balance", async () => {
    stub.answer("getTokenAccountsByOwner", { context: { slot: 1 }, value: [] });

    await expect(readBalance()).resolves.toEqual({
      atoms: 0n,
      decimals: null,
    });
  });

  it("fails closed when a mint-filtered RPC response omits its account list", async () => {
    stub.answer("getTokenAccountsByOwner", { context: { slot: 1 } });

    await expect(readBalance()).rejects.toThrow(/token-account RPC response/i);
  });

  it.each([
    ["missing amount", tokenAccount(null)],
    ["numeric amount", tokenAccount(12)],
    ["fractional amount", tokenAccount("1.5")],
    ["non-integer decimals", tokenAccount("1", 6.5)],
  ])("fails closed on a %s", async (_label, account) => {
    stub.answer("getTokenAccountsByOwner", {
      context: { slot: 1 },
      value: [account],
    });

    await expect(readBalance()).rejects.toThrow(/token-account RPC response/i);
  });

  it("fails closed when matching accounts report inconsistent decimals", async () => {
    stub.answer("getTokenAccountsByOwner", {
      context: { slot: 1 },
      value: [tokenAccount("1", 6), tokenAccount("1", 9)],
    });

    await expect(readBalance()).rejects.toThrow(/inconsistent decimals/i);
  });

  it.each([
    ["mint", tokenAccount("1", 6, { mint: OWNER })],
    ["owner", tokenAccount("1", 6, { owner: USDC })],
  ])("fails closed when the RPC returns an out-of-scope %s", async (_label, account) => {
    stub.answer("getTokenAccountsByOwner", {
      context: { slot: 1 },
      value: [account],
    });

    await expect(readBalance()).rejects.toThrow(/out of scope/i);
  });
});

function readBalance() {
  return runInJobClusterScope("sandbox", () => readOwnerMintBalance(OWNER, USDC));
}

function tokenAccount(
  amount: JsonRpcResult,
  decimals = 6,
  scope: { mint?: string; owner?: string } = {}
): JsonRpcResult {
  return {
    account: {
      data: {
        parsed: {
          type: "account",
          info: {
            mint: scope.mint ?? USDC,
            owner: scope.owner ?? OWNER,
            tokenAmount: { amount, decimals },
          },
        },
      },
    },
  };
}
