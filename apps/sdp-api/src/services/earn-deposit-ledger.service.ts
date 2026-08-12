import type {
  EarnMovementObservationSource,
  EarnPortfolioDeposit,
  EarnPortfolioDepositStatus,
  EarnPortfolioToken,
  EarnProgramMovementRecordStatus,
} from "@sdp/types";
import { toMovementTimestamp } from "@/db/movement-timestamp";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import type {
  EarnProgramDepositRow,
  EarnProviderWalletRow,
  EarnRepository,
} from "@/db/repositories";
import { getLogger } from "@/runtime/logger";
import { isTerminalEarnMovementStatus } from "./earn-movement-status";

/**
 * The deposit-ledger state machine (PRO-1669, ADR 0002 addendum 2026-08-12).
 *
 * OBSERVATION-SOURCE-AGNOSTIC BY CONSTRUCTION — that is the point of the module.
 * A deposit is a customer-initiated SPL transfer to the program wallet's funding
 * address, so there is no intent state to transition FROM: every write is an
 * observation, and the applier is an UPSERT rather than the pure CAS the
 * withdrawal ledger can afford. Its idempotency proof is therefore the unique
 * index plus the rule that a unique violation means "it already happened"
 * (re-read and CAS), not the CAS guard alone.
 *
 * Three observers call this over the product's life and NONE of them appears in
 * the transition logic below:
 *   provider polling   cron/earn-deposit-sweep.ts (today) + the live deposits
 *                      read's best-effort side effect
 *   provider webhooks  PRO-1631 — the same applier, a different adapter into
 *                      EarnDepositObservation
 *   an SDP indexer     eventually, and the DESIRED end state: it observes chain
 *                      directly and stops making the provider a dependency of
 *                      SDP's own audit trail
 *
 * If you find yourself writing `if (observation.source === ...)` below, the
 * abstraction has failed. Put the difference in the adapter that BUILDS the
 * observation, never in the machine that applies it. A source-grep test pins
 * this, alongside the provider-neutrality one.
 *
 * Provider-neutral for the same reason the withdrawal ledger is: this module
 * consumes only canonical contract values, so a new provider inherits the whole
 * ledger with zero code here. Deliberately Hono-free — the sweep and the future
 * webhook handler have no request context.
 *
 * Terminal statuses appear in NO source list, so regression is unrepresentable;
 * the applier also early-returns on a terminal row (belt) while the SQL
 * `status = ANY(...)` guard closes the read-then-write race (braces) — the
 * two-layer shape the withdrawal ledger and applyRampSettlementEvent both use.
 *
 * The ledger records ARRIVAL, never deployment. A row reaching `completed` means
 * the funds landed as cash in the portfolio wallet; the later provider-managed
 * rebalance that deploys them is not a movement out of the wallet and has no row.
 */

/**
 * What any observer knows about one deposit, with the observer-specific parts
 * optional. Deliberately NOT in `@sdp/types`: an observation is never on the wire
 * (that file holds wire DTOs), and this module must stay consumable by callers
 * with no request context.
 */
export interface EarnDepositObservation {
  source: EarnMovementObservationSource;
  /**
   * The provider's own deposit id. Present for a poll or a webhook; an indexer
   * reading chain has none and MUST leave it undefined rather than synthesize one
   * — a synthetic value would never collide with a poller-written row and would
   * double-record the movement.
   */
  providerReference?: string;
  /** Chain identity, when the observer sees chain. Already rail-gated upstream. */
  transactionSignature?: string;
  /** Which transfer inside that transaction. Only an indexer can know this. */
  instructionIndex?: number;
  status: EarnPortfolioDepositStatus;
  amountUsd: string;
  token: EarnPortfolioToken;
  fromAddress?: string;
  /** When the MOVEMENT happened — provider detection time, or block time. */
  occurredAt: string;
  completedAt?: string;
  /** Raw payload, merged into provider_data for drift forensics. */
  raw: Record<string, unknown>;
}

