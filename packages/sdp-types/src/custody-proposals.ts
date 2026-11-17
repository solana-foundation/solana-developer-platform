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
  "cancel_ambiguous",
  "cancel_declined",
  "cancel_retry_requested",
  "cancel_retry_ambiguous",
  "cancel_acknowledged",
  "committed_after_refusal",
  "refusal_alerted",
] as const;

/** Authority states that may claim a cancellation attempt, including ambiguous retry. */
export const CUSTODY_PROPOSAL_CANCELLATION_READY_AUTHORIZATION_STATES = [
  "refused",
  "cancel_requested",
  "cancel_ambiguous",
  "cancel_declined",
  "cancel_retry_requested",
  "cancel_retry_ambiguous",
] as const satisfies readonly CustodyProposalAuthorizationState[];

/** A definitive result can still arrive for the current cancellation attempt. */
export const CUSTODY_PROPOSAL_CANCELLATION_IN_FLIGHT_AUTHORIZATION_STATES = [
  "cancel_requested",
  "cancel_ambiguous",
  "cancel_retry_requested",
  "cancel_retry_ambiguous",
] as const satisfies readonly CustodyProposalAuthorizationState[];

/** Completed refusals leave the outbox by changing to refusal_alerted. */
export const CUSTODY_PROPOSAL_UNALERTED_AUTHORIZATION_STATES = [
  "committed_after_refusal",
] as const satisfies readonly CustodyProposalAuthorizationState[];

/** PostgreSQL INTEGER bound; cancellation claims reject before overflowing it. */
export const CUSTODY_PROPOSAL_MAX_CANCEL_ATTEMPT = 2_147_483_647;

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
export const custodyProposalStateSchema = z
  .strictObject({
    providerPhase: z.enum(CUSTODY_PROPOSAL_PROVIDER_PHASES),
    authorizationState: z.enum(CUSTODY_PROPOSAL_AUTHORIZATION_STATES),
    providerTransactionId: z.string().min(1).nullable(),
    providerStatus: z.string().min(1).nullable(),
    providerSubStatus: z.string().nullable(),
    submissionStartedAt: timestampSchema.nullable(),
    firstMissingAt: timestampSchema.nullable(),
    refusal: custodyProposalRefusalSchema.nullable(),
    /** Monotonic cancellation claim identity; zero means no recorded attempt. */
    cancelAttempt: z.number().int().min(0).max(CUSTODY_PROPOSAL_MAX_CANCEL_ATTEMPT),
    /** Latest durable cancellation attempt, including calls with an ambiguous result. */
    cancelRequestedAt: timestampSchema.nullable(),
    /** First definitive cancellation decline; ambiguous attempts never set it. */
    cancelDeclinedAt: timestampSchema.nullable(),
    cancelAcknowledgedAt: timestampSchema.nullable(),
    alertedAt: timestampSchema.nullable(),
  })
  .superRefine((state, context) => {
    const violation = stateInvariantViolation(state);
    if (violation !== undefined) context.addIssue({ code: "custom", message: violation });
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
  z.strictObject({ type: z.literal("cancel_ambiguous"), at: timestampSchema }),
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
]);

/** Atomic payment projections and audit work. */
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
    cancelAttempt: 0,
    cancelRequestedAt: null,
    cancelDeclinedAt: null,
    cancelAcknowledgedAt: null,
    alertedAt: null,
  };
}

type EventType = CustodyProposalEvent["type"];
type AuthorizationTransitions = Readonly<
  Record<
    CustodyProposalAuthorizationState,
    Partial<Record<EventType, readonly CustodyProposalAuthorizationState[]>>
  >
>;
type ProviderTransitions = Readonly<
  Record<
    CustodyProposalProviderPhase,
    Partial<Record<EventType, readonly CustodyProposalProviderPhase[]>>
  >
>;

function continuingAuthorization<State extends CustodyProposalAuthorizationState>(state: State) {
  return {
    observed: [state, "committed_after_refusal"],
    observed_absent: [state],
    admission_refused: [state],
  } as const;
}

