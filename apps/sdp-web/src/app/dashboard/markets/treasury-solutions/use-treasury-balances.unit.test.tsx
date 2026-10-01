// @vitest-environment jsdom
import type { EarnVaultPosition } from "@sdp/types";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EarnVaultPositionsRead } from "../earn/earn-program-data";
import type { VaultActivity } from "./treasury-vault-balance";
import { useTreasuryBalances } from "./use-treasury-balances";

const mocks = vi.hoisted(() => ({
  reads: [] as EarnVaultPositionsRead[],
  positions: [] as EarnVaultPosition[],
  refreshPositions: vi.fn(),
  refreshWallets: vi.fn(),
  error: undefined as Error | undefined,
}));
vi.mock("../earn/earn-program-data", () => ({
  useEarnVaultPositions: () => ({
    reads: mocks.reads,
    positions: mocks.positions,
    refresh: mocks.refreshPositions,
    error: mocks.error,
    isLoading: false,
  }),
}));
vi.mock("../earn/deposit/earn-funding-wallets", () => ({
  useEarnFundingWallets: () => ({
    wallets: [],
    refreshBalances: mocks.refreshWallets,
    isLoading: false,
  }),
}));
const position: EarnVaultPosition = {
  id: "position",
  provider: "kamino",
  providerReference: "vault",
  custodyWalletId: "wallet",
  tokenMint: "mint",
  shareMint: "shares",
  label: "Vault",
  createdAt: "2026-10-01T00:00:00Z",
  closedAt: null,
  tokenValue: "10",
  shares: "10",
  feeSponsored: false,
};
const movement = (status: string): VaultActivity => ({
  kind: "deposit",
  movement: {
    movementId: "movement",
    positionId: position.id,
    status,
    observedOrder: 1,
    ...(status === "confirmed" ? { committedObservedAt: 10 } : {}),
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.error = undefined;
  mocks.positions = [position];
  mocks.reads = [{ positions: mocks.positions, startedAt: 1, landedAt: 2 }];
  mocks.refreshPositions.mockImplementation(async (ids: readonly string[] = []) => ({
    positions: mocks.positions,
    afterMovementIds: ids,
    startedAt: 11,
    landedAt: 12,
    minimumSlot: ids.length > 0 ? 101 : undefined,
  }));
  mocks.refreshWallets.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Treasury balance coordinator", () => {
  it("holds early chain balances until confirmation and the paired wallet read complete", async () => {
    let activities: VaultActivity[] = [];
    const { result, rerender } = renderHook(() => useTreasuryBalances(activities));
    expect(result.current.balanceOf(position)).toEqual({ value: "10", syncing: false });
    let finish: () => void = () => {};
    act(() => {
      finish = result.current.beginSubmission(position);
    });
    // The chain changes before the POST returns or the modal knows its movement id.
    mocks.positions = [{ ...position, tokenValue: "20", shares: "20" }];
    mocks.reads = [{ positions: mocks.positions, startedAt: 5, landedAt: 6 }];
    rerender();
    expect(result.current.balanceOf(position)).toEqual({ value: undefined, syncing: true });
    expect(result.current.balancesRefreshing).toBe(true);
    const unrelated = { ...position, id: "other", providerReference: "other-vault" };
    expect(result.current.balanceOf(unrelated).syncing).toBe(false);
    activities = [movement("submitted")];
    act(() => finish());
    rerender();
    expect(result.current.balanceOf(position).syncing).toBe(true);
    let finishWallet: () => void = () => {};
    mocks.refreshWallets.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishWallet = resolve;
      })
    );
    activities = [movement("confirmed")];
    rerender();
    await waitFor(() => expect(mocks.refreshWallets).toHaveBeenCalledWith(101, ["wallet"]));
    mocks.reads = [
      {
        positions: mocks.positions,
        startedAt: 11,
        landedAt: 12,
        afterMovementIds: ["movement"],
        minimumSlot: 101,
      },
    ];
    rerender();
    expect(result.current.balanceOf(position).syncing).toBe(true);
    await act(async () => finishWallet());
    expect(result.current.balanceOf(position)).toEqual({ value: "20", syncing: false });
    expect(result.current.balancesRefreshing).toBe(false);
  });

  it("does not let an old submission's completion clear a newer pending attempt", () => {
    const { result } = renderHook(() => useTreasuryBalances([]));
    let first: () => void = () => {};
    let second: () => void = () => {};
    act(() => {
      first = result.current.beginSubmission(position);
      second = result.current.beginSubmission(position);
    });
    act(() => first());
    expect(result.current.balanceOf(position).syncing).toBe(true);
    act(() => second());
    expect(result.current.balanceOf(position)).toEqual({ value: "10", syncing: false });
  });

  it("keeps unrelated verified holdings visible through a failed wallet refresh and recovers", async () => {
    mocks.refreshWallets.mockRejectedValueOnce(new Error("wallet RPC unavailable"));
    const { result } = renderHook(() => useTreasuryBalances([]));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.walletsError).toBeInstanceOf(Error);
    expect(result.current.positionsError).toBeUndefined();
    expect(result.current.balanceOf(position)).toEqual({ value: "10", syncing: false });
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.walletsError).toBeUndefined();
  });
});

