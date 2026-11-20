import type { CustodyProposalEvent } from "@sdp/types/custody-proposals";

/** A provider observation normalized before it reaches the shared lifecycle. */
export type ProposalObservation = Extract<CustodyProposalEvent, { type: "observed" }>;

/** Persistence boundaries shared by every provider that proposes signing work. */
export interface ProposalTracking {
  /** Persist before the provider POST; failure prevents submission. */
  create(request: { operation: string; binding: Record<string, unknown> }): Promise<string>;
  /** Atomic with cancellation: false forbids returning a recovered signature. */
  observe(externalId: string, observation: ProposalObservation): Promise<boolean>;
  /** Only a definitive refusal before acceptance may close an unaccepted proposal. */
  failUnaccepted(externalId: string): Promise<void>;
  /** Record sticky cancellation intent; the shared recovery worker owns provider I/O. */
  requestCancellation(externalId: string): Promise<void>;
}

/** Explicit provider actions; callers own persistence, scheduling and recovery. */
export interface ProposalAdapter<Request, Result> {
  /** Submit once using the durable proposal's external identity. */
  propose(request: Request): Promise<Result>;
  /** Observe the original identity after success, timeout or an ambiguous response. */
  read(externalId: string): Promise<Result | null>;
  /** Acknowledgment does not prove cancellation; continue observing the original proposal. */
  cancel(providerTransactionId: string): Promise<boolean>;
}
