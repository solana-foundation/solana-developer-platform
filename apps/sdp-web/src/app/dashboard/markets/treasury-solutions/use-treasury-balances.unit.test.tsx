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
  vi.clearAllMocks();
  mocks.error = undefined;
  mocks.positions = [position];
  mocks.reads = [{ positions: mocks.positions, startedAt: 1, landedAt: 2 }];
  mocks.refreshPositions.mockResolvedValue({ minimumSlot: 101 });
  mocks.refreshWallets.mockResolvedValue([]);
});
afterEach(cleanup);

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
