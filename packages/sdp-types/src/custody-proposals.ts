import { z } from "zod";

/** Provider progress, independent of SDP's continuing authorization decision. */
export const CUSTODY_PROPOSAL_PROVIDER_PHASES = [
  "unsent",
  "submitting",
  "absent",
  "pending",
  "executing",
  "completed",
  "failed",
  "cancelled",
  "not_sent",
  "never_accepted",
] as const;

/** Provider phases that still require observation, including ambiguous submission. */
export const CUSTODY_PROPOSAL_ACTIVE_PHASES = [
  "unsent",
  "submitting",
  "absent",
  "pending",
  "executing",
] as const satisfies readonly CustodyProposalProviderPhase[];

/** Terminal observations cannot be replaced by a later observation. */
export const CUSTODY_PROPOSAL_TERMINAL_PHASES = [
  "completed",
  "failed",
  "cancelled",
  "not_sent",
  "never_accepted",
] as const satisfies readonly CustodyProposalProviderPhase[];

/** Adapters map only explicitly cancellable provider statuses to pending. */
export const CUSTODY_PROPOSAL_CANCELLABLE_PHASES = [
  "pending",
] as const satisfies readonly CustodyProposalProviderPhase[];

/** A local pre-send refusal is legal only before an accepted provider transaction. */
export const CUSTODY_PROPOSAL_SUBMISSION_REFUSABLE_PHASES = [
  "unsent",
  "submitting",
  "absent",
] as const satisfies readonly CustodyProposalProviderPhase[];

/** Sticky authority decisions and durable cancellation/alert delivery progress. */
export const CUSTODY_PROPOSAL_AUTHORIZATION_STATES = [
  "authorized",
  "refused",
  "cancel_requested",
  "cancel_acknowledged",
  "committed_after_refusal",
] as const;

/** Authority states that may claim a cancellation attempt, including ambiguous retry. */
export const CUSTODY_PROPOSAL_CANCELLATION_READY_AUTHORIZATION_STATES = [
  "refused",
  "cancel_requested",
] as const satisfies readonly CustodyProposalAuthorizationState[];

/** Normalized provider observations accepted by the transition function. */
export const CUSTODY_PROPOSAL_OBSERVED_PHASES = [
  "pending",
  "executing",
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly CustodyProposalProviderPhase[];

/** System audit outcomes emitted by one successful proposal transition. */
export const CUSTODY_PROPOSAL_AUDIT_EVENTS = [
  "proposal_refused",
  "proposal_cancellation_requested",
  "proposal_cancellation_accepted",
  "proposal_cancellation_declined",
  "proposal_refusal_alerted",
] as const;

/** A provider's progress in the custody proposal lifecycle. */
export type CustodyProposalProviderPhase = (typeof CUSTODY_PROPOSAL_PROVIDER_PHASES)[number];

/** SDP's durable authority and cancellation decision for a proposal. */
export type CustodyProposalAuthorizationState =
  (typeof CUSTODY_PROPOSAL_AUTHORIZATION_STATES)[number];

const timestampSchema = z.string().datetime();

/** The first refusal is retained even if the principal later regains access. */
export const custodyProposalRefusalSchema = z.strictObject({
  at: timestampSchema,
  reason: z.string().min(1),
  message: z.string().min(1),
});

/** Complete durable state; unknown fields and malformed timestamps fail closed. */
export const custodyProposalStateSchema = z.strictObject({
  providerPhase: z.enum(CUSTODY_PROPOSAL_PROVIDER_PHASES),
  authorizationState: z.enum(CUSTODY_PROPOSAL_AUTHORIZATION_STATES),
  providerTransactionId: z.string().min(1).nullable(),
  providerStatus: z.string().min(1).nullable(),
  providerSubStatus: z.string().nullable(),
  submissionStartedAt: timestampSchema.nullable(),
  firstMissingAt: timestampSchema.nullable(),
  refusal: custodyProposalRefusalSchema.nullable(),
  /** Latest durable cancellation attempt, including calls with an ambiguous result. */
  cancelRequestedAt: timestampSchema.nullable(),
  cancelAcknowledgedAt: timestampSchema.nullable(),
  alertedAt: timestampSchema.nullable(),
});

/** Provider-neutral durable state, parsed before use by repositories. */
export type CustodyProposalState = z.infer<typeof custodyProposalStateSchema>;

/** Events contain facts; the reducer alone determines their legal consequences. */
export const custodyProposalEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("submission_claimed"), at: timestampSchema }),
  z.strictObject({
    type: z.literal("submission_refused"),
    at: timestampSchema,
    error: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("observed"),
    at: timestampSchema,
    phase: z.enum(CUSTODY_PROPOSAL_OBSERVED_PHASES),
    providerTransactionId: z.string().min(1),
    providerStatus: z.string().min(1),
    providerSubStatus: z.string().nullable(),
  }),
  z.strictObject({ type: z.literal("observed_absent"), at: timestampSchema }),
  z.strictObject({
    type: z.literal("admission_refused"),
    at: timestampSchema,
    reason: z.string().min(1),
    message: z.string().min(1),
  }),
  z.strictObject({ type: z.literal("cancel_requested"), at: timestampSchema }),
  z.strictObject({ type: z.literal("cancel_accepted"), at: timestampSchema }),
  z.strictObject({ type: z.literal("cancel_declined"), at: timestampSchema }),
  z.strictObject({ type: z.literal("alert_delivered"), at: timestampSchema }),
]);