describe("confirmation refresh recovery", () => {
  it("keeps the affected balance gated after wallet failure and retries with the same wallet scope", async () => {
    vi.useFakeTimers();
    const unrelated = { ...position, id: "other", custodyWalletId: "other-wallet" };
    mocks.positions = [position, unrelated];
    mocks.refreshPositions.mockImplementation(async (ids: readonly string[]) => {
      const read = {
        positions: mocks.positions,
        startedAt: 11,
        landedAt: 12,
        afterMovementIds: ids,
        minimumSlot: 101,
      };
      mocks.reads = [read];
      return read;
    });
    mocks.refreshWallets.mockRejectedValueOnce(new Error("wallet RPC unavailable"));
    const activities = [movement("confirmed")];
    const { result } = renderHook(() => useTreasuryBalances(activities));
    await act(async () => {});
    expect(result.current.walletsError).toBeInstanceOf(Error);
    expect(result.current.balanceOf(position)).toEqual({ value: undefined, syncing: true });
    expect(result.current.balanceOf(unrelated)).toEqual({ value: "10", syncing: false });
    expect(result.current.balancesRefreshing).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mocks.refreshWallets.mock.calls).toEqual([
      [101, ["wallet"]],
      [101, ["wallet"]],
    ]);
    expect(result.current.walletsError).toBeUndefined();
    expect(result.current.balanceOf(position)).toEqual({ value: "10", syncing: false });
    expect(result.current.balancesRefreshing).toBe(false);
  });

  it.each([true, false])(
    "scopes a provisional deposit using intent metadata or the returned position (intent=%s)",
    async (hasIntent) => {
      mocks.positions = [];
      const activity = movement("confirmed");
      if (hasIntent) activity.movement.custodyWalletId = position.custodyWalletId;
      mocks.refreshPositions.mockResolvedValue({
        positions: hasIntent ? [] : [position],
        afterMovementIds: ["movement"],
        minimumSlot: 101,
        startedAt: 11,
        landedAt: 12,
      });
      const activities = [activity];
      renderHook(() => useTreasuryBalances(activities));
      await waitFor(() => expect(mocks.refreshWallets).toHaveBeenCalledWith(101, ["wallet"]));
      expect(mocks.refreshWallets).toHaveBeenCalledTimes(1);
    }
  );

  it("waits for an unknown movement wallet instead of making its slot a global bound", async () => {
    mocks.positions = [];
    const activities = [movement("confirmed")];
    const { result } = renderHook(() => useTreasuryBalances(activities));
    await waitFor(() => expect(result.current.walletsError).toBeInstanceOf(Error));
    expect(mocks.refreshWallets).not.toHaveBeenCalled();
    expect(result.current.balanceOf(position).syncing).toBe(true);
    mocks.positions = [position];
    await act(async () => {
      await result.current.refresh();
    });
    expect(mocks.refreshWallets).toHaveBeenCalledWith(101, ["wallet"]);
    expect(result.current.walletsError).toBeUndefined();
  });

  it("keeps a failed newer confirmation gated when an older wallet read finishes late", async () => {
    let finishOld: () => void = () => {};
    mocks.refreshWallets
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishOld = resolve;
          })
      )
      .mockRejectedValueOnce(new Error("new wallet read failed"));
    let activities = [movement("confirmed")];
    const { result, rerender } = renderHook(() => useTreasuryBalances(activities));
    await waitFor(() => expect(mocks.refreshWallets).toHaveBeenCalledTimes(1));
    activities = [
      ...activities,
      {
        kind: "deposit",
        movement: {
          ...movement("confirmed").movement,
          movementId: "second-movement",
          observedOrder: 2,
        },
      },
    ];
    rerender();
    await waitFor(() => expect(result.current.walletsError).toBeInstanceOf(Error));
    await act(async () => finishOld());
    expect(result.current.balanceOf(position).syncing).toBe(true);
    expect(result.current.balancesRefreshing).toBe(true);
    expect(result.current.walletsError).toBeInstanceOf(Error);
  });
});