/** Every authorization state names its legal events and resulting states. */
export const CUSTODY_PROPOSAL_AUTHORIZATION_TRANSITIONS = {
  authorized: {
    submission_claimed: ["authorized"],
    submission_refused: ["authorized"],
    observed: ["authorized"],
    observed_absent: ["authorized"],
    admission_refused: ["refused"],
  },
  refused: {
    ...continuingAuthorization("refused"),
    submission_refused: ["refused"],
    cancel_requested: ["cancel_requested"],
  },
  cancel_requested: {
    ...continuingAuthorization("cancel_requested"),
    cancel_requested: ["cancel_requested"],
    cancel_accepted: ["cancel_acknowledged"],
    cancel_ambiguous: ["cancel_ambiguous"],
    cancel_declined: ["cancel_declined"],
  },
  cancel_ambiguous: {
    ...continuingAuthorization("cancel_ambiguous"),
    cancel_requested: ["cancel_requested"],
    cancel_accepted: ["cancel_acknowledged"],
    cancel_ambiguous: ["cancel_ambiguous"],
    cancel_declined: ["cancel_declined"],
  },
  cancel_declined: {
    ...continuingAuthorization("cancel_declined"),
    cancel_requested: ["cancel_retry_requested"],
    cancel_declined: ["cancel_declined"],
  },
  cancel_retry_requested: {
    ...continuingAuthorization("cancel_retry_requested"),
    cancel_requested: ["cancel_retry_requested"],
    cancel_accepted: ["cancel_acknowledged"],
    cancel_ambiguous: ["cancel_retry_ambiguous"],
    cancel_declined: ["cancel_declined"],
  },
  cancel_retry_ambiguous: {
    ...continuingAuthorization("cancel_retry_ambiguous"),
    cancel_requested: ["cancel_retry_requested"],
    cancel_accepted: ["cancel_acknowledged"],
    cancel_ambiguous: ["cancel_retry_ambiguous"],
    cancel_declined: ["cancel_declined"],
  },
  cancel_acknowledged: {
    ...continuingAuthorization("cancel_acknowledged"),
    cancel_accepted: ["cancel_acknowledged"],
  },
  committed_after_refusal: {
    observed: ["committed_after_refusal"],
    alert_delivered: ["refusal_alerted"],
  },
  refusal_alerted: { observed: ["refusal_alerted"], alert_delivered: ["refusal_alerted"] },
} as const satisfies AuthorizationTransitions;

function acceptedProviderTransitions<Phase extends "pending" | "executing">(phase: Phase) {
  return {
    observed: CUSTODY_PROPOSAL_OBSERVED_PHASES,
    observed_absent: [phase],
    cancel_accepted: [phase],
    cancel_ambiguous: [phase],
    cancel_declined: [phase],
  } as const;
}

/** Every provider phase names its legal events and resulting phases. */
export const CUSTODY_PROPOSAL_PROVIDER_TRANSITIONS = {
  unsent: {
    submission_claimed: ["submitting"],
    submission_refused: ["not_sent"],
    observed: CUSTODY_PROPOSAL_OBSERVED_PHASES,
    observed_absent: ["absent"],
  },
  submitting: {
    submission_refused: ["not_sent"],
    observed: CUSTODY_PROPOSAL_OBSERVED_PHASES,
    observed_absent: ["absent"],
  },
  absent: {
    submission_refused: ["not_sent"],
    observed: CUSTODY_PROPOSAL_OBSERVED_PHASES,
    observed_absent: ["absent", "never_accepted"],
  },
  pending: {
    ...acceptedProviderTransitions("pending"),
    admission_refused: ["pending"],
    cancel_requested: ["pending"],
  },
  executing: acceptedProviderTransitions("executing"),
  completed: { observed: ["completed"], alert_delivered: ["completed"] },
  failed: { observed: ["failed"] },
  cancelled: { observed: ["cancelled"] },
  not_sent: {},
  never_accepted: {},
} as const satisfies ProviderTransitions;

const UNCOMMITTED_AUTHORIZATION_STATES = [
  "authorized",
  "refused",
  "cancel_requested",
  "cancel_ambiguous",
  "cancel_declined",
  "cancel_retry_requested",
  "cancel_retry_ambiguous",
  "cancel_acknowledged",
] as const satisfies readonly CustodyProposalAuthorizationState[];