/** A parsed submission, observation, authority decision or delivery acknowledgment. */
export type CustodyProposalEvent = z.infer<typeof custodyProposalEventSchema>;

/** External effects describe durable work, never I/O inside the state transaction. */
export const custodyProposalEffectSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("audit"), event: z.enum(CUSTODY_PROPOSAL_AUDIT_EVENTS) }),
  z.strictObject({
    type: z.literal("payment_status"),
    status: z.enum(["processing", "confirmed", "failed"]),
  }),
  z.strictObject({
    type: z.literal("close_audit_intent"),
    outcome: z.enum(["success", "failure"]),
  }),
  z.strictObject({ type: z.literal("request_cancel") }),
  z.strictObject({ type: z.literal("raise_critical") }),
]);

/** Atomic projections/audits and staged provider or alert work. */
export type CustodyProposalEffect = z.infer<typeof custodyProposalEffectSchema>;

/** A transition rejection leaves every durable field unchanged. */
export type CustodyProposalTransition =
  | { next: CustodyProposalState; effects: readonly CustodyProposalEffect[] }
  | { rejected: string };

/** Absence is conclusive only after repeated reads and without an accepted provider ID. */
export const CUSTODY_PROPOSAL_ABSENCE_HORIZON_MS = 24 * 60 * 60 * 1000;

/** Declined or ambiguous cancellations retry at most once per five minutes. */
export const CUSTODY_PROPOSAL_CANCELLATION_RETRY_INTERVAL_MS = 5 * 60 * 1000;

/** Starts an unclaimed proposal without assuming a provider accepted anything. */
export function createCustodyProposalState(): CustodyProposalState {
  return {
    providerPhase: "unsent",
    authorizationState: "authorized",
    providerTransactionId: null,
    providerStatus: null,
    providerSubStatus: null,
    submissionStartedAt: null,
    firstMissingAt: null,
    refusal: null,
    cancelRequestedAt: null,
    cancelAcknowledgedAt: null,
    alertedAt: null,
  };
}

/** Reports whether further observations cannot change the provider outcome. */
export function isTerminalCustodyProposalPhase(phase: CustodyProposalProviderPhase): boolean {
  return CUSTODY_PROPOSAL_TERMINAL_PHASES.some((candidate) => candidate === phase);
}

/** Reports whether an adapter explicitly proved cancellation is still possible. */
export function isCancellableCustodyProposalPhase(phase: CustodyProposalProviderPhase): boolean {
  return CUSTODY_PROPOSAL_CANCELLABLE_PHASES.some((candidate) => candidate === phase);
}

/** The first cancellation is immediate; later claims share a durable retry cooldown. */
export function canRequestCustodyProposalCancellation(
  state: CustodyProposalState,
  at: string
): boolean {
  return (
    isCancellableCustodyProposalPhase(state.providerPhase) &&
    state.refusal !== null &&
    CUSTODY_PROPOSAL_CANCELLATION_READY_AUTHORIZATION_STATES.some(
      (candidate) => candidate === state.authorizationState
    ) &&
    (state.cancelRequestedAt === null ||
      Date.parse(at) - Date.parse(state.cancelRequestedAt) >=
        CUSTODY_PROPOSAL_CANCELLATION_RETRY_INTERVAL_MS)
  );
}

/** Terminal proposals remain in the alert outbox until delivery is acknowledged. */
export function hasUnalertedCustodyProposalRefusal(state: CustodyProposalState): boolean {
  return state.authorizationState === "committed_after_refusal" && state.alertedAt === null;
}

function rejected(reason: string): CustodyProposalTransition {
  return { rejected: reason };
}

function observed(
  state: CustodyProposalState,
  event: Extract<CustodyProposalEvent, { type: "observed" }>
): CustodyProposalTransition {
  if (
    state.providerTransactionId !== null &&
    state.providerTransactionId !== event.providerTransactionId
  ) {
    return rejected("Provider transaction identity changed");
  }
  if (isTerminalCustodyProposalPhase(state.providerPhase)) {
    return state.providerPhase === event.phase
      ? { next: state, effects: [] }
      : rejected("Terminal provider outcomes cannot change");
  }
  const next: CustodyProposalState = {
    ...state,
    providerPhase: event.phase,
    providerTransactionId: event.providerTransactionId,
    providerStatus: event.providerStatus,
    providerSubStatus: event.providerSubStatus,
    firstMissingAt: null,
  };
  switch (event.phase) {
    case "pending":
    case "executing":
      return { next, effects: [{ type: "payment_status", status: "processing" }] };
    case "completed": {
      const effects: CustodyProposalEffect[] = [
        { type: "payment_status", status: "confirmed" },
        { type: "close_audit_intent", outcome: "success" },
      ];
      if (state.refusal !== null) {
        next.authorizationState = "committed_after_refusal";
        effects.push({ type: "raise_critical" });
      }
      return { next, effects };
    }
    case "failed":
    case "cancelled":
      return {
        next,
        effects: [
          { type: "payment_status", status: "failed" },
          { type: "close_audit_intent", outcome: "failure" },
        ],
      };
    default: {
      const exhaustive: never = event.phase;
      return exhaustive;
    }
  }
}

