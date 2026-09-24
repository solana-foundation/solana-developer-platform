import { describe, expect, it } from "vitest";
import {
  applyVaultMovement,
  createVaultBalanceProjection,
  displayedVaultBalance,
  isVaultProjectionReflected,
  observeVaultMovementCommit,
  type ProjectedVaultMovement,
  pendingVaultProjections,
  type VaultActivity,
  vaultActivities,
} from "./treasury-vault-balance-projection";

const COMMITTED_AT = 1_700_000_000_000;

function movement(overrides: Partial<ProjectedVaultMovement> = {}): ProjectedVaultMovement {
  return {
    movementId: "earn_movement_1",
    positionId: "earn_vault_position_live",
    status: "confirmed",
    observedOrder: 1,
    balanceProjection: { amount: "10", baselineValue: "125.25" },
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

describe("isVaultProjectionReflected", () => {
  it("requires a live read that started strictly after the commit was seen", () => {
    const committed = movement();
    expect(isVaultProjectionReflected(committed, undefined)).toBe(false);
    expect(isVaultProjectionReflected(committed, COMMITTED_AT - 1)).toBe(false);
    expect(isVaultProjectionReflected(committed, COMMITTED_AT)).toBe(false);
    expect(isVaultProjectionReflected(committed, COMMITTED_AT + 1)).toBe(true);
    expect(
      isVaultProjectionReflected(movement({ committedObservedAt: undefined }), COMMITTED_AT + 1)
    ).toBe(false);
  });
});

describe("pendingVaultProjections", () => {
  it("keeps committed, projected, unreflected movements of the position, oldest first", () => {
    const activities = [
      deposit({ movementId: "later", observedOrder: 3 }),
      deposit({ movementId: "submitted", status: "submitted", committedObservedAt: undefined }),
      deposit({ movementId: "unprojected", balanceProjection: undefined }),
      deposit({ movementId: "reflected", committedObservedAt: COMMITTED_AT - 10 }),
      deposit({
        movementId: "other-position",
        observedOrder: 4,
        positionId: "earn_vault_position_other",
      }),
      withdrawal({ movementId: "earlier", status: "finalized", observedOrder: 2 }),
    ];

    expect(
      pendingVaultProjections(activities, COMMITTED_AT - 5, "earn_vault_position_live").map(
        ({ movement: { movementId } }) => movementId
      )
    ).toEqual(["earlier", "later"]);
    expect(
      pendingVaultProjections(activities, COMMITTED_AT - 5).map(
        ({ movement: { movementId } }) => movementId
      )
    ).toEqual(["earlier", "later", "other-position"]);
  });

  it("treats a missing live read as one that predates every commit", () => {
    expect(pendingVaultProjections([deposit()], undefined)).toHaveLength(1);
  });
});

describe("displayedVaultBalance", () => {
  it("shows the live value when nothing is pending", () => {
    expect(displayedVaultBalance("125.25", [])).toEqual({ value: "125.25", projected: false });
    expect(displayedVaultBalance(undefined, [])).toEqual({ value: undefined, projected: false });
  });

  it("anchors on the oldest pending baseline, never on a live value that may already include the movement", () => {
    // Veda's redeemable value lands a hair under baseline + amount; adding the
    // amount to it again is the double count this module exists to prevent.
    expect(displayedVaultBalance("135.249985", [deposit()])).toEqual({
      value: "135.25",
      projected: true,
    });
  });

  it("applies every pending movement in observed order", () => {
    const pending = [
      deposit({ observedOrder: 1 }),
      withdrawal({
        observedOrder: 2,
        balanceProjection: { amount: "6", baselineValue: "135.25" },
      }),
    ];
    expect(displayedVaultBalance("135.25", pending)).toEqual({ value: "129.25", projected: true });
  });

  it("reports an unknown projected value rather than a fabricated one", () => {
    expect(
      displayedVaultBalance("125.25", [
        deposit({ balanceProjection: { amount: "ten", baselineValue: "125.25" } }),
      ])
    ).toEqual({ value: undefined, projected: true });
  });
});

describe("applyVaultMovement", () => {
  it("adds and subtracts at the wider scale and floors an exit at zero", () => {
    expect(applyVaultMovement("125.25", "10.123456", "deposit")).toBe("135.373456");
    expect(applyVaultMovement("125.25", "6", "withdrawal")).toBe("119.25");
    expect(applyVaultMovement("5", "6", "withdrawal")).toBe("0");
    expect(applyVaultMovement("abc", "6", "withdrawal")).toBeUndefined();
  });
});

describe("createVaultBalanceProjection", () => {
  it("needs a decimal baseline and amount", () => {
    expect(createVaultBalanceProjection(undefined, "10")).toBeUndefined();
    expect(createVaultBalanceProjection("125.25", "ten")).toBeUndefined();
    expect(createVaultBalanceProjection("125.25", "10")).toEqual({
      amount: "10",
      baselineValue: "125.25",
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
