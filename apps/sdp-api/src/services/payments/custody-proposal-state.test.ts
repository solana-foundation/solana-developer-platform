import {
  CUSTODY_PROPOSAL_ABSENCE_HORIZON_MS,
  CUSTODY_PROPOSAL_AUTHORIZATION_STATES,
  CUSTODY_PROPOSAL_MAX_CANCEL_ATTEMPT,
  CUSTODY_PROPOSAL_OBSERVED_PHASES,
  CUSTODY_PROPOSAL_PROVIDER_PHASE_PROPERTIES,
  CUSTODY_PROPOSAL_PROVIDER_PHASES,
  CUSTODY_PROPOSAL_VALID_AUTHORIZATION_STATES_BY_PHASE,
  type CustodyProposalAuthorizationState,
  type CustodyProposalEvent,
  type CustodyProposalProviderPhase,
  type CustodyProposalState,
  canRequestCustodyProposalCancellation,
  createCustodyProposalState,
  custodyProposalEventSchema,
  custodyProposalStateSchema,
  hasUnalertedCustodyProposalRefusal,
  isCancellableCustodyProposalPhase,
  isCustodyProposalCancellationInFlight,
  isMissingCustodyProposalPhase,
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

function productState(
  phase: CustodyProposalProviderPhase,
  authorization: CustodyProposalAuthorizationState
): CustodyProposalState {
  const state = {
    ...createCustodyProposalState(),
    providerPhase: phase,
    authorizationState: authorization,
  };
  if (CUSTODY_PROPOSAL_PROVIDER_PHASE_PROPERTIES[phase].identity === "required")
    state.providerTransactionId = "provider-transaction-1";
  if (isMissingCustodyProposalPhase(phase)) state.firstMissingAt = START;
  if (phase === "submitting") state.submissionStartedAt = START;
  if (authorization !== "authorized") state.refusal = refused().refusal;
  switch (authorization) {
    case "authorized":
    case "refused":
    case "committed_after_refusal":
      break;
    case "cancel_requested":
    case "cancel_ambiguous":
      state.cancelAttempt = 1;
      state.cancelRequestedAt = LATER;
      break;
    case "cancel_declined":
    case "cancel_retry_requested":
    case "cancel_retry_ambiguous":
      state.cancelAttempt = 2;
      state.cancelRequestedAt = LAST;
      state.cancelDeclinedAt = LATER;
      break;
    case "cancel_acknowledged":
      state.cancelAttempt = 1;
      state.cancelRequestedAt = LATER;
      state.cancelAcknowledgedAt = LAST;
      break;
    case "refusal_alerted":
      state.alertedAt = LAST;
      break;
    default: {
      const exhaustive: never = authorization;
      throw new Error(`Unexpected authorization state: ${String(exhaustive)}`);
    }
  }
  return state;
}

describe("custody proposal state transitions", () => {
  it("claims submission once and never turns a definitive pre-send refusal into a retry", () => {
    const claimed = submitting();
    expect(claimed.submissionStartedAt).toBe(START);
    expect(
      transitionCustodyProposal(claimed, { type: "submission_claimed", at: LATER })
    ).toHaveProperty("rejected");
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
  });

  const processing = [{ type: "payment_status", status: "processing" }] as const;
  const failed = [
    { type: "payment_status", status: "failed" },
    { type: "close_audit_intent", outcome: "failure" },
  ] as const;
  it.each([
    { phase: "pending", effects: processing },
    { phase: "executing", effects: processing },
    {
      phase: "completed",
      effects: [
        { type: "payment_status", status: "confirmed" },
        { type: "close_audit_intent", outcome: "success" },
      ],
    },
    { phase: "failed", effects: failed },
    { phase: "cancelled", effects: failed },
  ] as const)(
    "records a validated $phase receipt despite a missing local claim, projects its payment, and never permits resubmission",
    ({ phase, effects }) => {
      // The provider adapter validates binding and exact settlement before this boundary.
      const recorded = apply(createCustodyProposalState(), observation(phase, START));
      expect(recorded.effects).toEqual(effects);
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

  it("audits the first authority refusal and keeps it and its attribution across repeated checks", () => {
    const recorded = apply(pending(), {
      type: "admission_refused",
      at: LATER,
      reason: "principal_revoked",
      message: "The initiating key was revoked",
    });
    expect(recorded.effects).toEqual([{ type: "audit", event: "proposal_refused" }]);
    expect(recorded.next).toMatchObject({
      providerPhase: "pending",
      authorizationState: "refused",
    });
    const first = recorded.next;
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
    }
  });

  it("stages cancellation before provider I/O and retries ambiguity without duplicate audit", () => {
    expect(canRequestCustodyProposalCancellation(pending(), LATER)).toBe(false);
    expect(
      transitionCustodyProposal(pending(), { type: "cancel_requested", at: LATER })
    ).toHaveProperty("rejected");
    const staged = apply(refused(), { type: "cancel_requested", at: LATER });
    expect(staged.effects).toEqual([{ type: "audit", event: "proposal_cancellation_requested" }]);
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
    expect(retry.next.authorizationState).toBe("cancel_requested");
    expect(retry.next.cancelAttempt).toBe(2);
    expect(retry.effects).toEqual([]);
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

  it("audits the first definitive decline after ambiguous attempts, then retains it through retries", () => {
    // The first call had no definitive result; its retry must not hide the first decline.
    const ambiguous = apply(requested(), { type: "cancel_ambiguous", at: LAST }).next;
    expect(ambiguous.authorizationState).toBe("cancel_ambiguous");
    expect(ambiguous.cancelDeclinedAt).toBeNull();
    const retry = apply(ambiguous, { type: "cancel_requested", at: RETRY });
    expect(retry.effects).toEqual([]);
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
    expect(staged.effects).toEqual([]);
    const repeated = apply(staged.next, { type: "cancel_declined", at: laterAt });
    expect(repeated.next.cancelDeclinedAt).toBe(RETRY);
    expect(repeated.next.refusal).toEqual(ambiguous.refusal);
    expect(repeated.next.authorizationState).toBe("cancel_declined");
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
    ]);
    expect(hasUnalertedCustodyProposalRefusal(committed.next)).toBe(true);
    expect(apply(committed.next, observation("completed", LAST)).effects).toEqual([]);
    expect(
      transitionCustodyProposal(committed.next, { type: "cancel_accepted", at: LAST })
    ).toHaveProperty("rejected");
    const delivered = apply(committed.next, { type: "alert_delivered", at: LAST });
    expect(delivered.effects).toEqual([{ type: "audit", event: "proposal_refusal_alerted" }]);
    expect(delivered.next.authorizationState).toBe("refusal_alerted");
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
  it("rejects a staged attempt past the attempt counter's bound", () => {
    const first = requested();
    const last = { ...first, cancelAttempt: CUSTODY_PROPOSAL_MAX_CANCEL_ATTEMPT - 1 };
    const maximum = apply(last, { type: "cancel_requested", at: RETRY }).next;
    expect(maximum.cancelAttempt).toBe(CUSTODY_PROPOSAL_MAX_CANCEL_ATTEMPT);
    expect(
      transitionCustodyProposal(maximum, {
        type: "cancel_requested",
        at: "2026-11-12T12:12:00.000Z",
      })
    ).toHaveProperty("rejected");
    expect(
      custodyProposalStateSchema.safeParse({
        ...maximum,
        cancelAttempt: CUSTODY_PROPOSAL_MAX_CANCEL_ATTEMPT + 1,
      }).success
    ).toBe(false);
  });

  it("retains explicit ambiguity and audits a late first definitive decline exactly once", () => {
    const ambiguous = apply(requested(), { type: "cancel_ambiguous", at: LAST });
    expect(ambiguous.next.authorizationState).toBe("cancel_ambiguous");
    expect(ambiguous.next.cancelAttempt).toBe(1);
    expect(ambiguous.effects).toEqual([]);
    expect(isCustodyProposalCancellationInFlight(ambiguous.next)).toBe(true);
    const first = apply(ambiguous.next, { type: "cancel_declined", at: LAST });
    expect(first.effects).toEqual([{ type: "audit", event: "proposal_cancellation_declined" }]);
    const retry = apply(first.next, { type: "cancel_requested", at: RETRY });
    expect(retry.next.authorizationState).toBe("cancel_retry_requested");
    const retryUnknown = apply(retry.next, { type: "cancel_ambiguous", at: RETRY });
    expect(retryUnknown.next.authorizationState).toBe("cancel_retry_ambiguous");
    const repeated = apply(retryUnknown.next, { type: "cancel_declined", at: RETRY });
    expect(repeated.next.cancelDeclinedAt).toBe(LAST);
    expect(repeated.effects).toEqual([]);
    const finalRequest = apply(repeated.next, {
      type: "cancel_requested",
      at: "2026-11-12T12:12:00.000Z",
    });
    const accepted = apply(finalRequest.next, {
      type: "cancel_accepted",
      at: "2026-11-12T12:13:00.000Z",
    });
    expect(accepted.effects).toEqual([{ type: "audit", event: "proposal_cancellation_accepted" }]);
    expect(apply(accepted.next, { type: "cancel_accepted", at: LAST }).effects).toEqual([]);
  });

  it("preserves legacy evidence without deriving authority or allowing a refused submission", () => {
    const historicalAck = {
      ...pending(),
      cancelAttempt: 1,
      cancelRequestedAt: START,
      cancelAcknowledgedAt: LATER,
    };
    expect(custodyProposalStateSchema.parse(historicalAck)).toEqual(historicalAck);
    const completed = apply(historicalAck, observation("completed", LAST)).next;
    expect(completed.authorizationState).toBe("authorized");
    expect(hasUnalertedCustodyProposalRefusal(completed)).toBe(false);
    const retained = {
      ...createCustodyProposalState(),
      authorizationState: "refused",
      refusal: refused().refusal,
    } as const;
    expect(custodyProposalStateSchema.parse(retained)).toEqual(retained);
    expect(
      transitionCustodyProposal(retained, { type: "submission_claimed", at: LAST })
    ).toHaveProperty("rejected");
  });

  it("persists only the legal provider/authorization products", () => {
    const uncommitted = [
      "authorized",
      "refused",
      "cancel_requested",
      "cancel_ambiguous",
      "cancel_declined",
      "cancel_retry_requested",
      "cancel_retry_ambiguous",
      "cancel_acknowledged",
    ] as const;
    const unaccepted = ["authorized", "refused"] as const;
    const legal: Record<
      CustodyProposalProviderPhase,
      readonly CustodyProposalAuthorizationState[]
    > = {
      unsent: unaccepted,
      submitting: unaccepted,
      absent: unaccepted,
      pending: uncommitted,
      executing: uncommitted,
      completed: ["authorized", "committed_after_refusal", "refusal_alerted"],
      failed: uncommitted,
      cancelled: uncommitted,
      not_sent: unaccepted,
      never_accepted: unaccepted,
    };
    for (const phase of CUSTODY_PROPOSAL_PROVIDER_PHASES) {
      const allowed = legal[phase];
      for (const authorization of CUSTODY_PROPOSAL_AUTHORIZATION_STATES) {
        expect(
          custodyProposalStateSchema.safeParse(productState(phase, authorization)).success,
          `${phase}/${authorization}`
        ).toBe(allowed.includes(authorization));
      }
    }
  });
  it("rejects absent progress without the first observation required for its horizon", () => {
    const absent = apply(submitting(), { type: "observed_absent", at: LATER }).next;
    expect(custodyProposalStateSchema.safeParse({ ...absent, firstMissingAt: null }).success).toBe(
      false
    );
    const persisted = custodyProposalStateSchema.parse(absent);
    const repeated = apply(persisted, { type: "observed_absent", at: LAST });
    expect(repeated.next.providerPhase).toBe("absent");
    expect(repeated.next.firstMissingAt).toBe(LATER);
  });

  it("keeps every accepted transition inside the persisted product schema", () => {
    const at = "2026-11-12T12:12:00.000Z";
    const events = {
      submission_claimed: { type: "submission_claimed", at },
      submission_refused: { type: "submission_refused", at, error: "Never submitted" },
      observed: observation("pending", at),
      observed_absent: { type: "observed_absent", at },
      admission_refused: {
        type: "admission_refused",
        at,
        reason: "principal_revoked",
        message: "The key was revoked",
      },
      cancel_requested: { type: "cancel_requested", at },
      cancel_accepted: { type: "cancel_accepted", at },
      cancel_ambiguous: { type: "cancel_ambiguous", at },
      cancel_declined: { type: "cancel_declined", at },
      alert_delivered: { type: "alert_delivered", at },
    } as const satisfies {
      [Type in CustodyProposalEvent["type"]]: Extract<CustodyProposalEvent, { type: Type }>;
    };
    for (const phase of CUSTODY_PROPOSAL_PROVIDER_PHASES) {
      for (const authorization of CUSTODY_PROPOSAL_VALID_AUTHORIZATION_STATES_BY_PHASE[phase]) {
        const state = productState(phase, authorization);
        for (const event of [
          ...Object.values(events),
          ...CUSTODY_PROPOSAL_OBSERVED_PHASES.map((observed) => observation(observed, at)),
        ]) {
          const result = transitionCustodyProposal(state, event);
          if ("rejected" in result) continue;
          expect(
            custodyProposalStateSchema.safeParse(result.next).success,
            `${phase}/${authorization}/${event.type}`
          ).toBe(true);
        }
      }
    }
  });
});