/** Legal provider/authority products, including retained pre-acceptance refusal evidence. */
export const CUSTODY_PROPOSAL_VALID_AUTHORIZATION_STATES_BY_PHASE = {
  unsent: ["authorized", "refused"],
  submitting: ["authorized", "refused"],
  absent: ["authorized", "refused"],
  pending: UNCOMMITTED_AUTHORIZATION_STATES,
  executing: UNCOMMITTED_AUTHORIZATION_STATES,
  completed: ["authorized", "committed_after_refusal", "refusal_alerted"],
  failed: UNCOMMITTED_AUTHORIZATION_STATES,
  cancelled: UNCOMMITTED_AUTHORIZATION_STATES,
  not_sent: ["authorized", "refused"],
  never_accepted: ["authorized", "refused"],
} as const satisfies Record<
  CustodyProposalProviderPhase,
  readonly CustodyProposalAuthorizationState[]
>;

/** Adding a phase requires classifying its terminal, cancellation and identity rules. */
export const CUSTODY_PROPOSAL_PROVIDER_PHASE_PROPERTIES = {
  unsent: { terminal: false, cancellable: false, identity: "absent" },
  submitting: { terminal: false, cancellable: false, identity: "absent" },
  absent: { terminal: false, cancellable: false, identity: "absent" },
  pending: { terminal: false, cancellable: true, identity: "required" },
  executing: { terminal: false, cancellable: false, identity: "required" },
  completed: { terminal: true, cancellable: false, identity: "required" },
  failed: { terminal: true, cancellable: false, identity: "retained" },
  cancelled: { terminal: true, cancellable: false, identity: "retained" },
  not_sent: { terminal: true, cancellable: false, identity: "absent" },
  never_accepted: { terminal: true, cancellable: false, identity: "absent" },
} as const satisfies Record<
  CustodyProposalProviderPhase,
  { terminal: boolean; cancellable: boolean; identity: "absent" | "required" | "retained" }
>;

function stateInvariantViolation(state: CustodyProposalState): string | undefined {
  const valid: readonly CustodyProposalAuthorizationState[] =
    CUSTODY_PROPOSAL_VALID_AUTHORIZATION_STATES_BY_PHASE[state.providerPhase];
  if (!valid.includes(state.authorizationState)) return "Invalid provider/authorization state";
  if ((state.authorizationState === "authorized") !== (state.refusal === null))
    return "Refusal data must match the authorization state";
  if ((state.authorizationState === "refusal_alerted") !== (state.alertedAt !== null))
    return "Alert data must match the authorization state";
  if ((state.cancelAttempt === 0) !== (state.cancelRequestedAt === null))
    return "Cancellation attempts need their recorded request time";
  if (state.cancelDeclinedAt !== null && state.cancelAttempt === 0)
    return "A decline requires a cancellation attempt";
  if (state.cancelAcknowledgedAt !== null && state.cancelAttempt === 0)
    return "An acknowledgment requires a cancellation attempt";
  switch (state.authorizationState) {
    case "authorized":
    case "refused":
      // Legacy acknowledgments record provider evidence without creating authority refusal.
      break;
    case "cancel_requested":
    case "cancel_ambiguous":
      if (state.cancelAttempt === 0 || state.cancelDeclinedAt !== null)
        return "Initial cancellation progress cannot contain a previous decline";
      break;
    case "cancel_declined":
    case "cancel_retry_requested":
    case "cancel_retry_ambiguous":
      if (state.cancelAttempt === 0 || state.cancelDeclinedAt === null)
        return "Declined progress must retain its first definitive decline";
      break;
    case "cancel_acknowledged":
      if (state.cancelAcknowledgedAt === null)
        return "Acknowledged progress needs its acknowledgment time";
      break;
    case "committed_after_refusal":
    case "refusal_alerted":
      break;
    default: {
      const exhaustive: never = state.authorizationState;
      return exhaustive;
    }
  }
  if (state.providerPhase === "absent" && state.firstMissingAt === null)
    return "An absent proposal needs its first missing observation time";
  const identity = CUSTODY_PROPOSAL_PROVIDER_PHASE_PROPERTIES[state.providerPhase].identity;
  if (identity === "required" && state.providerTransactionId === null)
    return "An accepted proposal needs its provider transaction identity";
  if (identity === "absent" && state.providerTransactionId !== null)
    return "An unaccepted proposal cannot hold an accepted transaction identity";
  return undefined;
}

