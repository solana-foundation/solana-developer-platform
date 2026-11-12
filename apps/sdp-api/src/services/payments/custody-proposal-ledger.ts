import type { CustodyProposalEffect, CustodyProposalEvent } from "@sdp/types/custody-proposals";
import { isSuccessfulPaymentTransferStatus, type PaymentTransferStatus } from "@sdp/types/payments";
import type {
  CustodyProposalRow,
  CustodyProposalsRepository,
} from "@/db/repositories/custody-proposals.repository";
import type { PaymentsRepository, PaymentTransferRow } from "@/db/repositories/payments.repository";
import { conflict } from "@/lib/errors";
import { type AuditLogEntry, criticalOutcomeEntry } from "@/services/audit.service";
import {
  claimLegacyProposalSubmission,
  legacyProposalProjection,
} from "./fireblocks-proposal-compatibility";

/** Both repositories in audited work share the audit transaction. */
export interface ProposalLedger {
  repo: PaymentsRepository;
  proposals: CustodyProposalsRepository;
  audited<T>(
    work: (
      repo: PaymentsRepository,
      proposals: CustodyProposalsRepository
    ) => Promise<{ entry: AuditLogEntry | null; result: T }>
  ): Promise<T>;
}

export interface ProposalEventResult {
  transfer: PaymentTransferRow;
  proposal: CustodyProposalRow;
  written: boolean;
}

interface ProposalObservation {
  signature?: string;
  fee?: number;
  error?: string | null;
  providerData?: Record<string, unknown>;
}

function identity(row: PaymentTransferRow) {
  return { transferId: row.id, organizationId: row.organization_id, projectId: row.project_id };
}

/** One transaction owns proposal state, the payment projection and its audit record. */
export function applyProposalEvent(
  ledger: ProposalLedger,
  row: PaymentTransferRow,
  proposal: CustodyProposalRow,
  event: CustodyProposalEvent,
  observation: ProposalObservation = {}
): Promise<ProposalEventResult> {
  return ledger.audited((repo, proposals) =>
    applyProposalEventInTransaction(repo, proposals, row, proposal, event, observation)
  );
}

/** Apply the same event inside an existing audited proposal-creation transaction. */
export async function applyProposalEventInTransaction(
  repo: PaymentsRepository,
  proposals: CustodyProposalsRepository,
  row: PaymentTransferRow,
  proposal: CustodyProposalRow,
  event: CustodyProposalEvent,
  observation: ProposalObservation = {}
): Promise<{ entry: AuditLogEntry | null; result: ProposalEventResult }> {
  let current = await repo.getTransferById(identity(row));
  if (current === null) throw conflict("The proposal payment no longer exists");
  const latest = await proposals.getForTransfer(identity(row));
  if (latest === null) throw conflict("The custody proposal no longer exists");
  if (latest.id !== proposal.id) throw conflict("The proposal does not belong to this payment");
  if (latest.version !== proposal.version) {
    return { entry: null, result: { transfer: current, proposal: latest, written: false } };
  }
  // The legacy claim participates in this transaction so an overlapping older
  // revision cannot submit the same intent. Remove with the contract migration.
  if (
    event.type === "submission_claimed" &&
    !(await claimLegacyProposalSubmission(repo, latest, event.at))
  ) {
    return { entry: null, result: { transfer: current, proposal: latest, written: false } };
  }
  const transitioned = await proposals.transition({
    ...identity(row),
    expectedVersion: proposal.version,
    event,
  });
  if (transitioned === null) {
    const freshProposal = await proposals.getForTransfer(identity(row));
    const freshPayment = await repo.getTransferById(identity(row));
    if (freshProposal === null || freshPayment === null)
      throw conflict("The custody proposal no longer exists");
    return {
      entry: null,
      result: { transfer: freshPayment, proposal: freshProposal, written: false },
    };
  }
  // transition locks the payment before the proposal. Re-read under that
  // lock: older live revisions do not participate in proposal versions.
  current = await repo.getTransferById(identity(row));
  if (current === null) throw conflict("The proposal payment no longer exists");
  // A previous revision can settle without changing the proposal version.
  // Never manufacture a later refusal or cancellation after that known outcome.
  assertPendingDecision(current, event);
  const { proposal: next, effects } = transitioned;
  const projection = effects.find((effect) => effect.type === "payment_status");
  const status =
    projection?.status === "confirmed" && isSuccessfulPaymentTransferStatus(current.status)
      ? current.status
      : projection?.status;
  assertPaymentProjection(current, next, status, observation.signature);
  const updated = await repo.updateTransfer({
    ...identity(row),
    expectedStatus: current.status,
    status,
    providerReference: next.state.providerTransactionId ?? undefined,
    signature: observation.signature,
    fee: observation.fee,
    error: projectionError(projection?.status === "failed", event, observation),
    providerData: { ...observation.providerData, ...legacyProposalProjection(next) },
    updatedAt: event.at,
  });
  if (updated === null) throw conflict("The proposal payment changed concurrently");
  const entry = await proposalAuditEntry(repo, current, updated, next, effects, event.at);
  return { entry, result: { transfer: updated, proposal: next, written: true } };
}