/**
 * Statuses an observed deposit may transition FROM, keyed by the status being
 * observed. `requested` appears nowhere: a deposit is born from an observation, so
 * there is no SDP intent state to leave (and 0057's CHECK makes it unreachable).
 * Terminal statuses appear as no KEY, so `failed -> completed` is unrepresentable:
 * if a provider ever reverses itself the live read keeps serving provider truth
 * while the ledger row stays put — the convention `partially_completed` already
 * carries. Self-transition is allowed so a same-status observation still refreshes
 * the amount and the raw payload.
 */
const ALLOWED_EARN_DEPOSIT_SOURCE_STATUSES = {
  processing: ["processing"],
  completed: ["processing"],
  failed: ["processing"],
} as const satisfies Record<EarnPortfolioDepositStatus, readonly EarnProgramMovementRecordStatus[]>;

/**
 * Provider timestamps must match the fixed-width shape the column stores before
 * they are written — `toMovementTimestamp` owns that rule for the write path and
 * every read that compares against it, so there is exactly one definition of the
 * shape (see its doc comment for what a mismatched width silently breaks).
 *
 * An unparseable value falls back to the observation time rather than throwing: a
 * deposit with a malformed timestamp is still real money that must be recorded,
 * and the raw value survives in provider_data for forensics.
 */
function normalizeMovementTimestamp(raw: string, fallback: string): string {
  const normalized = toMovementTimestamp(raw);
  if (normalized === null) {
    getLogger().warn({ raw }, "earn movement observation carried an unparseable timestamp");
    return fallback;
  }
  return normalized;
}

/**
 * Adapter for every observer that speaks the canonical provider deposit contract
 * — the poll today and PRO-1631's webhooks next. An indexer builds an
 * `EarnDepositObservation` directly instead, because it has no provider DTO.
 *
 * This function is where per-source difference belongs. The applier below must
 * stay ignorant of it.
 */
export function depositObservationFromProviderRead(
  deposit: EarnPortfolioDeposit,
  source: Extract<EarnMovementObservationSource, "provider_poll" | "provider_webhook">,
  observedAt: string
): EarnDepositObservation {
  return {
    source,
    providerReference: deposit.id,
    // Already withheld upstream for a non-Solana rail (ADR 0002 invariant 5): the
    // value surfaces, another rail's identifiers never do.
    ...(deposit.transactionSignature !== undefined && {
      transactionSignature: deposit.transactionSignature,
    }),
    status: deposit.status,
    amountUsd: deposit.amountUsd,
    token: deposit.token,
    ...(deposit.fromAddress !== undefined && { fromAddress: deposit.fromAddress }),
    occurredAt: normalizeMovementTimestamp(deposit.createdAt, observedAt),
    ...(deposit.completedAt !== undefined && {
      completedAt: normalizeMovementTimestamp(deposit.completedAt, observedAt),
    }),
    raw: { ...deposit },
  };
}

/** Fields every write shares. `undefined` leaves a column untouched. */
function observationFields(observation: EarnDepositObservation) {
  return {
    amountUsd: observation.amountUsd,
    sourceAddress: observation.fromAddress ?? null,
    observedVia: observation.source,
    completedAt: observation.completedAt ?? null,
    // Shallow JSONB merge, so `discoveredVia` written at insert survives every
    // later observer. Never append to an array — this path runs on a 15s-polled
    // surface and unbounded row growth would follow.
    providerData: { lastObservation: observation.raw, lastObservedBy: observation.source },
  };
}

/**
 * Resolve the row this observation is about, in the order the identities become
 * available: the provider's id first, then chain identity.
 *
 * The chain branch is what lets a future indexer adopt a row the poller already
 * wrote (and a poller stamp its reference onto a row the indexer wrote) with no
 * schema change. It returns null on an AMBIGUOUS probe: the signature index is
 * deliberately non-unique because one transaction may carry several transfers to
 * one funding address, so more than one candidate means the observer cannot tell
 * which movement it is holding — and a wrong guess double-counts money. Skipping
 * is the only safe answer.
 */
