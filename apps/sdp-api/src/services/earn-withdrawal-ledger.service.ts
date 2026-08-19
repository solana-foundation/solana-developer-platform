import type {
  EarnPortfolioWithdrawal,
  EarnPortfolioWithdrawalStatus,
  EarnProgramWithdrawalRecordStatus,
} from "@sdp/types";
import { EARN_TERMINAL_WITHDRAWAL_STATUSES } from "@sdp/types";
import type { EarnProgramWithdrawalRow, EarnRepository } from "@/db/repositories";
import { getLogger } from "@/runtime/logger";

/**
 * The withdrawal-ledger state machine (PRO-1628, ADR 0002 addendum).
 *
 * Provider-neutral by construction: this module consumes only the canonical
 * `EarnPortfolioWithdrawal` contract — every provider client owns the mapping
 * from its raw vocabulary into these statuses, so a new provider inherits the
 * whole ledger with zero code here. Deliberately Hono-free (repo + plain
 * values in, row out): route handlers consume it today, the ledger sweep job
 * and provider webhooks consume it later.
 *
 * Placement note: payments colocates its applier with the webhook routes
 * (settlements.ts) and takes an AppContext; this lives in services/ precisely
 * because its future consumers have no request context.
 *
 * `requested` is SDP-only pre-provider intent state — nothing transitions into
 * it. `pending_approval ↔ processing` is a legitimate park/unpark cycle.
 * Self-transitions are allowed so a same-status observation still refreshes
 * amounts/fees/provider_data (processing → processing is the common poll case
 * and the list endpoint renders those rows). Terminal statuses appear in NO
 * source list, so regression is unrepresentable — and the appliers also
 * early-return on terminal rows (belt), while the SQL `status = ANY(...)`
 * guard closes the read-then-write race (braces), mirroring the two-layer
 * shape of applyRampSettlementEvent.
 */
const ALLOWED_EARN_WITHDRAWAL_SOURCE_STATUSES = {
  processing: ["requested", "processing", "pending_approval"],
  pending_approval: ["requested", "processing", "pending_approval"],
  completed: ["requested", "processing", "pending_approval"],
  partially_completed: ["requested", "processing", "pending_approval"],
  failed: ["requested", "processing", "pending_approval"],
  cancelled: ["requested", "processing", "pending_approval"],
} as const satisfies Record<
  EarnPortfolioWithdrawalStatus,
  readonly EarnProgramWithdrawalRecordStatus[]
>;

export function isTerminalEarnWithdrawalStatus(status: EarnProgramWithdrawalRecordStatus): boolean {
  return (EARN_TERMINAL_WITHDRAWAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Field writes shared by both appliers. `undefined` leaves a column untouched;
 * the provider stays authoritative for paid/fee amounts. The raw observation
 * is merged into provider_data for drift forensics — that merge is what keeps
 * this table useful without provider-specific columns.
 */
function observationFields(observed: EarnPortfolioWithdrawal) {
  return {
    amountPaidUsd: observed.amountPaidUsd,
    feeUsd: observed.feeUsd,
    failureReason: observed.failureReason,
    completedAt: observed.completedAt,
    providerData: { lastObservation: observed },
  };
}

/**
 * Create-path applier: CAS by ROW ID, with `provider_reference` in the SET
 * list — this is the only way a row ever acquires its provider reference, so
 * the create handler (and the replay fall-through) MUST use this entry point;
 * the by-reference applier can never find a ref-less row.
 *
 * Returns the updated row, or null when the CAS lost (row already advanced
 * concurrently) — never an error for a lost race. DB failures propagate;
 * the create handler retries them, observation paths swallow them.
 */
export async function applyEarnWithdrawalObservationToRow(params: {
  repo: EarnRepository;
  row: EarnProgramWithdrawalRow;
  observed: EarnPortfolioWithdrawal;
}): Promise<EarnProgramWithdrawalRow | null> {
  const { repo, row, observed } = params;

  if (isTerminalEarnWithdrawalStatus(row.status)) {
    return row;
  }

  return repo.updateProgramWithdrawalStatusGuarded({
    selector: { withdrawalId: row.id },
    organizationId: row.organization_id,
    fromStatuses: ALLOWED_EARN_WITHDRAWAL_SOURCE_STATUSES[observed.status],
    toStatus: observed.status,
    providerReference: observed.withdrawalRef,
    ...observationFields(observed),
  });
}

/**
 * Observation-path applier (poll now; ledger sweep and webhooks later):
 * resolves the row through the global (provider, provider_reference) unique
 * index, refuses to write across organizations, and no-ops cleanly when no
 * row exists — a withdrawal created before the ledger era must still poll
 * fine, and a ref-less crash row is healed by a same-key create retry or the
 * sweep, never by fuzzy matching here.
 */
export async function applyEarnWithdrawalObservationByReference(params: {
  repo: EarnRepository;
  provider: string;
  organizationId: string;
  /**
   * The program wallet the caller observed this withdrawal THROUGH, when it has
   * one (the poll path always does; a future account-wide sweep may not). Since
   * PRO-1670 an organization holds several programs, so org-level scoping alone
   * would let an observation made via program A advance program B's row — pass
   * this whenever a program context exists.
   */
  walletId?: string;
  observed: EarnPortfolioWithdrawal;
}): Promise<EarnProgramWithdrawalRow | null> {
  const { repo, provider, organizationId, walletId, observed } = params;

  const row = await repo.getProgramWithdrawalByProviderReference({
    provider,
    providerReference: observed.withdrawalRef,
  });
  if (!row) {
    return null;
  }
  if (row.organization_id !== organizationId) {
    // The global index resolved a row owned by another tenant — possible only
    // if a provider reused a withdrawal ref across accounts. Never write.
    getLogger().warn(
      { provider, withdrawalRef: observed.withdrawalRef },
      "earn ledger observation resolved a row outside the caller's organization; skipping"
    );
    return null;
  }
  if (walletId !== undefined && row.wallet_id !== walletId) {
    // Same organization, different program: the provider answered a lookup made
    // through one program's wallet with another program's withdrawal. The
    // handler's own guard should make this unreachable; never write on it.
    getLogger().warn(
      { provider, withdrawalRef: observed.withdrawalRef, walletId },
      "earn ledger observation resolved a sibling program's row; skipping"
    );
    return null;
  }
  if (isTerminalEarnWithdrawalStatus(row.status)) {
    return row;
  }

  return repo.updateProgramWithdrawalStatusGuarded({
    selector: { provider, providerReference: observed.withdrawalRef },
    organizationId,
    fromStatuses: ALLOWED_EARN_WITHDRAWAL_SOURCE_STATUSES[observed.status],
    toStatus: observed.status,
    ...observationFields(observed),
  });
}
