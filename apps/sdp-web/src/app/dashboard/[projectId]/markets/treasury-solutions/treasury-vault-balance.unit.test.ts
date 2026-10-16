import { describe, expect, it } from "vitest";
import {
  displayedVaultBalance,
  observeVaultMovementCommit,
  pendingVaultBalanceReads,
  type VaultActivity,
  type VaultPositionsRead,
} from "./treasury-vault-balance";

const activity = (
  id = "deposit",
  at = 10,
  kind: VaultActivity["kind"] = "deposit"
): VaultActivity => ({
  kind,
  movement: {
    movementId: id,
    positionId: "position",
    status: "confirmed",
    observedOrder: at,
    committedObservedAt: at,
  },
});
const read = (
  at: number,
  value: string | undefined = "19.98",
  shares = "20",
  afterMovementIds: readonly string[] = []
): VaultPositionsRead => ({
  startedAt: at,
  landedAt: at + 1,
  afterMovementIds,
  positions: [{ id: "position", shares, tokenValue: value }],
});

describe("Treasury confirmed balances", () => {
  it("requires chain freshness acknowledgment even for a request begun after confirmation", () => {
    expect(displayedVaultBalance([read(5, "10")], "position", [activity()])).toEqual({
      value: undefined,
      syncing: true,
    });
    expect(displayedVaultBalance([read(11, "10")], "position", [activity()])).toEqual({
      value: undefined,
      syncing: true,
    });
    expect(
      displayedVaultBalance([read(11, "19.98", "20", ["deposit"])], "position", [activity()])
    ).toEqual({
      value: "19.98",
      syncing: false,
    });
  });
  it("waits for the last of three back-to-back same-vault confirmations", () => {
    const moves = [activity("one", 10), activity("two", 12), activity("three", 14)];
    expect(
      pendingVaultBalanceReads(moves, read(13, "29.96", "30", ["one", "two"])).map(
        ({ movement }) => movement.movementId
      )
    ).toEqual(["three"]);
    expect(
      displayedVaultBalance([read(13, "29.96", "30", ["one", "two"])], "position", moves)
    ).toEqual({
      value: undefined,
      syncing: true,
    });
    expect(
      displayedVaultBalance([read(15, "39.94", "40", ["one", "two", "three"])], "position", moves)
    ).toEqual({
      value: "39.94",
      syncing: false,
    });
  });
  it("accepts unchanged shares after offsetting transfers without inventing balance changes", () => {
    const moves = [activity("in"), activity("out", 12, "withdrawal")];
    expect(
      displayedVaultBalance([read(13, "9.98", "10", ["in", "out"])], "position", moves)
    ).toEqual({
      value: "9.98",
      syncing: false,
    });
  });
  it("keeps a newly confirmed transfer updating while its valuation is unavailable", () => {
    const unavailable = read(12, undefined, "20", ["deposit"]);
    unavailable.positions = [{ id: "position", shares: "20" }];
    expect(displayedVaultBalance([read(5, "10"), unavailable], "position", [activity()])).toEqual({
      value: undefined,
      syncing: true,
    });
  });
  it("retains an unrelated holding's last verified value through missing valuations", () => {
    const unavailable = read(12);
    unavailable.positions = [{ id: "position" }];
    expect(displayedVaultBalance([read(5, "10"), unavailable], "position", [])).toEqual({
      value: "10",
      syncing: false,
      lastVerifiedAt: 6,
    });
    expect(
      displayedVaultBalance([read(5, "10"), unavailable, read(15, "10.01")], "position", [])
    ).toEqual({
      value: "10.01",
      syncing: false,
    });
  });
  it("preserves an acknowledged balance through a later failed read, but not a new transfer", () => {
    const verified = read(11, "19.98", "20", ["deposit"]);
    const unavailable = {
      ...read(12),
      positions: [{ id: "position" }],
      afterMovementIds: ["deposit"],
    };
    expect(displayedVaultBalance([verified, unavailable], "position", [activity()])).toEqual({
      value: "19.98",
      syncing: false,
      lastVerifiedAt: 12,
    });
    expect(
      displayedVaultBalance([verified, unavailable], "position", [activity(), activity("next", 13)])
    ).toEqual({
      value: undefined,
      syncing: true,
    });
  });
  it("labels an HTTP revalidation failure instead of presenting cached data as live", () => {
    expect(
      displayedVaultBalance([read(5, "10")], "position", [], new Error("read failed"))
    ).toEqual({
      value: "10",
      syncing: false,
      lastVerifiedAt: 6,
    });
  });
  it("does not claim absent data is zero, but honors a successful read of a closed position", () => {
    expect(displayedVaultBalance([], "position", [])).toEqual({ value: undefined, syncing: false });
    expect(
      displayedVaultBalance(
        [{ startedAt: 12, landedAt: 13, afterMovementIds: ["deposit"], positions: [] }],
        "position",
        [activity()]
      )
    ).toEqual({ value: "0", syncing: false });
  });
  it("does not refresh forever when finality follows the same confirmation", () => {
    const submitted = {
      ...activity().movement,
      status: "submitted",
      committedObservedAt: undefined,
    };
    expect(observeVaultMovementCommit(submitted, 10)).toBe(submitted);
    const confirmed = observeVaultMovementCommit({ ...submitted, status: "confirmed" }, 10);
    expect(
      observeVaultMovementCommit({ ...confirmed, status: "finalized" }, 20).committedObservedAt
    ).toBe(10);
    expect(
      pendingVaultBalanceReads(
        [{ kind: "deposit", movement: { ...confirmed, status: "failed" } }],
        read(5)
      )
    ).toEqual([]);
  });
});