async function resolveDepositRow(
  repo: EarnRepository,
  wallet: EarnProviderWalletRow,
  observation: EarnDepositObservation
): Promise<EarnProgramDepositRow | null> {
  if (observation.providerReference !== undefined) {
    const byReference = await repo.getProgramDepositByProviderReference({
      provider: wallet.provider,
      providerReference: observation.providerReference,
    });
    if (byReference) {
      return byReference;
    }
  }

  if (observation.transactionSignature !== undefined) {
    const candidates = await repo.listProgramDepositsBySignature({
      walletId: wallet.id,
      transactionSignature: observation.transactionSignature,
    });

    // A signature is NOT a movement identity: one transaction may legally carry
    // several transfers to one funding address, and the provider reports those as
    // several deposits sharing one txHash (migration 0057 keeps the signature index
    // non-unique for exactly this reason). So a signature match alone may not
    // resolve a row — only a row this observation cannot be PROVEN to differ from.
    const claimable = candidates.filter((row) => mayBeSameMovement(row, observation));

    if (claimable.length === 1) {
      return claimable[0] ?? null;
    }
    if (claimable.length > 1) {
      // Several indistinguishable rows on one signature: an observer that cannot
      // tell them apart must not guess, because a wrong adoption merges two real
      // movements and loses one.
      getLogger().warn(
        {
          walletId: wallet.id,
          transactionSignature: observation.transactionSignature,
          candidates: claimable.length,
        },
        "earn deposit observation matched several rows on one signature; skipping rather than guessing"
      );
      return null;
    }
  }

  return null;
}

/**
 * Whether a signature-matched row could be the movement this observation
 * describes — the pivot of the cross-source story, so it is written as "prove them
 * DIFFERENT", never "prove them the same".
 *
 * Two observers of one movement rarely hold the same identifiers: a provider poll
 * knows the provider's deposit id and no instruction index, an indexer knows the
 * instruction index and no provider id. Demanding agreement on an identifier only
 * one side has would duplicate the movement; so a row is rejected only when a
 * discriminator BOTH sides carry actually disagrees.
 *
 * What this buys, concretely:
 * - two batched deposits from the same poll are kept apart (their provider
 *   references differ), so neither overwrites nor swallows the other;
 * - a poll still CLAIMS a reference-less row an indexer wrote, and an indexer
 *   still claims an index-less row a poll wrote, instead of duplicating it.
 *
 * The residual: an indexer observing the second transfer of a batched transaction
 * whose first transfer alone has been polled cannot yet be told apart, because the
 * poll-written row carries no instruction index to disagree with. That is the
 * known cross-source gap ADR 0002's 2026-08-12 addendum assigns to the indexer's
 * own ticket (as a sweep-time merge, not a constraint) — no V1 observer can reach
 * it, since nothing today writes an instruction index.
 */
function mayBeSameMovement(
  row: EarnProgramDepositRow,
  observation: EarnDepositObservation
): boolean {
  if (
    row.provider_reference !== null &&
    observation.providerReference !== undefined &&
    row.provider_reference !== observation.providerReference
  ) {
    return false;
  }
  if (
    row.transaction_instruction_index !== null &&
    observation.instructionIndex !== undefined &&
    row.transaction_instruction_index !== observation.instructionIndex
  ) {
    return false;
  }
  return true;
}

/**
 * Record one observed deposit: advance the existing row, or create it.
 *
 * The wallet row supplies organization/wallet/provider, so nothing about WHERE
 * this lands is caller-supplied. Returns the resulting row, or null when the
 * observation was deliberately not applied (no identity, a row owned elsewhere, an
 * ambiguous chain probe, or a CAS that lost a concurrent race) — never an error
 * for any of those. DB failures propagate; observation callers swallow them.
 */
