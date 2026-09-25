import { describe, expect, it } from "vitest";
import {
  anchorRead,
  applyVaultMovement,
  createVaultBalanceProjection,
  displayedVaultBalance,
  holdingInRead,
  isVaultProjectionReflected,
  observeVaultMovementCommit,
  type ProjectedVaultMovement,
  pendingVaultProjections,
  projectionBaseline,
  type VaultActivity,
  type VaultPositionsRead,
  vaultActivities,
} from "./treasury-vault-balance-projection";

const POSITION = "earn_vault_position_live";
const BASELINE_READ_STARTED_AT = 1_000;
const SUBMITTED_AT = 5_000;
const COMMITTED_AT = 10_000;

function read(
  overrides: Partial<VaultPositionsRead> & {
    shares?: string | undefined;
    value?: string | undefined;
  }
): VaultPositionsRead {
  const { shares: _shares, value: _value, ...rest } = overrides;
  // Explicit `undefined` must survive: a default parameter would swallow it.
  const shares = "shares" in overrides ? overrides.shares : "119.5";
  const value = "value" in overrides ? overrides.value : "125.25";
  return {
    startedAt: COMMITTED_AT + 1,
    landedAt: COMMITTED_AT + 2,
    positions: [{ id: POSITION, shares, tokenValue: value }],
    ...rest,
  };
}

function movement(overrides: Partial<ProjectedVaultMovement> = {}): ProjectedVaultMovement {
  return {
    movementId: "earn_movement_1",
    positionId: POSITION,
    status: "confirmed",
    observedOrder: 1,
    balanceProjection: {
      amount: "10",
      baseline: { startedAt: BASELINE_READ_STARTED_AT, shares: "119.5" },
    },
    submittedAt: SUBMITTED_AT,
    committedObservedAt: COMMITTED_AT,
    ...overrides,
  };
}

function deposit(overrides: Partial<ProjectedVaultMovement> = {}): VaultActivity {
  return { kind: "deposit", movement: movement(overrides) };
}

function withdrawal(overrides: Partial<ProjectedVaultMovement> = {}): VaultActivity {
  return { kind: "withdrawal", movement: movement(overrides) };
}

/** A read started before the commit was seen but already holding the movement. */
const earlyRead = (shares: string) =>
  read({ startedAt: COMMITTED_AT - 1, landedAt: COMMITTED_AT - 1, shares });

describe("observeVaultMovementCommit", () => {
  it("stamps the first sighting of a committed status and keeps it afterwards", () => {
    const submitted = movement({ status: "submitted", committedObservedAt: undefined });
    expect(observeVaultMovementCommit(submitted, 5).committedObservedAt).toBeUndefined();

    const confirmed = observeVaultMovementCommit({ ...submitted, status: "confirmed" }, 5);
    expect(confirmed.committedObservedAt).toBe(5);
    expect(observeVaultMovementCommit(confirmed, 9)).toBe(confirmed);
    expect(
      observeVaultMovementCommit({ ...confirmed, status: "finalized" }, 9).committedObservedAt
    ).toBe(5);
  });

  it("never stamps a failed movement", () => {
    const failed = movement({ status: "failed", committedObservedAt: undefined });
    expect(observeVaultMovementCommit(failed, 5).committedObservedAt).toBeUndefined();
  });
});

describe("holdingInRead and projectionBaseline", () => {
  it("reads an absent row as an exact zero holding", () => {
    expect(holdingInRead(read({}), "earn_vault_position_other")).toEqual({
      value: "0",
      shares: "0",
    });
    expect(holdingInRead(read({ value: undefined, shares: "1" }), POSITION)).toEqual({
      value: undefined,
      shares: "1",
    });
  });

  it("takes the baseline from the latest read that landed before the POST began", () => {
    const reads = [
      read({ startedAt: 100, landedAt: 200, shares: "100" }),
      read({ startedAt: 1_000, landedAt: 1_500, shares: "119.5" }),
      // Landed after the POST began: may already contain the movement.
      read({ startedAt: 4_000, landedAt: 5_500, shares: "129.5" }),
    ];
    expect(projectionBaseline(reads, POSITION, SUBMITTED_AT)).toEqual({
      startedAt: 1_000,
      shares: "119.5",
    });
    expect(projectionBaseline(reads, "earn_vault_position_other", SUBMITTED_AT)).toEqual({
      startedAt: 1_000,
      shares: "0",
    });
  });

  it("has no baseline without a hydrated pre-POST read, and then projects nothing", () => {
    expect(projectionBaseline([], POSITION, SUBMITTED_AT)).toBeUndefined();
    const unhydrated = read({ startedAt: 1_000, landedAt: 1_500, shares: undefined });
    expect(projectionBaseline([unhydrated], POSITION, SUBMITTED_AT)).toBeUndefined();
    expect(createVaultBalanceProjection("10", undefined)).toBeUndefined();
    expect(createVaultBalanceProjection("ten", { startedAt: 1, shares: "1" })).toBeUndefined();
    expect(createVaultBalanceProjection("10", { startedAt: 1, shares: "1" })).toEqual({
      amount: "10",
      baseline: { startedAt: 1, shares: "1" },
    });
  });
});