function cancellation(
  state: CustodyProposalState,
  event: Extract<
    CustodyProposalEvent,
    { type: "cancel_requested" | "cancel_accepted" | "cancel_declined" }
  >
): CustodyProposalTransition {
  switch (event.type) {
    case "cancel_requested":
      if (!canRequestCustodyProposalCancellation(state, event.at)) {
        return rejected("Cancellation requires a pending refusal and an elapsed retry cooldown");
      }
      return {
        next: {
          ...state,
          authorizationState: "cancel_requested",
          cancelRequestedAt: event.at,
        },
        effects:
          state.cancelRequestedAt === null
            ? [
                { type: "audit", event: "proposal_cancellation_requested" },
                { type: "request_cancel" },
              ]
            : [{ type: "request_cancel" }],
      };
    case "cancel_accepted":
      if (isTerminalCustodyProposalPhase(state.providerPhase)) {
        return rejected("A late cancellation acknowledgment cannot change a terminal outcome");
      }
      if (state.authorizationState === "cancel_acknowledged") {
        return { next: state, effects: [] };
      }
      if (state.authorizationState !== "cancel_requested") {
        return rejected("Cancellation must be staged before acknowledgment");
      }
      return {
        next: {
          ...state,
          authorizationState: "cancel_acknowledged",
          cancelAcknowledgedAt: event.at,
        },
        effects: [{ type: "audit", event: "proposal_cancellation_accepted" }],
      };
    case "cancel_declined":
      if (
        isTerminalCustodyProposalPhase(state.providerPhase) ||
        state.authorizationState !== "cancel_requested"
      ) {
        return rejected("Only a staged nonterminal cancellation can be declined");
      }
      return {
        next: { ...state, authorizationState: "refused" },
        effects: [{ type: "audit", event: "proposal_cancellation_declined" }],
      };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/**
 * Determines the only legal state change for a normalized event. Callers persist
 * state, payment projections and audit effects in the same versioned transaction.
 * Provider requests and alert delivery run only after that transaction commits.
 */
export function transitionCustodyProposal(
  state: CustodyProposalState,
  event: CustodyProposalEvent
): CustodyProposalTransition {
  switch (event.type) {
    case "submission_claimed":
      if (state.providerPhase !== "unsent") return rejected("Submission is already claimed");
      return {
        next: { ...state, providerPhase: "submitting", submissionStartedAt: event.at },
        effects: [],
      };
    case "submission_refused":
      if (
        !CUSTODY_PROPOSAL_SUBMISSION_REFUSABLE_PHASES.some(
          (candidate) => candidate === state.providerPhase
        ) ||
        state.providerTransactionId !== null
      ) {
        return rejected("Only an unaccepted submission can be refused before sending");
      }
      return {
        next: { ...state, providerPhase: "not_sent" },
        effects: [
          { type: "payment_status", status: "failed" },
          { type: "close_audit_intent", outcome: "failure" },
        ],
      };
    case "observed":
      return observed(state, event);
    case "observed_absent": {
      if (isTerminalCustodyProposalPhase(state.providerPhase)) {
        return rejected("Terminal provider outcomes cannot become absent");
      }
      if (state.providerTransactionId !== null) return { next: state, effects: [] };
      const expired =
        state.firstMissingAt !== null &&
        Date.parse(event.at) - Date.parse(state.firstMissingAt) >=
          CUSTODY_PROPOSAL_ABSENCE_HORIZON_MS;
      return {
        next: {
          ...state,
          providerPhase: expired ? "never_accepted" : "absent",
          firstMissingAt: state.firstMissingAt ?? event.at,
        },
        effects: expired
          ? [
              { type: "payment_status", status: "failed" },
              { type: "close_audit_intent", outcome: "failure" },
            ]
          : [],
      };
    }
    case "admission_refused":
      if (!isCancellableCustodyProposalPhase(state.providerPhase)) {
        return rejected("Only a pending cancellable proposal can lose admission");
      }
      if (state.refusal !== null) return { next: state, effects: [] };
      return {
        next: {
          ...state,
          authorizationState: "refused",
          refusal: { at: event.at, reason: event.reason, message: event.message },
        },
        effects: [{ type: "audit", event: "proposal_refused" }],
      };
    case "cancel_requested":
    case "cancel_accepted":
    case "cancel_declined":
      return cancellation(state, event);
    case "alert_delivered":
      if (state.authorizationState !== "committed_after_refusal") {
        return rejected("Only completion after a recorded refusal raises a critical alert");
      }
      if (state.alertedAt !== null) return { next: state, effects: [] };
      return {
        next: { ...state, alertedAt: event.at },
        effects: [{ type: "audit", event: "proposal_refusal_alerted" }],
      };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
