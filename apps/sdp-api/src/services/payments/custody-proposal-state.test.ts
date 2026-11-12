import {
  CUSTODY_PROPOSAL_ABSENCE_HORIZON_MS,
  CUSTODY_PROPOSAL_OBSERVED_PHASES,
  type CustodyProposalEvent,
  type CustodyProposalState,
  canRequestCustodyProposalCancellation,
  createCustodyProposalState,
  custodyProposalEventSchema,
  custodyProposalStateSchema,
  hasUnalertedCustodyProposalRefusal,
  isCancellableCustodyProposalPhase,
  isTerminalCustodyProposalPhase,
  transitionCustodyProposal,
} from "@sdp/types/custody-proposals";
import { describe, expect, it } from "vitest";

const START = "2026-11-12T12:00:00.000Z";
const LATER = "2026-11-12T12:01:00.000Z";
const LAST = "2026-11-12T12:02:00.000Z";
const RETRY = "2026-11-12T12:06:00.000Z";

type Observation = Extract<CustodyProposalEvent, { type: "observed" }>;

function apply(state: CustodyProposalState, event: CustodyProposalEvent) {
  const result = transitionCustodyProposal(state, event);
  if ("rejected" in result) throw new Error(result.rejected);
  return result;
}

function observation(phase: Observation["phase"], at: string): Observation {
  return {
    type: "observed",
    at,
    phase,
    providerTransactionId: "provider-transaction-1",
    providerStatus: phase,
    providerSubStatus: null,
  };
}

function submitting() {
  return apply(createCustodyProposalState(), { type: "submission_claimed", at: START }).next;
}

function pending() {
  return apply(submitting(), observation("pending", START)).next;
}

function refused() {
  return apply(pending(), {
    type: "admission_refused",
    at: LATER,
    reason: "principal_revoked",
    message: "The initiating key was revoked",
  }).next;
}

function requested() {
  return apply(refused(), { type: "cancel_requested", at: LATER }).next;
}