async function proposalAuditEntry(
  repo: PaymentsRepository,
  current: PaymentTransferRow,
  updated: PaymentTransferRow,
  next: CustodyProposalRow,
  effects: readonly CustodyProposalEffect[],
  at: string
): Promise<AuditLogEntry | null> {
  let entry: AuditLogEntry | null = null;
  const close = effects.find((effect) => effect.type === "close_audit_intent");
  if (close && current.audit_intent_id !== null) {
    const claimed = await repo.closeTransferAuditIntent({
      ...identity(current),
      auditIntentId: current.audit_intent_id,
    });
    if (claimed)
      entry = criticalOutcomeEntry(
        {
          id: current.audit_intent_id,
          entry: {
            organizationId: current.organization_id,
            action: "transfer",
            resourceType: "payment_transfer",
            resourceId: current.id,
          },
        },
        {
          status: close.outcome,
          metadata: {
            status: updated.status,
            provider: next.provider,
            fireblocksTransactionId: next.state.providerTransactionId,
            fireblocksStatus: next.state.providerStatus,
            signature: updated.signature,
            error: updated.error,
          },
        }
      );
  }
  const audit = effects.find((effect) => effect.type === "audit");
  if (audit)
    entry = {
      organizationId: current.organization_id,
      action: "update",
      resourceType: "payment_transfer",
      resourceId: current.id,
      metadata: {
        eventType: audit.event,
        projectId: current.project_id,
        proposalId: next.id,
        provider: next.provider,
        at: at,
        reason: next.state.refusal?.reason ?? null,
        refusedAt: next.state.refusal?.at ?? null,
        providerTransactionId: next.state.providerTransactionId,
        signature: updated.signature,
      },
    };
  return entry;
}

function projectionError(
  failed: boolean,
  event: CustodyProposalEvent,
  observation: ProposalObservation
): string | null | undefined {
  if (failed) return event.type === "submission_refused" ? event.error : observation.error;
  return observation.error === null ? null : undefined;
}

/** Legacy writers do not bump proposal versions; their immutable facts still win. */
function assertPaymentProjection(
  current: PaymentTransferRow,
  proposal: CustodyProposalRow,
  status: PaymentTransferStatus | undefined,
  signature: string | undefined
): void {
  if (
    current.provider_reference !== null &&
    current.provider_reference !== proposal.state.providerTransactionId
  ) {
    throw conflict("The provider transaction identity changed");
  }
  if (signature !== undefined && current.signature !== null && current.signature !== signature) {
    throw conflict("The payment settlement signature changed");
  }
  if (status !== undefined && current.status !== "processing" && current.status !== status) {
    throw conflict("The payment already has a different outcome");
  }
}

function assertPendingDecision(current: PaymentTransferRow, event: CustodyProposalEvent): void {
  switch (event.type) {
    case "admission_refused":
    case "cancel_requested":
      if (current.status !== "processing")
        throw conflict("The payment already has a recorded outcome");
      break;
    default:
      break;
  }
}
