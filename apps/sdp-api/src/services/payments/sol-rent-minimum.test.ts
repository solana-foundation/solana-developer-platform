import { runInClusterScope } from "@sdp/rpc/scope";
import * as solanaRpc from "@sdp/rpc/solana";
import { address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { findSolRentShortfall, type SolMovement } from "./sol-rent-minimum";

const SOURCE = address(TEST_SOLANA_ADDRESSES.wallet1);
const OTHER = address(TEST_SOLANA_ADDRESSES.wallet2);
const getMultipleAccountsLamportsMock = vi.spyOn(solanaRpc, "getMultipleAccountsLamports");

function find(movement: SolMovement, sourceLamports: bigint) {
  getMultipleAccountsLamportsMock.mockImplementation(async (_rpc, addresses) =>
    addresses.map((account) => (account === SOURCE ? sourceLamports : 5_000_000n))
  );
  return runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
    findSolRentShortfall(movement)
  );
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

  it("does not count a payment back to the source as leaving it", async () => {
    // 1 SOL held, 0.9997 SOL "sent" to itself: the wallet still holds 1 SOL.
    await expect(
      find(
        { source: SOURCE, payments: [{ index: 0, destination: SOURCE, lamports: 999_700_000n }] },
        1_000_000_000n
      )
    ).resolves.toBeNull();
  });

  it("counts only the payments that leave the source", async () => {
    // 1 SOL held, 0.9997 SOL to another wallet plus 0.5 SOL to itself: 0.0003 SOL left.
    const shortfall = await find(
      {
        source: SOURCE,
        payments: [
          { index: 0, destination: OTHER, lamports: 999_700_000n },
          { index: 1, destination: SOURCE, lamports: 500_000_000n },
        ],
      },
      1_000_000_000n
    );
    expect(shortfall?.sourceRemainderLamports).toBe(300_000n);
  });

  it("refuses a sweep whose smallest transaction moves less than the minimum", async () => {
    const shortfall = await find(
      {
        source: SOURCE,
        payments: [
          { index: 0, destination: OTHER, lamports: 500_000n },
          { index: 1, destination: OTHER, lamports: 9_500_000n },
        ],
        transactions: [[0], [1]],
      },
      10_000_000n
    );
    expect(shortfall?.sourceRemainderLamports).toBe(500_000n);
  });

  it("allows a sweep in one transaction", async () => {
    await expect(
      find(
        {
          source: SOURCE,
          payments: [
            { index: 0, destination: OTHER, lamports: 500_000n },
            { index: 1, destination: OTHER, lamports: 9_500_000n },
          ],
          transactions: [[0, 1]],
        },
        10_000_000n
      )
    ).resolves.toBeNull();
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