describe("isVaultProjectionReflected", () => {
  it("is never reflected before the chain commits", () => {
    const submitted = deposit({ status: "submitted", committedObservedAt: undefined });
    expect(isVaultProjectionReflected(submitted, read({ shares: "129.5" }), [])).toBe(false);
  });

  it("requires the shares to have moved off the baseline, however late the read started", () => {
    // A read issued after the commit but served by a lagging node.
    expect(isVaultProjectionReflected(deposit(), read({ shares: "119.5" }), [])).toBe(false);
    expect(isVaultProjectionReflected(deposit(), read({ shares: "129.5" }), [])).toBe(true);
  });

  it("counts a net move in either direction, so opposing movements cannot pin a projection", () => {
    // Baseline 119.5; this tab deposits and an unseen session withdraws more:
    // the read contains the deposit yet shows fewer shares. Requiring the
    // deposit's own direction would keep it pending over a value that already
    // holds it, for every later read of the settled holding.
    expect(isVaultProjectionReflected(deposit(), read({ shares: "100" }), [])).toBe(true);
    expect(isVaultProjectionReflected(withdrawal(), read({ shares: "129.5" }), [])).toBe(true);
  });

  it("retires a deposit and a larger withdrawal together once a read contains both", () => {
    const inflow = deposit({ movementId: "in", observedOrder: 1, committedObservedAt: 9_000 });
    const outflow = withdrawal({
      movementId: "out",
      observedOrder: 2,
      balanceProjection: {
        amount: "20",
        baseline: { startedAt: BASELINE_READ_STARTED_AT, shares: "119.5" },
      },
    });
    const settled = read({ shares: "109.5", value: "115.25" });
    expect(pendingVaultProjections([inflow, outflow], settled, POSITION)).toEqual([]);
    expect(displayedVaultBalance([settled], POSITION, [inflow, outflow])).toEqual({
      value: "115.25",
      projected: false,
    });
  });

  it("proves nothing from an unhydrated row", () => {
    expect(
      isVaultProjectionReflected(deposit(), read({ shares: undefined, value: undefined }), [])
    ).toBe(false);
  });

  it("attributes moved shares to the only movement that could have moved them", () => {
    // Started before the commit was seen, yet already contains it: the single
    // movement in flight is the only explanation, so it is reflected and can
    // never be added on top of the value again.
    const solo = deposit();
    expect(isVaultProjectionReflected(solo, earlyRead("129.5"), [solo])).toBe(true);
  });

  it("does not attribute moved shares while a sibling could explain them", () => {
    const first = deposit({ movementId: "first", observedOrder: 1, committedObservedAt: 9_000 });
    const second = deposit({ movementId: "second", observedOrder: 2 });
    expect(isVaultProjectionReflected(second, earlyRead("129.5"), [first, second])).toBe(false);
  });

  it("ignores siblings that failed, were submitted after the read landed, or predate the baseline", () => {
    const target = deposit();
    const failed = deposit({ movementId: "failed", status: "failed" });
    const later = deposit({ movementId: "later", submittedAt: COMMITTED_AT + 50 });
    const settledBefore = deposit({
      movementId: "settled-before",
      committedObservedAt: BASELINE_READ_STARTED_AT - 1,
    });
    const elsewhere = deposit({ movementId: "elsewhere", positionId: "earn_vault_position_other" });
    expect(
      isVaultProjectionReflected(target, earlyRead("129.5"), [
        target,
        failed,
        later,
        settledBefore,
        elsewhere,
      ])
    ).toBe(true);
  });
});

