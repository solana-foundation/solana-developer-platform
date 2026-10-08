import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isCollectableRecurringPaymentStatus } from "@sdp/types";
import {
  decideRecurringPaymentActivationTransition,
  decideRecurringPaymentLifecycleTransition,
  decideRecurringPaymentUpdateTransition,
  firstRecurringPaymentDueAfter,
  getRecurringPaymentLifecycleStatuses,
  getRecurringPaymentOperationStaleBefore,
  hasRecurringPaymentAdvancedPastDueAt,
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
  it("uses a fifteen-minute inclusive stale boundary", () => {
    assert.equal(getRecurringPaymentOperationStaleBefore(NOW), STALE);
    assert.equal(isRecurringPaymentOperationStale({ updatedAt: STALE, nowIso: NOW }), true);
    assert.equal(isRecurringPaymentOperationStale({ updatedAt: FRESH, nowIso: NOW }), false);
  });

  it("skips to the first boundary after now without catching up elapsed periods", () => {
    const dueAt = "2026-07-01T10:00:00.000Z";
    // Exactly due: the next boundary, one period on.
    assert.equal(
      firstRecurringPaymentDueAfter(dueAt, 24, new Date(dueAt)),
      "2026-07-02T10:00:00.000Z"
    );
    // Three and a half periods late: lands after now, never at or before it.
    assert.equal(
      firstRecurringPaymentDueAfter(dueAt, 24, new Date("2026-07-04T22:00:00.000Z")),
      "2026-07-05T10:00:00.000Z"
    );
    // On a boundary: that boundary has elapsed, so the next one.
    assert.equal(
      firstRecurringPaymentDueAfter(dueAt, 24, new Date("2026-07-03T10:00:00.000Z")),
      "2026-07-04T10:00:00.000Z"
    );
    assert.throws(() => firstRecurringPaymentDueAfter(dueAt, 0, new Date(dueAt)));
  });

  it("calculates collection cadence without accepting an earlier requested due time", () => {
    const periodStartAt = "2026-07-01T10:00:00.000Z";
    assert.equal(
      nextRecurringPaymentCollectionDueAt(periodStartAt, 24),
      "2026-07-02T10:00:00.000Z"
    );
    assert.deepEqual(
      resolveRecurringPaymentCollectionSchedule({
        request: {
          kind: "requested",
          dueAt: "2026-07-02T09:59:59.999Z",
          clampToMinimum: false,
        },
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
    assert.deepEqual(
      resolveRecurringPaymentCollectionSchedule({ ...input, request: { kind: "next_period" } }),
      {
        kind: "scheduled",
        nextCollectionDueAt: "2026-07-02T10:00:00.000Z",
        minimumDueAt: "2026-07-02T10:00:00.000Z",
        clamped: false,
      }
    );
    assert.deepEqual(
      resolveRecurringPaymentCollectionSchedule({
        ...input,
        request: {
          kind: "requested",
          dueAt: "2026-07-01T10:00:00.000Z",
          clampToMinimum: true,
        },
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
    assert.equal(isCollectableRecurringPaymentStatus("active"), true);
    assert.equal(isCollectableRecurringPaymentStatus("canceled"), false);
  });
});