export async function applyEarnDepositObservation(params: {
  repo: EarnRepository;
  wallet: EarnProviderWalletRow;
  observation: EarnDepositObservation;
}): Promise<EarnProgramDepositRow | null> {
  const { repo, wallet, observation } = params;

  if (
    observation.providerReference === undefined &&
    observation.transactionSignature === undefined
  ) {
    // Unrecordable rather than fatal: 0057 requires a deposit to carry the
    // identifier it was observed by, and an observation with neither cannot be
    // deduplicated against a re-observation of the same movement.
    getLogger().warn(
      { walletId: wallet.id, source: observation.source },
      "earn deposit observation carried no identity; skipping"
    );
    return null;
  }

  const existing = await resolveDepositRow(repo, wallet, observation);
  if (existing) {
    return advanceDepositRow(repo, wallet, existing, observation);
  }

  try {
    return await repo.insertProgramDeposit({
      organizationId: wallet.organization_id,
      walletId: wallet.id,
      provider: wallet.provider,
      status: observation.status,
      amountUsd: observation.amountUsd,
      token: observation.token,
      providerReference: observation.providerReference ?? null,
      sourceAddress: observation.fromAddress ?? null,
      transactionSignature: observation.transactionSignature ?? null,
      transactionInstructionIndex: observation.instructionIndex ?? null,
      observedVia: observation.source,
      occurredAt: observation.occurredAt,
      completedAt: observation.completedAt ?? null,
      providerData: {
        discoveredVia: observation.source,
        lastObservation: observation.raw,
        lastObservedBy: observation.source,
      },
    });
  } catch (error) {
    if (!isPostgresUniqueViolation(error)) {
      throw error;
    }
    // Another observer inserted the same movement between our resolve and our
    // insert. A unique violation therefore means "it already happened" — the same
    // reasoning migration 0056 records for program creation — so re-read and
    // advance instead of surfacing an error. This is the deposit ledger's only
    // concurrency defence; there is no lease.
    const raced = await resolveDepositRow(repo, wallet, observation);
    if (!raced) {
      getLogger().warn(
        { walletId: wallet.id, providerReference: observation.providerReference },
        "earn deposit insert hit a unique violation but the winning row could not be resolved"
      );
      return null;
    }
    return advanceDepositRow(repo, wallet, raced, observation);
  }
}

/** Ownership guards, terminal early-return, then the guarded CAS. */
async function advanceDepositRow(
  repo: EarnRepository,
  wallet: EarnProviderWalletRow,
  row: EarnProgramDepositRow,
  observation: EarnDepositObservation
): Promise<EarnProgramDepositRow | null> {
  if (row.organization_id !== wallet.organization_id) {
    // The provider-reference index is global, so it can resolve a row owned by
    // another tenant — possible only if a provider reused a deposit id across
    // accounts. Never write.
    getLogger().warn(
      { providerReference: observation.providerReference },
      "earn deposit observation resolved a row outside the wallet's organization; skipping"
    );
    return null;
  }
  if (row.wallet_id !== wallet.id) {
    getLogger().warn(
      { providerReference: observation.providerReference, walletId: wallet.id },
      "earn deposit observation resolved a sibling program's row; skipping"
    );
    return null;
  }
  if (isTerminalEarnMovementStatus(row.status)) {
    return row;
  }

  return repo.updateProgramDepositStatusGuarded({
    selector: { depositId: row.id },
    organizationId: wallet.organization_id,
    fromStatuses: ALLOWED_EARN_DEPOSIT_SOURCE_STATUSES[observation.status],
    toStatus: observation.status,
    // Stamped on advance so whichever observer sees an identifier first records
    // it: this is how a poller claims an indexer-written row and vice versa.
    ...(observation.providerReference !== undefined && {
      providerReference: observation.providerReference,
    }),
    ...(observation.transactionSignature !== undefined && {
      transactionSignature: observation.transactionSignature,
    }),
    ...(observation.instructionIndex !== undefined && {
      transactionInstructionIndex: observation.instructionIndex,
    }),
    ...observationFields(observation),
  });
}
