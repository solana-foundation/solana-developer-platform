import * as solanaRpc from "@sdp/rpc/solana";
import { type Address, address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { inSandboxScope, installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { findSolRentShortfall, type SolMovement } from "./sol-rent-minimum";

const SOURCE = address(TEST_SOLANA_ADDRESSES.wallet1);
const OTHER = address(TEST_SOLANA_ADDRESSES.wallet2);
const ANOTHER = address(TEST_SOLANA_ADDRESSES.wallet3);
const getMultipleAccountsLamportsMock = vi.spyOn(solanaRpc, "getMultipleAccountsLamports");

/** Runs the check with the source at `sourceLamports`, `unfunded` empty, and every other wallet funded. */
function find(movement: SolMovement, sourceLamports: bigint, unfunded: readonly Address[] = []) {
  getMultipleAccountsLamportsMock.mockImplementation(async (_rpc, addresses) =>
    addresses.map((account) => {
      if (account === SOURCE) return sourceLamports;
      return unfunded.includes(account) ? 0n : 5_000_000n;
    })
  );
  return inSandboxScope(() => findSolRentShortfall(movement));
}

describe("findSolRentShortfall", () => {
  const rpc = installClusterRpcStub();

  beforeEach(() => {
    getMultipleAccountsLamportsMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the minimum once an hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // An hour past whatever an earlier test in this file cached.
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    const movement: SolMovement = {
      source: null,
      payments: [{ index: 0, destination: OTHER, lamports: 100n }],
    };
    const minimumReads = () =>
      rpc.calls.filter((call) => call.method === "getMinimumBalanceForRentExemption").length;

    await find(movement, 0n);
    await find(movement, 0n);
    expect(minimumReads()).toBe(1);

    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
    await find(movement, 0n);
    expect(minimumReads()).toBe(2);
  });

  it("refuses only payments below the minimum to an address with no account", async () => {
    const shortfall = await find(
      {
        source: null,
        payments: [
          { index: 0, destination: OTHER, lamports: 890_879n },
          { index: 1, destination: ANOTHER, lamports: 890_880n },
          { index: 2, destination: SOURCE, lamports: 100n },
        ],
      },
      1_000_000_000n,
      [OTHER, ANOTHER]
    );

    expect(shortfall).toEqual({
      recipientIndexes: [0],
      sourceRemainderLamports: null,
      minimumLamports: 890_880n,
      minimumAmount: "0.00089088",
    });
  });

  it("fails loudly when a transaction names a payment it was not given", async () => {
    await expect(
      find(
        {
          source: SOURCE,
          payments: [{ index: 0, destination: OTHER, lamports: 10_000_000n }],
          transactions: [[0], [7]],
        },
        10_000_000n
      )
    ).rejects.toThrow("unknown payment 7");
  });
});