describe("pendingVaultProjections", () => {
  it("keeps committed, projected movements the read does not contain, oldest first", () => {
    const activities = [
      deposit({ movementId: "later", observedOrder: 3 }),
      deposit({ movementId: "submitted", status: "submitted", committedObservedAt: undefined }),
      deposit({ movementId: "unprojected", balanceProjection: undefined }),
      deposit({
        movementId: "other-position",
        observedOrder: 4,
        positionId: "earn_vault_position_other",
        balanceProjection: {
          amount: "10",
          baseline: { startedAt: BASELINE_READ_STARTED_AT, shares: "0" },
        },
      }),
      withdrawal({ movementId: "earlier", status: "finalized", observedOrder: 2 }),
    ];
    // Shares unchanged: nothing has landed yet.
    const stale = read({ shares: "119.5" });
    const ids = (pending: readonly VaultActivity[]) =>
      pending.map(({ movement: { movementId } }) => movementId);

    expect(ids(pendingVaultProjections(activities, stale, POSITION))).toEqual(["earlier", "later"]);
    expect(ids(pendingVaultProjections(activities, stale))).toEqual([
      "earlier",
      "later",
      "other-position",
    ]);
    expect(ids(pendingVaultProjections(activities, undefined, POSITION))).toEqual([
      "earlier",
      "later",
    ]);
  });
});

describe("anchorRead and displayedVaultBalance", () => {
  it("anchors on the latest read that valued the position", () => {
    const reads = [
      read({ startedAt: 1, landedAt: 2, value: "100" }),
      read({ startedAt: 3, landedAt: 4, value: undefined }),
    ];
    expect(anchorRead(reads, POSITION)?.startedAt).toBe(1);
    expect(anchorRead([], POSITION)).toBeUndefined();
  });

  it("shows the live value when nothing is pending", () => {
    expect(displayedVaultBalance([read({})], POSITION, [])).toEqual({
      value: "125.25",
      projected: false,
    });
    expect(displayedVaultBalance([], POSITION, [])).toEqual({ value: undefined, projected: false });
  });

  it("adds a committed movement a lagging read has not caught up with", () => {
    expect(displayedVaultBalance([read({ shares: "119.5" })], POSITION, [deposit()])).toEqual({
      value: "135.25",
      projected: true,
    });
  });

  it("never adds a movement the anchoring read already contains", () => {
    // Veda's redeemable value lands a hair under baseline + amount; the old
    // threshold rule added the amount on top of it again.
    const caughtUp = read({ shares: "129.5", value: "135.249985" });
    expect(displayedVaultBalance([caughtUp], POSITION, [deposit()])).toEqual({
      value: "135.249985",
      projected: false,
    });
  });

  it("keeps a retired sibling in the anchor while projecting the one still pending", () => {
    // Two deposits in flight; a read started between their commits contains
    // the first only. The second is added to THAT value, not to a stale one.
    const first = deposit({ movementId: "first", observedOrder: 1, committedObservedAt: 9_000 });
    const second = deposit({
      movementId: "second",
      observedOrder: 2,
      committedObservedAt: 11_000,
      balanceProjection: {
        amount: "5",
        baseline: { startedAt: BASELINE_READ_STARTED_AT, shares: "119.5" },
      },
    });
    const between = read({ startedAt: 10_000, landedAt: 10_500, shares: "129.5", value: "135.25" });
    expect(displayedVaultBalance([between], POSITION, [first, second])).toEqual({
      value: "140.25",
      projected: true,
    });
  });

  it("applies pending movements in observed order and floors an exit at zero", () => {
    const pending = [
      deposit({ observedOrder: 1 }),
      withdrawal({
        movementId: "exit",
        observedOrder: 2,
        balanceProjection: {
          amount: "6",
          baseline: { startedAt: BASELINE_READ_STARTED_AT, shares: "119.5" },
        },
      }),
    ];
    // Shares unchanged: both still pending.
    expect(displayedVaultBalance([read({ shares: "119.5" })], POSITION, pending)).toEqual({
      value: "129.25",
      projected: true,
    });
    expect(applyVaultMovement("5", "6", "withdrawal")).toBe("0");
    expect(applyVaultMovement("125.25", "10.123456", "deposit")).toBe("135.373456");
    expect(applyVaultMovement("abc", "6", "withdrawal")).toBeUndefined();
  });

  it("reports an unknown projected value rather than a fabricated one", () => {
    const malformed = deposit({
      balanceProjection: {
        amount: "ten",
        baseline: { startedAt: BASELINE_READ_STARTED_AT, shares: "119.5" },
      },
    });
    expect(displayedVaultBalance([read({ shares: "119.5" })], POSITION, [malformed])).toEqual({
      value: undefined,
      projected: true,
    });
  });
});

describe("vaultActivities", () => {
  it("labels each list with its kind", () => {
    const activities = vaultActivities(
      [movement({ movementId: "d" })],
      [movement({ movementId: "w" })]
    );
    expect(activities.map(({ kind, movement: { movementId } }) => `${kind}:${movementId}`)).toEqual(
      ["deposit:d", "withdrawal:w"]
    );
  });
});