it("keeps retries within the API limit after more than 100 confirmations in one session", async () => {
  vi.useFakeTimers();
  const observed: VaultActivity[] = [];
  let activities: VaultActivity[] = [];
  mocks.refreshPositions.mockImplementation(async (ids: readonly string[]) => {
    if (ids.length > 100) throw new Error("API movement limit exceeded");
    const read = {
      positions: [position],
      afterMovementIds: ids,
      minimumSlot: 101,
      startedAt: 11,
      landedAt: 12,
    };
    mocks.reads = [read];
    return read;
  });
  const { result, rerender } = renderHook(() => useTreasuryBalances(activities));
  for (let index = 0; index < 120; index += 1) {
    observed.push({
      kind: "deposit",
      movement: {
        ...movement("confirmed").movement,
        movementId: `movement-${index}`,
        observedOrder: index,
      },
    });
    // Same bounded history maintained by Treasury's deposit watch list.
    activities = observed.slice(-50);
    await act(async () => rerender());
  }
  mocks.refreshWallets.mockRejectedValueOnce(new Error("temporary wallet failure"));
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.walletsError).toBeInstanceOf(Error);
  expect(result.current.balanceOf(position).syncing).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  const expected = activities.map(({ movement }) => movement.movementId);
  expect(mocks.refreshPositions).toHaveBeenLastCalledWith(expected);
  expect(mocks.refreshPositions.mock.calls.every(([ids]) => ids.length <= 100)).toBe(true);
  expect(result.current.walletsError).toBeUndefined();
  expect(result.current.balanceOf(position)).toEqual({ value: "10", syncing: false });
  expect(result.current.balancesRefreshing).toBe(false);
});

it("retains an unpaired holding after its movement leaves visible activity", async () => {
  vi.useFakeTimers();
  const other = { ...position, id: "other", custodyWalletId: "other-wallet" };
  mocks.positions = [position, other];
  mocks.refreshPositions.mockImplementation(async (ids: readonly string[]) => {
    const read = {
      positions: mocks.positions,
      startedAt: 11,
      landedAt: 12,
      afterMovementIds: ids,
      minimumSlot: 101,
    };
    mocks.reads = [read];
    return read;
  });
  mocks.refreshWallets.mockRejectedValue(new Error("wallet read unavailable"));
  let activities = [movement("confirmed")];
  const { result, rerender } = renderHook(() => useTreasuryBalances(activities));
  await act(async () => {});
  activities = Array.from({ length: 50 }, (_, index) => ({
    kind: "deposit" as const,
    movement: {
      ...movement("confirmed").movement,
      movementId: `new-${index}`,
      positionId: other.id,
      observedOrder: index + 2,
    },
  }));
  await act(async () => rerender());
  expect(result.current.balanceOf(position)).toEqual({ value: undefined, syncing: true });
  expect(mocks.refreshPositions.mock.lastCall?.[0]).toContain("movement");
  mocks.refreshWallets.mockResolvedValue([]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(mocks.refreshWallets).toHaveBeenLastCalledWith(101, ["wallet", "other-wallet"]);
  expect(result.current.balanceOf(position)).toEqual({ value: "10", syncing: false });
  expect(result.current.balanceOf(other)).toEqual({ value: "10", syncing: false });
  expect(result.current.walletsError).toBeUndefined();
});

it("recovers more than 100 outstanding pairs through bounded HTTP reads", async () => {
  vi.useFakeTimers();
  const { readEarnVaultPositions } = await vi.importActual<
    typeof import("../earn/earn-program-data")
  >("../earn/earn-program-data");
  const batchSizes: number[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const ids =
        new URL(input, "https://example.test").searchParams.get("afterMovementIds")?.split(",") ??
        [];
      batchSizes.push(ids.length);
      if (ids.length > 100) return Response.json({}, { status: 400 });
      return Response.json({
        data: {
          positions: [position],
          hasMore: false,
          nextCursor: null,
          balanceReadContext: { afterMovementIds: ids, minimumSlot: 101 },
        },
      });
    })
  );
  mocks.refreshPositions.mockImplementation(
    async (ids: readonly string[], positionIds?: ReadonlyMap<string, string>) => {
      const read = await readEarnVaultPositions(ids, positionIds);
      mocks.reads = [read];
      return read;
    }
  );
  mocks.refreshWallets.mockRejectedValue(new Error("sustained wallet read failure"));
  const all: VaultActivity[] = [];
  let activities: VaultActivity[] = [];
  const { result, rerender } = renderHook(() => useTreasuryBalances(activities));
  for (let index = 0; index < 120; index += 1) {
    all.push({
      kind: "deposit",
      movement: {
        ...movement("confirmed").movement,
        movementId: `movement-${index}`,
        observedOrder: index,
      },
    });
    activities = all.slice(-50);
    await act(async () => rerender());
  }
  expect(result.current.balanceOf(position).syncing).toBe(true);
  expect(mocks.refreshPositions.mock.lastCall?.[0]).toHaveLength(120);
  mocks.refreshWallets.mockResolvedValue([]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(batchSizes.every((count) => count <= 100)).toBe(true);
  expect(batchSizes.slice(-2)).toEqual([100, 20]);
  expect(mocks.reads.at(-1)?.afterMovementIds).toHaveLength(120);
  expect(result.current.walletsError).toBeUndefined();
  expect(result.current.balanceOf(position)).toEqual({ value: "10", syncing: false });
  expect(result.current.balancesRefreshing).toBe(false);
});