/** Reports whether further observations cannot change the provider outcome. */
export function isTerminalCustodyProposalPhase(phase: CustodyProposalProviderPhase): boolean {
  return CUSTODY_PROPOSAL_PROVIDER_PHASE_PROPERTIES[phase].terminal;
}

/** Reports whether an adapter explicitly proved cancellation is still possible. */
export function isCancellableCustodyProposalPhase(phase: CustodyProposalProviderPhase): boolean {
  return CUSTODY_PROPOSAL_PROVIDER_PHASE_PROPERTIES[phase].cancellable;
}

/** A late definitive result is still valid for the same unresolved attempt. */
export function isCustodyProposalCancellationInFlight(state: CustodyProposalState): boolean {
  switch (state.authorizationState) {
    case "cancel_requested":
    case "cancel_ambiguous":
    case "cancel_retry_requested":
    case "cancel_retry_ambiguous":
      return true;
    case "authorized":
    case "refused":
    case "cancel_declined":
    case "cancel_acknowledged":
    case "committed_after_refusal":
    case "refusal_alerted":
      return false;
    default: {
      const exhaustive: never = state.authorizationState;
      return exhaustive;
    }
  }
}

/** The first cancellation is immediate; later claims retain the five-minute cooldown. */
export function canRequestCustodyProposalCancellation(
  state: CustodyProposalState,
  at: string
): boolean {
  if (
    !isCancellableCustodyProposalPhase(state.providerPhase) ||
    state.cancelAttempt >= CUSTODY_PROPOSAL_MAX_CANCEL_ATTEMPT
  )
    return false;
  switch (state.authorizationState) {
    case "refused":
      if (state.cancelAttempt === 0) return true;
      break;
    case "cancel_requested":
    case "cancel_ambiguous":
    case "cancel_declined":
    case "cancel_retry_requested":
    case "cancel_retry_ambiguous":
      break;
    case "authorized":
    case "cancel_acknowledged":
    case "committed_after_refusal":
    case "refusal_alerted":
      return false;
    default: {
      const exhaustive: never = state.authorizationState;
      return exhaustive;
    }
  }
  if (state.cancelRequestedAt === null) throw new Error("Cancellation attempt has no timestamp");
  return (
    Date.parse(at) - Date.parse(state.cancelRequestedAt) >=
    CUSTODY_PROPOSAL_CANCELLATION_RETRY_INTERVAL_MS
  );
}

