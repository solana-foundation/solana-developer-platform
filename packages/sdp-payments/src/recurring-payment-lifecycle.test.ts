import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideRecurringPaymentActivationTransition,
  decideRecurringPaymentLifecycleTransition,
  decideRecurringPaymentUpdateTransition,
  getRecurringPaymentLifecycleStatuses,
  getRecurringPaymentOperationStaleBefore,
  hasRecurringPaymentAdvancedPastDueAt,
  isRecurringPaymentCollectionActive,
  isRecurringPaymentOperationStale,
  nextRecurringPaymentCollectionDueAt,
  resolveRecurringPaymentCollectionSchedule,
} from "./recurring-payment-lifecycle";

const NOW = "2026-07-01T12:00:00.000Z";
const STALE = "2026-07-01T11:45:00.000Z";
const FRESH = "2026-07-01T11:45:00.001Z";

describe("recurring payment lifecycle transitions", () => {
  it("maps cancel and resume lifecycle statuses", () => {
    assert.deepEqual(getRecurringPaymentLifecycleStatuses("cancel"), {
      processingStatus: "canceling",
      claimableStatus: "active",
      finalStatus: "canceled",
    });
    assert.deepEqual(getRecurringPaymentLifecycleStatuses("resume"), {
      processingStatus: "resuming",
      claimableStatus: "canceled",
      finalStatus: "active",
    });
  });

  it("distinguishes claimable, finalized, fresh, and stale lifecycle work", () => {
    assert.equal(
      decideRecurringPaymentLifecycleTransition({
        operation: "cancel",
        status: "active",
        updatedAt: FRESH,
        nowIso: NOW,
      }),
      "claimable"
    );
    assert.equal(
      decideRecurringPaymentLifecycleTransition({
        operation: "cancel",
        status: "canceled",
        updatedAt: FRESH,
        nowIso: NOW,
      }),
      "already_final"
    );
    assert.equal(
      decideRecurringPaymentLifecycleTransition({
        operation: "resume",
        status: "resuming",
        updatedAt: FRESH,
        nowIso: NOW,
      }),
      "processing"
    );
    assert.equal(
      decideRecurringPaymentLifecycleTransition({
        operation: "resume",
        status: "resuming",
        updatedAt: STALE,
        nowIso: NOW,
      }),
      "recoverable"
    );
    assert.equal(
      decideRecurringPaymentLifecycleTransition({
        operation: "resume",
        status: "paused",
        updatedAt: FRESH,
        nowIso: NOW,
      }),
      "invalid"
    );
  });

  it("keeps activation and update eligibility separate", () => {
    assert.equal(
      decideRecurringPaymentActivationTransition({
        status: "pending_activation",
        updatedAt: FRESH,
        nowIso: NOW,
      }),
      "claimable"
    );
    assert.equal(
      decideRecurringPaymentActivationTransition({
        status: "activating",
        updatedAt: STALE,
        nowIso: NOW,
      }),
      "recoverable"
    );
    assert.equal(
      decideRecurringPaymentUpdateTransition({
        status: "active",
        updatedAt: FRESH,
        nowIso: NOW,
      }),
      "claimable"
    );
    assert.equal(
      decideRecurringPaymentUpdateTransition({
        status: "updating",
        updatedAt: FRESH,
        nowIso: NOW,
      }),
      "processing"
    );
    assert.equal(
      decideRecurringPaymentUpdateTransition({
        status: "canceling",
        updatedAt: FRESH,
        nowIso: NOW,
      }),
      "invalid"
    );
  });
});

describe("recurring payment schedule decisions", () => {
  it("uses a fifteen-minute inclusive stale boundary and ignores invalid timestamps", () => {
    assert.equal(getRecurringPaymentOperationStaleBefore(NOW), STALE);
    assert.equal(isRecurringPaymentOperationStale({ updatedAt: STALE, nowIso: NOW }), true);
    assert.equal(isRecurringPaymentOperationStale({ updatedAt: FRESH, nowIso: NOW }), false);
    assert.equal(isRecurringPaymentOperationStale({ updatedAt: "not-a-date", nowIso: NOW }), false);
  });

  it("calculates collection cadence without accepting an earlier requested due time", () => {
    const periodStartAt = "2026-07-01T10:00:00.000Z";
    assert.equal(
      nextRecurringPaymentCollectionDueAt(periodStartAt, 24),
      "2026-07-02T10:00:00.000Z"
    );
    assert.deepEqual(
      resolveRecurringPaymentCollectionSchedule({
        requested: "2026-07-02T09:59:59.999Z",
        periodStartAt,
        periodHours: 24,
      }),
      { kind: "too_early", minimumDueAt: "2026-07-02T10:00:00.000Z" }
    );
  });

  it("defaults to and can clamp the next eligible collection", () => {
    const input = {
      periodStartAt: "2026-07-01T10:00:00.000Z",
      periodHours: 24,
    };
    assert.deepEqual(resolveRecurringPaymentCollectionSchedule({ ...input, requested: null }), {
      kind: "scheduled",
      nextCollectionDueAt: "2026-07-02T10:00:00.000Z",
      minimumDueAt: "2026-07-02T10:00:00.000Z",
      clamped: false,
    });
    assert.deepEqual(
      resolveRecurringPaymentCollectionSchedule({
        ...input,
        requested: "2026-07-01T10:00:00.000Z",
        clampToMinimum: true,
      }),
      {
        kind: "scheduled",
        nextCollectionDueAt: "2026-07-02T10:00:00.000Z",
        minimumDueAt: "2026-07-02T10:00:00.000Z",
        clamped: true,
      }
    );
  });

  it("recognizes an advanced active schedule and active collection status", () => {
    assert.equal(
      hasRecurringPaymentAdvancedPastDueAt("2026-07-02T10:00:00.000Z", "2026-07-01T10:00:00.000Z"),
      true
    );
    assert.equal(
      hasRecurringPaymentAdvancedPastDueAt("2026-07-01T10:00:00.000Z", "not-a-date"),
      false
    );
    assert.equal(isRecurringPaymentCollectionActive("active"), true);
    assert.equal(isRecurringPaymentCollectionActive("canceled"), false);
  });
});