describe("custody proposal state transitions", () => {
  it("claims submission once and never turns a definitive pre-send refusal into a retry", () => {
    const claimed = submitting();
    expect(claimed.submissionStartedAt).toBe(START);
    expect(transitionCustodyProposal(claimed, { type: "submission_claimed", at: LATER })).toEqual({
      rejected: "Submission is already claimed",
    });
    const result = apply(claimed, {
      type: "submission_refused",
      at: LATER,
      error: "Admission refused before provider submission",
    });
    expect(result.next.providerPhase).toBe("not_sent");
    expect(result.effects).toEqual([
      { type: "payment_status", status: "failed" },
      { type: "close_audit_intent", outcome: "failure" },
    ]);
    expect(transitionCustodyProposal(result.next, observation("pending", LAST))).toHaveProperty(
      "rejected"
    );
  });

  it("records a proven pre-send refusal without inventing a provider submission", () => {
    const stopped = apply(createCustodyProposalState(), {
      type: "submission_refused",
      at: START,
      error: "Request stopped before it could submit",
    });
    expect(stopped.next.providerPhase).toBe("not_sent");
    expect(stopped.next.submissionStartedAt).toBeNull();
    expect(stopped.next.providerTransactionId).toBeNull();
    expect(stopped.effects).toEqual([
      { type: "payment_status", status: "failed" },
      { type: "close_audit_intent", outcome: "failure" },
    ]);
  });

  it("accepts definite pre-send refusal after an overlapping absent read, never after acceptance", () => {
    const absent = apply(submitting(), { type: "observed_absent", at: LATER }).next;
    const refusedBeforeSend = apply(absent, {
      type: "submission_refused",
      at: LAST,
      error: "The original admission check proves no provider request was sent",
    });
    expect(refusedBeforeSend.next.providerPhase).toBe("not_sent");
    expect(refusedBeforeSend.effects).toEqual([
      { type: "payment_status", status: "failed" },
      { type: "close_audit_intent", outcome: "failure" },
    ]);
    for (const phase of CUSTODY_PROPOSAL_OBSERVED_PHASES) {
      const accepted = apply(submitting(), observation(phase, LATER)).next;
      expect(
        transitionCustodyProposal(accepted, {
          type: "submission_refused",
          at: LAST,
          error: "Cannot undo an accepted transaction",
        })
      ).toHaveProperty("rejected");
    }
  });

  it("quarantines an unclaimed proposal after authenticated absence without authorizing another send", () => {
    const missing = apply(createCustodyProposalState(), {
      type: "observed_absent",
      at: START,
    });
    expect(missing.next).toMatchObject({
      providerPhase: "absent",
      submissionStartedAt: null,
      firstMissingAt: START,
    });
    expect(missing.effects).toEqual([]);
    expect(
      transitionCustodyProposal(missing.next, { type: "submission_claimed", at: LATER })
    ).toHaveProperty("rejected");
    const expired = apply(missing.next, {
      type: "observed_absent",
      at: new Date(Date.parse(START) + CUSTODY_PROPOSAL_ABSENCE_HORIZON_MS).toISOString(),
    });
    expect(expired.next.providerPhase).toBe("never_accepted");
    expect(expired.effects).toEqual([
      { type: "payment_status", status: "failed" },
      { type: "close_audit_intent", outcome: "failure" },
    ]);
    expect(
      transitionCustodyProposal(expired.next, { type: "submission_claimed", at: LAST })
    ).toHaveProperty("rejected");
  });

  it.each(CUSTODY_PROPOSAL_OBSERVED_PHASES)(
    "records a validated %s receipt despite a missing local claim, without permitting resubmission",
    (phase) => {
      // The provider adapter validates binding and exact settlement before this boundary.
      const recorded = apply(createCustodyProposalState(), observation(phase, START));
      expect(recorded.next.providerPhase).toBe(phase);
      expect(recorded.next.providerTransactionId).toBe("provider-transaction-1");
      expect(recorded.next.authorizationState).toBe("authorized");
      expect(recorded.next.refusal).toBeNull();
      expect(
        transitionCustodyProposal(recorded.next, { type: "submission_claimed", at: LATER })
      ).toHaveProperty("rejected");
    }
  );

  it("requires a second absent read across the horizon, measured from the first absence", () => {
    const firstAt = "2026-11-13T12:00:00.000Z";
    const first = apply(submitting(), { type: "observed_absent", at: firstAt });
    expect(first.next.providerPhase).toBe("absent");
    expect(first.effects).toEqual([]);
    const nearHorizon = new Date(
      Date.parse(firstAt) + CUSTODY_PROPOSAL_ABSENCE_HORIZON_MS - 1
    ).toISOString();
    expect(apply(first.next, { type: "observed_absent", at: nearHorizon }).next.providerPhase).toBe(
      "absent"
    );
    const atHorizon = new Date(
      Date.parse(firstAt) + CUSTODY_PROPOSAL_ABSENCE_HORIZON_MS
    ).toISOString();
    const expired = apply(first.next, { type: "observed_absent", at: atHorizon });
    expect(expired.next.providerPhase).toBe("never_accepted");
    expect(expired.effects).toEqual([
      { type: "payment_status", status: "failed" },
      { type: "close_audit_intent", outcome: "failure" },
    ]);
    expect(
      transitionCustodyProposal(expired.next, { type: "submission_claimed", at: atHorizon })
    ).toHaveProperty("rejected");
  });

  it("never expires a known accepted transaction, even when the provider stops finding it", () => {
    const known = pending();
    const missing = apply(known, {
      type: "observed_absent",
      at: "2027-01-01T00:00:00.000Z",
    });
    expect(missing).toEqual({ next: known, effects: [] });
    expect(missing.next.firstMissingAt).toBeNull();
  });

  it("clears an ambiguous absence when the accepted provider transaction is discovered", () => {
    const absent = apply(submitting(), { type: "observed_absent", at: LATER }).next;
    const accepted = apply(absent, observation("pending", LAST)).next;
    expect(accepted.firstMissingAt).toBeNull();
    expect(accepted.providerTransactionId).toBe("provider-transaction-1");
    expect(
      transitionCustodyProposal(accepted, { type: "submission_refused", at: LAST, error: "x" })
    ).toHaveProperty("rejected");
  });

  it("refuses provider identity replacement before applying any observation", () => {
    for (const phase of CUSTODY_PROPOSAL_OBSERVED_PHASES) {
      expect(
        transitionCustodyProposal(pending(), {
          ...observation(phase, LATER),
          providerTransactionId: "another-transaction",
        })
      ).toEqual({ rejected: "Provider transaction identity changed" });
    }
  });

  it.each(CUSTODY_PROPOSAL_OBSERVED_PHASES.filter(isTerminalCustodyProposalPhase))(
    "does not reopen or duplicate settlement after %s",
    (phase) => {
      const terminal = apply(pending(), observation(phase, LATER));
      expect(isTerminalCustodyProposalPhase(terminal.next.providerPhase)).toBe(true);
      expect(apply(terminal.next, observation(phase, LAST))).toEqual({
        next: terminal.next,
        effects: [],
      });
      for (const nextPhase of CUSTODY_PROPOSAL_OBSERVED_PHASES) {
        if (nextPhase === phase) continue;
        expect(
          transitionCustodyProposal(terminal.next, observation(nextPhase, LAST))
        ).toHaveProperty("rejected");
      }
      expect(
        transitionCustodyProposal(terminal.next, { type: "observed_absent", at: LAST })
      ).toHaveProperty("rejected");
    }
  );

  it("keeps the first authority refusal and its attribution across repeated checks", () => {
    const first = refused();
    const repeated = apply(first, {
      type: "admission_refused",
      at: LAST,
      reason: "member_removed",
      message: "Different later refusal",
    });
    expect(repeated).toEqual({ next: first, effects: [] });
    expect(first.refusal).toEqual({
      at: LATER,
      reason: "principal_revoked",
      message: "The initiating key was revoked",
    });
  });

  it("accepts a fresh cancellable status after an unknown executing status without restoring authority", () => {
    const unknown = apply(refused(), observation("executing", LATER)).next;
    const cancellable = apply(unknown, observation("pending", LAST)).next;
    expect(cancellable.authorizationState).toBe("refused");
    expect(cancellable.refusal).toEqual(refused().refusal);
    expect(canRequestCustodyProposalCancellation(cancellable, LAST)).toBe(true);
  });

  it("does not invent a refusal after executing or completed observations", () => {
    for (const phase of CUSTODY_PROPOSAL_OBSERVED_PHASES.filter(
      (candidate) => !isCancellableCustodyProposalPhase(candidate)
    )) {
      const state = apply(pending(), observation(phase, LATER)).next;
      expect(
        transitionCustodyProposal(state, {
          type: "admission_refused",
          at: LAST,
          reason: "principal_revoked",
          message: "Revoked by the time this read finished",
        })
      ).toHaveProperty("rejected");
      expect(state.authorizationState).toBe("authorized");
      expect(state.refusal).toBeNull();
      expect(hasUnalertedCustodyProposalRefusal(state)).toBe(false);
    }
  });

  it("stages cancellation before provider I/O and retries ambiguity without duplicate audit", () => {
    expect(canRequestCustodyProposalCancellation(pending(), LATER)).toBe(false);
    expect(
      transitionCustodyProposal(pending(), { type: "cancel_requested", at: LATER })
    ).toHaveProperty("rejected");
    const staged = apply(refused(), { type: "cancel_requested", at: LATER });
    expect(staged.effects).toEqual([
      { type: "audit", event: "proposal_cancellation_requested" },
      { type: "request_cancel" },
    ]);
    expect(canRequestCustodyProposalCancellation(staged.next, LAST)).toBe(false);
    expect(
      transitionCustodyProposal(staged.next, { type: "cancel_requested", at: LAST })
    ).toHaveProperty("rejected");
    expect(canRequestCustodyProposalCancellation(staged.next, "2026-11-12T12:05:59.999Z")).toBe(
      false
    );
    expect(canRequestCustodyProposalCancellation(staged.next, RETRY)).toBe(true);
    const retry = apply(staged.next, { type: "cancel_requested", at: RETRY });
    expect(retry.next.cancelRequestedAt).toBe(RETRY);
    expect(retry.effects).toEqual([{ type: "request_cancel" }]);
    expect(canRequestCustodyProposalCancellation(retry.next, RETRY)).toBe(false);
  });

  it("does not settle or close the payment when cancellation is acknowledged", () => {
    const accepted = apply(requested(), { type: "cancel_accepted", at: LAST });
    expect(accepted.next.providerPhase).toBe("pending");
    expect(accepted.next.authorizationState).toBe("cancel_acknowledged");
    expect(accepted.effects).toEqual([{ type: "audit", event: "proposal_cancellation_accepted" }]);
    expect(canRequestCustodyProposalCancellation(accepted.next, RETRY)).toBe(false);
    expect(apply(accepted.next, { type: "cancel_accepted", at: LAST }).effects).toEqual([]);
    expect(
      transitionCustodyProposal(accepted.next, { type: "cancel_requested", at: LAST })
    ).toHaveProperty("rejected");
    const cancelled = apply(accepted.next, observation("cancelled", LAST));
    expect(cancelled.effects).toEqual([
      { type: "payment_status", status: "failed" },
      { type: "close_audit_intent", outcome: "failure" },
    ]);
    expect(hasUnalertedCustodyProposalRefusal(cancelled.next)).toBe(false);
  });

  it("retains refusal after a declined cancellation and permits a later staged attempt", () => {
    const declined = apply(requested(), { type: "cancel_declined", at: LAST });
    expect(declined.next.providerPhase).toBe("pending");
    expect(declined.next.authorizationState).toBe("refused");
    expect(declined.next.refusal).toEqual(refused().refusal);
    expect(declined.next.cancelDeclinedAt).toBe(LAST);
    expect(declined.effects).toEqual([{ type: "audit", event: "proposal_cancellation_declined" }]);
    expect(canRequestCustodyProposalCancellation(declined.next, LAST)).toBe(false);
    expect(
      transitionCustodyProposal(declined.next, { type: "cancel_requested", at: LAST })
    ).toHaveProperty("rejected");
    const retry = apply(declined.next, { type: "cancel_requested", at: RETRY });
    expect(retry.next.cancelRequestedAt).toBe(RETRY);
    expect(retry.effects).toEqual([{ type: "request_cancel" }]);
  });

  it("audits the first definitive decline after ambiguous attempts, then retains it through retries", () => {
    // The first call had no definitive result; its retry must not hide the first decline.
    const ambiguous = requested();
    expect(ambiguous.cancelDeclinedAt).toBeNull();
    const retry = apply(ambiguous, { type: "cancel_requested", at: RETRY });
    expect(retry.effects).toEqual([{ type: "request_cancel" }]);
    const declined = apply(retry.next, { type: "cancel_declined", at: RETRY });
    expect(declined.next.cancelDeclinedAt).toBe(RETRY);
    expect(declined.effects).toEqual([{ type: "audit", event: "proposal_cancellation_declined" }]);
    expect(declined.next.refusal).toEqual(ambiguous.refusal);

    const executing = apply(declined.next, observation("executing", RETRY)).next;
    const cancellable = apply(executing, observation("pending", RETRY)).next;
    expect(cancellable.cancelDeclinedAt).toBe(RETRY);
    expect(canRequestCustodyProposalCancellation(cancellable, RETRY)).toBe(false);
    const laterAt = "2026-11-12T12:11:00.000Z";
    const staged = apply(cancellable, { type: "cancel_requested", at: laterAt });
    expect(staged.next.cancelRequestedAt).toBe(laterAt);
    expect(staged.effects).toEqual([{ type: "request_cancel" }]);
    const repeated = apply(staged.next, { type: "cancel_declined", at: laterAt });
    expect(repeated.next.cancelDeclinedAt).toBe(RETRY);
    expect(repeated.next.refusal).toEqual(ambiguous.refusal);
    expect(repeated.next.authorizationState).toBe("refused");
    expect(repeated.effects).toEqual([]);
    expect(canRequestCustodyProposalCancellation(repeated.next, laterAt)).toBe(false);
    expect(apply(repeated.next, observation("completed", laterAt)).next.authorizationState).toBe(
      "committed_after_refusal"
    );
  });

  it("stages a critical alert only for completion after an already durable refusal", () => {
    const committed = apply(requested(), observation("completed", LAST));
    expect(committed.next.authorizationState).toBe("committed_after_refusal");
    expect(committed.effects).toEqual([
      { type: "payment_status", status: "confirmed" },
      { type: "close_audit_intent", outcome: "success" },
      { type: "raise_critical" },
    ]);
    expect(hasUnalertedCustodyProposalRefusal(committed.next)).toBe(true);
    expect(apply(committed.next, observation("completed", LAST)).effects).toEqual([]);
    expect(
      transitionCustodyProposal(committed.next, { type: "cancel_accepted", at: LAST })
    ).toHaveProperty("rejected");
    const delivered = apply(committed.next, { type: "alert_delivered", at: LAST });
    expect(delivered.effects).toEqual([{ type: "audit", event: "proposal_refusal_alerted" }]);
    expect(hasUnalertedCustodyProposalRefusal(delivered.next)).toBe(false);
    expect(apply(delivered.next, { type: "alert_delivered", at: LAST }).effects).toEqual([]);
  });

  it("cannot acknowledge a cancellation or critical alert without its durable prerequisite", () => {
    expect(
      transitionCustodyProposal(refused(), { type: "cancel_accepted", at: LAST })
    ).toHaveProperty("rejected");
    expect(
      transitionCustodyProposal(refused(), { type: "cancel_declined", at: LAST })
    ).toHaveProperty("rejected");
    const completed = apply(pending(), observation("completed", LATER)).next;
    expect(
      transitionCustodyProposal(completed, { type: "alert_delivered", at: LAST })
    ).toHaveProperty("rejected");
  });

  it("never mutates the input state or nested refusal while producing a transition", () => {
    const state = refused();
    Object.freeze(state.refusal);
    Object.freeze(state);
    const next = apply(state, observation("completed", LAST)).next;
    expect(state.providerPhase).toBe("pending");
    expect(state.authorizationState).toBe("refused");
    expect(next).not.toBe(state);
    expect(custodyProposalStateSchema.parse(next)).toEqual(next);
  });

  it("rejects malformed persisted state and external event data at their schemas", () => {
    expect(
      custodyProposalStateSchema.safeParse({ ...pending(), providerPhase: "unknown" }).success
    ).toBe(false);
    expect(custodyProposalStateSchema.safeParse({ ...pending(), extra: true }).success).toBe(false);
    expect(
      custodyProposalEventSchema.safeParse({ type: "cancel_accepted", at: "yesterday" }).success
    ).toBe(false);
    expect(
      custodyProposalEventSchema.safeParse({ ...observation("completed", LAST), phase: "unknown" })
        .success
    ).toBe(false);
  });
});