/** Alert delivery changes the state; its timestamp records only when delivery happened. */
export function hasUnalertedCustodyProposalRefusal(state: CustodyProposalState): boolean {
  return state.authorizationState === "committed_after_refusal";
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
      if (state.authorizationState !== "authorized")
        next.authorizationState = "committed_after_refusal";
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
    { type: "cancel_requested" | "cancel_accepted" | "cancel_declined" | "cancel_ambiguous" }
  >
): CustodyProposalTransition {
  switch (event.type) {
    case "cancel_requested": {
      if (!canRequestCustodyProposalCancellation(state, event.at))
        return rejected("Cancellation requires a pending refusal and an elapsed retry cooldown");
      const transitions: AuthorizationTransitions = CUSTODY_PROPOSAL_AUTHORIZATION_TRANSITIONS;
      const targets = transitions[state.authorizationState].cancel_requested;
      if (targets === undefined || targets.length !== 1)
        throw new Error("Cancellation request has no unique authorization target");
      const authorizationState = targets[0];
      if (authorizationState === undefined)
        throw new Error("Cancellation request has no authorization target");
      return {
        next: {
          ...state,
          authorizationState,
          cancelAttempt: state.cancelAttempt + 1,
          cancelRequestedAt: event.at,
        },
        effects:
          state.authorizationState === "refused"
            ? [{ type: "audit", event: "proposal_cancellation_requested" }]
            : [],
      };
    }
    case "cancel_accepted":
      if (state.authorizationState === "cancel_acknowledged") return { next: state, effects: [] };
      return {
        next: {
          ...state,
          authorizationState: "cancel_acknowledged",
          cancelAcknowledgedAt: event.at,
        },
        effects: [{ type: "audit", event: "proposal_cancellation_accepted" }],
      };
    case "cancel_ambiguous":
      switch (state.authorizationState) {
        case "cancel_requested":
          return { next: { ...state, authorizationState: "cancel_ambiguous" }, effects: [] };
        case "cancel_retry_requested":
          return { next: { ...state, authorizationState: "cancel_retry_ambiguous" }, effects: [] };
        case "cancel_ambiguous":
        case "cancel_retry_ambiguous":
          return { next: state, effects: [] };
        case "authorized":
        case "refused":
        case "cancel_declined":
        case "cancel_acknowledged":
        case "committed_after_refusal":
        case "refusal_alerted":
          return rejected("Cancellation must be staged before an ambiguous result");
        default: {
          const exhaustive: never = state.authorizationState;
          return exhaustive;
        }
      }
    case "cancel_declined":
      switch (state.authorizationState) {
        case "cancel_requested":
        case "cancel_ambiguous":
          return {
            next: { ...state, authorizationState: "cancel_declined", cancelDeclinedAt: event.at },
            effects: [{ type: "audit", event: "proposal_cancellation_declined" }],
          };
        case "cancel_retry_requested":
        case "cancel_retry_ambiguous":
          return { next: { ...state, authorizationState: "cancel_declined" }, effects: [] };
        case "cancel_declined":
          return { next: state, effects: [] };
        case "authorized":
        case "refused":
        case "cancel_acknowledged":
        case "committed_after_refusal":
        case "refusal_alerted":
          return rejected("Cancellation must be staged before a decline");
        default: {
          const exhaustive: never = state.authorizationState;
          return exhaustive;
        }
      }
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
function reduceCustodyProposal(
  state: CustodyProposalState,
  event: CustodyProposalEvent
): CustodyProposalTransition {
  switch (event.type) {
    case "submission_claimed":
      return {
        next: { ...state, providerPhase: "submitting", submissionStartedAt: event.at },
        effects: [],
      };
    case "submission_refused":
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
      if (CUSTODY_PROPOSAL_PROVIDER_PHASE_PROPERTIES[state.providerPhase].identity !== "absent")
        return { next: state, effects: [] };
      const firstMissingAt = state.providerPhase === "absent" ? state.firstMissingAt : event.at;
      if (firstMissingAt === null) throw new Error("Absent proposal has no first observation");
      const expired =
        state.providerPhase === "absent" &&
        Date.parse(event.at) - Date.parse(firstMissingAt) >= CUSTODY_PROPOSAL_ABSENCE_HORIZON_MS;
      return {
        next: {
          ...state,
          providerPhase: expired ? "never_accepted" : "absent",
          firstMissingAt,
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
      if (state.authorizationState !== "authorized") return { next: state, effects: [] };
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
    case "cancel_ambiguous":
      return cancellation(state, event);
    case "alert_delivered":
      if (state.authorizationState === "refusal_alerted") return { next: state, effects: [] };
      return {
        next: { ...state, authorizationState: "refusal_alerted", alertedAt: event.at },
        effects: [{ type: "audit", event: "proposal_refusal_alerted" }],
      };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/** Enforces the complete state tables before and after reducing an event. */
export function transitionCustodyProposal(
  state: CustodyProposalState,
  event: CustodyProposalEvent
): CustodyProposalTransition {
  const providerTransitions: ProviderTransitions = CUSTODY_PROPOSAL_PROVIDER_TRANSITIONS;
  const authorizationTransitions: AuthorizationTransitions =
    CUSTODY_PROPOSAL_AUTHORIZATION_TRANSITIONS;
  const providerTargets = providerTransitions[state.providerPhase][event.type];
  const authorizationTargets = authorizationTransitions[state.authorizationState][event.type];
  if (providerTargets === undefined || authorizationTargets === undefined)
    return rejected("The event is not allowed from this proposal state");
  const result = reduceCustodyProposal(state, event);
  if ("rejected" in result) return result;
  if (
    !providerTargets.includes(result.next.providerPhase) ||
    !authorizationTargets.includes(result.next.authorizationState)
  )
    throw new Error("The custody proposal reducer violated its transition table");
  return result;
}
