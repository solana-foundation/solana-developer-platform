import { CUSTODY_PROVIDERS } from "@sdp/types/custody";
import {
  CUSTODY_PROPOSAL_ACTIVE_PHASES,
  CUSTODY_PROPOSAL_AUTHORIZATION_STATES,
  CUSTODY_PROPOSAL_MAX_CANCEL_ATTEMPT,
  CUSTODY_PROPOSAL_PROVIDER_PHASES,
  CUSTODY_PROPOSAL_UNALERTED_AUTHORIZATION_STATES,
  type CustodyProposalEvent,
  createCustodyProposalState,
  custodyProposalStateSchema,
  isTerminalCustodyProposalPhase,
  transitionCustodyProposal,
} from "@sdp/types/custody-proposals";
import { z } from "zod";
import type { DatabaseExecutor } from "@/db/client";
import { currentDatabaseIdentity } from "@/db/identity";
import { conflict, notFound } from "@/lib/errors";
import { moneyPrincipalSchema } from "@/lib/money-principal";
import { assertTenantClaim, type TenantScope, TenantScopeViolationError } from "@/lib/tenant-scope";
import type {
  CustodyProposalIdentity,
  CustodyProposalRecoveryScope,
  CustodyProposalRow,
  CustodyProposalsRepository,
  ProposedTransactionRow,
  SigningProposalIdentity,
  SigningProposalRow,
} from "./custody-proposals.repository";
import {
  adoptLegacyCustodyProposals,
  CUSTODY_PROPOSAL_DISCOVERY_GRACE_MS,
} from "./proposal-recovery.repository";

const timestampSchema = z.string().datetime();
const nullableTimestampSchema = timestampSchema.nullable();
const proposalColumnsSchema = z.object({
  id: z.string().min(1),
  organization_id: z.string().min(1),
  project_id: z.string().min(1),
  custody_wallet_id: z.string().min(1).nullable(),
  kind: z.enum(["transfer", "signing"]),
  operation: z.string().min(1),
  request_id: z.string().nullable(),
  finished_at: nullableTimestampSchema,
  payment_transfer_id: z.string().min(1).nullable(),
  provider: z.enum(CUSTODY_PROVIDERS),
  binding: z.record(z.string(), z.unknown()),
  provider_phase: z.enum(CUSTODY_PROPOSAL_PROVIDER_PHASES),
  authorization_state: z.enum(CUSTODY_PROPOSAL_AUTHORIZATION_STATES),
  provider_transaction_id: z.string().min(1).nullable(),
  provider_status: z.string().min(1).nullable(),
  provider_sub_status: z.string().nullable(),
  submission_started_at: nullableTimestampSchema,
  first_missing_at: nullableTimestampSchema,
  refused_at: nullableTimestampSchema,
  refusal_reason: z.string().min(1).nullable(),
  refusal_message: z.string().min(1).nullable(),
  cancel_requested_at: nullableTimestampSchema,
  cancel_attempt: z.number().int().min(0).max(CUSTODY_PROPOSAL_MAX_CANCEL_ATTEMPT),
  cancel_declined_at: nullableTimestampSchema,
  cancel_acknowledged_at: nullableTimestampSchema,
  alerted_at: nullableTimestampSchema,
  version: z.number().int().nonnegative(),
  recheck_requested_at: nullableTimestampSchema,
  next_check_at: timestampSchema,
  last_checked_at: nullableTimestampSchema,
  last_polled_at: nullableTimestampSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
});

function mapAnyProposal(value: Record<string, unknown>): ProposedTransactionRow {
  const row = proposalColumnsSchema.parse(value);
  const state = custodyProposalStateSchema.parse({
    providerPhase: row.provider_phase,
    authorizationState: row.authorization_state,
    providerTransactionId: row.provider_transaction_id,
    providerStatus: row.provider_status,
    providerSubStatus: row.provider_sub_status,
    submissionStartedAt: row.submission_started_at,
    firstMissingAt: row.first_missing_at,
    refusal:
      row.refused_at === null
        ? null
        : { at: row.refused_at, reason: row.refusal_reason, message: row.refusal_message },
    cancelRequestedAt: row.cancel_requested_at,
    cancelAttempt: row.cancel_attempt,
    cancelDeclinedAt: row.cancel_declined_at,
    cancelAcknowledgedAt: row.cancel_acknowledged_at,
    alertedAt: row.alerted_at,
  });
  const common = {
    id: row.id,
    organization_id: row.organization_id,
    project_id: row.project_id,
    custody_wallet_id: row.custody_wallet_id,
    provider: row.provider,
    binding: row.binding,
    state,
    version: row.version,
    recheck_requested_at: row.recheck_requested_at,
    next_check_at: row.next_check_at,
    last_checked_at: row.last_checked_at,
    last_polled_at: row.last_polled_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.kind === "signing") {
    return {
      ...common,
      kind: "signing",
      custody_wallet_id: z.string().min(1).parse(row.custody_wallet_id),
      payment_transfer_id: z.null().parse(row.payment_transfer_id),
      operation: row.operation,
      request_id: row.request_id,
      finished_at: row.finished_at,
    };
  }
  return {
    ...common,
    kind: "transfer",
    payment_transfer_id: z.string().min(1).parse(row.payment_transfer_id),
  };
}

function mapProposal(value: Record<string, unknown>): CustodyProposalRow {
  const row = mapAnyProposal(value);
  if (row.kind !== "transfer") throw new Error("Expected a transfer proposal");
  return row;
}

function mapSigningProposal(value: Record<string, unknown>): SigningProposalRow {
  const row = mapAnyProposal(value);
  if (row.kind !== "signing") throw new Error("Expected a signing proposal");
  return row;
}

function stateValues(state: CustodyProposalRow["state"]): readonly unknown[] {
  return [
    state.providerPhase,
    state.authorizationState,
    state.providerTransactionId,
    state.providerStatus,
    state.providerSubStatus,
    state.submissionStartedAt,
    state.firstMissingAt,
    state.refusal?.at ?? null,
    state.refusal?.reason ?? null,
    state.refusal?.message ?? null,
    state.cancelRequestedAt,
    state.cancelAttempt,
    state.cancelDeclinedAt,
    state.cancelAcknowledgedAt,
    state.alertedAt,
  ];
}

const STATE_COLUMNS = [
  "provider_phase",
  "authorization_state",
  "provider_transaction_id",
  "provider_status",
  "provider_sub_status",
  "submission_started_at",
  "first_missing_at",
  "refused_at",
  "refusal_reason",
  "refusal_message",
  "cancel_requested_at",
  "cancel_attempt",
  "cancel_declined_at",
  "cancel_acknowledged_at",
  "alerted_at",
];
const ACTIVE_PHASES_SQL = CUSTODY_PROPOSAL_ACTIVE_PHASES.map((phase) => `'${phase}'`).join(", ");
const INITIAL_STATE = createCustodyProposalState();
const UNALERTED_STATES_SQL = CUSTODY_PROPOSAL_UNALERTED_AUTHORIZATION_STATES.map(
  (state) => `'${state}'`
).join(", ");
const WORKER_INTERVAL_MS = 30_000;
// A status read or authority wake may adopt a payment before its creator has
// claimed submission. Only recovery waits; the create transition stays immediate.
const SUBMISSION_GRACE_SQL = `(cp.kind = 'signing' OR cp.provider_phase <> '${INITIAL_STATE.providerPhase}' OR pt.created_at <= ?)`;
const RECOVERABLE_PROPOSALS_SQL = `p.environment = ? AND cp.status = 'active'
  AND cp.provider_phase IN (${ACTIVE_PHASES_SQL}) AND ${SUBMISSION_GRACE_SQL}`;

function recoveryScopeWhere(input: CustodyProposalRecoveryScope): {
  clauses: string[];
  values: unknown[];
} {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (input.organizationId !== undefined) {
    clauses.push("cp.organization_id = ?");
    values.push(input.organizationId);
  }
  if (input.projectId !== undefined) {
    clauses.push("cp.project_id = ?");
    values.push(input.projectId);
  }
  if (input.principal !== undefined) {
    clauses.push("pt.initiated_by_principal = ?::jsonb");
    values.push(JSON.stringify(moneyPrincipalSchema.parse(input.principal)));
  }
  return { clauses, values };
}

/** PostgreSQL persistence over the caller's connection, including audit transactions. */
export function createPostgresCustodyProposalsRepository(
  db: DatabaseExecutor,
  tenantScope?: TenantScope
): CustodyProposalsRepository {
  const assertScope = (identity: { organizationId: string; projectId: string | null }): void => {
    if (tenantScope) assertTenantClaim(tenantScope, identity, "CustodyProposalsRepository");
  };
  const assertSystem = (operation: string): void => {
    if (tenantScope || currentDatabaseIdentity()?.kind !== "system") {
      throw new TenantScopeViolationError(`CustodyProposalsRepository.${operation} is system-only`);
    }
  };
  const getForTransfer = async (
    input: CustodyProposalIdentity
  ): Promise<CustodyProposalRow | null> => {
    assertScope(input);
    const row = await db.queryOne(
      `SELECT * FROM custody_proposals
        WHERE payment_transfer_id = ? AND organization_id = ? AND project_id = ? AND status = 'active'`,
      [input.transferId, input.organizationId, input.projectId]
    );
    return row ? mapProposal(row) : null;
  };
  const getSigning = async (input: SigningProposalIdentity): Promise<SigningProposalRow | null> => {
    assertScope(input);
    const row = await db.queryOne(
      `SELECT * FROM custody_proposals WHERE id = ? AND organization_id = ? AND project_id = ?
         AND kind = 'signing' AND status = 'active'`,
      [input.proposalId, input.organizationId, input.projectId]
    );
    return row ? mapSigningProposal(row) : null;
  };
  const transitionSigning = async (
    input: SigningProposalIdentity & {
      event: CustodyProposalEvent;
      expectedVersion?: number;
      expectedCancelAttempt?: number;
    }
  ): Promise<SigningProposalRow | null> => {
    assertScope(input);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await getSigning(input);
      if (
        current === null ||
        (input.expectedVersion !== undefined && current.version !== input.expectedVersion) ||
        (input.expectedCancelAttempt !== undefined &&
          current.state.cancelAttempt !== input.expectedCancelAttempt)
      )
        return null;
      const result = transitionCustodyProposal(current.state, input.event);
      if ("rejected" in result) return null;
      if (result.next === current.state) return current;
      const row = await db.queryOne(
        `UPDATE custody_proposals SET ${STATE_COLUMNS.map((column) => `${column} = ?`).join(", ")},
           finished_at = CASE WHEN ?::boolean THEN COALESCE(finished_at, ?) ELSE finished_at END,
           version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND project_id = ? AND kind = 'signing'
           AND status = 'active' AND version = ? RETURNING *`,
        [
          ...stateValues(result.next),
          isTerminalCustodyProposalPhase(result.next.providerPhase),
          input.event.at,
          input.event.at,
          input.proposalId,
          input.organizationId,
          input.projectId,
          current.version,
        ]
      );
      if (row) return mapSigningProposal(row);
    }
    throw conflict("The signing proposal changed concurrently");
  };
  return {
    getForTransfer,
    getSigning,
    transitionSigning,
    async requireSigning(input) {
      const row = await getSigning(input);
      if (row === null) throw notFound("Signing proposal");
      return row;
    },
    async createSigning(input) {
      assertScope(input);
      const provider = z.enum(CUSTODY_PROVIDERS).parse(input.provider);
      const binding = z.record(z.string(), z.unknown()).parse(input.binding);
      const operation = z.string().min(1).parse(input.operation);
      const now = new Date().toISOString();
      const state = {
        ...createCustodyProposalState(),
        providerPhase: "submitting" as const,
        submissionStartedAt: now,
      };
      const id = `proposal_${crypto.randomUUID()}`;
      const row = await db.queryOne<{ id: string }>(
        `INSERT INTO custody_proposals
           (id, organization_id, project_id, custody_wallet_id, kind, operation, provider, binding,
            ${STATE_COLUMNS.join(", ")}, request_id, next_check_at, created_at, updated_at)
         SELECT ?, c.organization_id, c.project_id, w.id, 'signing', ?, ?, ?::jsonb,
           ${STATE_COLUMNS.map(() => "?").join(", ")}, ?, ?, ?, ?
         FROM custody_wallets w JOIN custody_connections c ON c.id = w.custody_connection_id
         WHERE c.id = ? AND c.organization_id = ? AND c.project_id = ? AND w.wallet_id = ? AND c.provider = ?
         RETURNING id`,
        [
          id,
          operation,
          provider,
          JSON.stringify(binding),
          ...stateValues(state),
          input.requestId ?? null,
          now,
          now,
          now,
          input.connectionId,
          input.organizationId,
          input.projectId,
          input.walletId,
          provider,
        ]
      );
      if (row === null) throw conflict("Signing proposal wallet is unavailable");
      return row.id;
    },
    async listSigning(input) {
      assertScope(input);
      const offset = z.number().int().nonnegative().parse(input.offset);
      const rows = await db.queryMany(
        `SELECT * FROM custody_proposals WHERE organization_id = ? AND project_id = ?
           AND custody_wallet_id = ? AND kind = 'signing' AND status = 'active'
         ORDER BY created_at DESC, id DESC LIMIT 21 OFFSET ?`,
        [input.organizationId, input.projectId, input.walletId, offset]
      );
      return rows.map(mapSigningProposal);
    },
    async observeSigning(input) {
      const row = await transitionSigning(input);
      if (row === null) {
        const current = await getSigning(input);
        if (
          current !== null &&
          current.state.providerTransactionId === input.event.providerTransactionId &&
          isTerminalCustodyProposalPhase(current.state.providerPhase)
        )
          return false;
        throw conflict("Signing proposal identity or outcome changed");
      }
      return (
        row.state.authorizationState === "authorized" &&
        row.state.providerTransactionId === input.event.providerTransactionId &&
        row.state.providerPhase === input.event.phase
      );
    },
    async failUnacceptedSigning(input) {
      const current = await getSigning(input);
      if (
        current === null ||
        current.state.providerTransactionId !== null ||
        isTerminalCustodyProposalPhase(current.state.providerPhase)
      )
        return false;
      return (
        (await transitionSigning({
          ...input,
          expectedVersion: current.version,
          event: {
            type: "submission_refused",
            at: new Date().toISOString(),
            error: "Provider refused the signing proposal",
          },
        })) !== null
      );
    },
    async requestSigningCancellation(input) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = await getSigning(input);
        if (current === null || isTerminalCustodyProposalPhase(current.state.providerPhase))
          return false;
        if (current.state.refusal !== null) return true;
        const refused = await transitionSigning({
          ...input,
          expectedVersion: current.version,
          event: {
            type: "cancellation_intent_recorded",
            at: new Date().toISOString(),
            reason: "cancellation_requested",
            message: "Signing proposal cancellation requested",
          },
        });
        if (refused !== null) return true;
      }
      throw conflict("The signing proposal changed concurrently");
    },
    async claimSigningPoll(input) {
      assertScope(input);
      return (
        (await db.queryOne<{ id: string }>(
          `UPDATE custody_proposals SET last_polled_at = sdp_iso_now()
         WHERE id = ? AND organization_id = ? AND project_id = ? AND kind = 'signing'
           AND status = 'active' AND provider_phase IN (${ACTIVE_PHASES_SQL})
           AND (last_polled_at IS NULL OR last_polled_at < ?) RETURNING id`,
          [
            input.proposalId,
            input.organizationId,
            input.projectId,
            new Date(Date.now() - 15_000).toISOString(),
          ]
        )) !== null
      );
    },
    async ensureForTransfer(input) {
      const identity = {
        transferId: input.transfer.id,
        organizationId: input.transfer.organization_id,
        projectId: input.transfer.project_id,
      };
      assertScope(identity);
      const state = custodyProposalStateSchema.parse(input.state);
      const binding = z.record(z.string(), z.unknown()).parse(input.binding);
      const provider = z.enum(CUSTODY_PROVIDERS).parse(input.provider);
      const now = timestampSchema.parse(input.now);
      const inserted = await db.queryOne(
        `INSERT INTO custody_proposals
           (id, organization_id, project_id, custody_wallet_id, payment_transfer_id, provider,
            binding, ${STATE_COLUMNS.join(", ")}, next_check_at, created_at, updated_at)
         SELECT ?, pt.organization_id, pt.project_id, pt.custody_wallet_id, pt.id, ?, ?::jsonb,
                ${STATE_COLUMNS.map(() => "?").join(", ")}, ?, pt.created_at, ?
           FROM payment_transfers pt
          WHERE pt.id = ? AND pt.organization_id = ? AND pt.project_id = ?
            AND pt.custody_wallet_id IS NOT DISTINCT FROM ?
         ON CONFLICT (payment_transfer_id) DO NOTHING
         RETURNING *`,
        [
          `cproposal_${crypto.randomUUID()}`,
          provider,
          JSON.stringify(binding),
          ...stateValues(state),
          now,
          now,
          identity.transferId,
          identity.organizationId,
          identity.projectId,
          input.transfer.custody_wallet_id,
        ]
      );
      if (inserted) return mapProposal(inserted);
      const existing = await db.queryOne(
        `SELECT * FROM custody_proposals
          WHERE payment_transfer_id = ? AND organization_id = ? AND project_id = ?
            AND custody_wallet_id IS NOT DISTINCT FROM ? AND provider = ? AND binding = ?::jsonb`,
        [
          identity.transferId,
          identity.organizationId,
          identity.projectId,
          input.transfer.custody_wallet_id,
          provider,
          JSON.stringify(binding),
        ]
      );
      if (!existing)
        throw new Error("Custody proposal payment or immutable binding does not match");
      const current = mapProposal(existing);
      // During rolling deployment an older image may claim submission after
      // this image adopted the unsent intent. Absorb only that forward fact;
      // never replace a canonical refusal, observed state or terminal outcome.
      if (
        current.state.providerPhase === "unsent" &&
        current.state.authorizationState === "authorized" &&
        state.providerPhase !== "unsent"
      ) {
        const synchronized = await db.queryOne(
          `UPDATE custody_proposals cp
              SET ${STATE_COLUMNS.map((column) => `${column} = ?`).join(", ")},
                  version = version + 1, updated_at = ?
            WHERE cp.payment_transfer_id = ? AND cp.organization_id = ? AND cp.project_id = ?
              AND cp.version = ? AND cp.status = 'active'
              AND cp.provider_phase = '${INITIAL_STATE.providerPhase}' AND cp.authorization_state = '${INITIAL_STATE.authorizationState}'
              AND EXISTS (SELECT 1 FROM payment_transfers pt WHERE pt.id = cp.payment_transfer_id
                AND (pt.provider_reference IS NOT NULL
                  OR pt.provider_data->>'fireblocksSubmissionStartedAt' IS NOT NULL
                  OR pt.status <> 'processing'))
            RETURNING cp.*`,
          [
            ...stateValues(state),
            now,
            identity.transferId,
            identity.organizationId,
            identity.projectId,
            current.version,
          ]
        );
        if (synchronized) return mapProposal(synchronized);
        const fresh = await getForTransfer(identity);
        if (fresh) return fresh;
      }
      return current;
    },
    async transition(input) {
      assertScope(input);
      // Lifecycle transactions always lock parent before child. The rolling
      // submission guard and payment projection must use the same order.
      const payment = await db.queryOne(
        "SELECT id FROM payment_transfers WHERE id = ? AND organization_id = ? AND project_id = ? FOR UPDATE",
        [input.transferId, input.organizationId, input.projectId]
      );
      if (!payment) return null;
      const current = await getForTransfer(input);
      if (!current || current.version !== input.expectedVersion) return null;
      const result = transitionCustodyProposal(current.state, input.event);
      if ("rejected" in result) return null;
      if (result.next === current.state && result.effects.length === 0) {
        return { proposal: current, effects: result.effects };
      }
      const row = await db.queryOne(
        `UPDATE custody_proposals
            SET ${STATE_COLUMNS.map((column) => `${column} = ?`).join(", ")},
                version = version + 1, updated_at = ?
          WHERE payment_transfer_id = ? AND organization_id = ? AND project_id = ? AND version = ? AND status = 'active'
          RETURNING *`,
        [
          ...stateValues(result.next),
          input.event.at,
          input.transferId,
          input.organizationId,
          input.projectId,
          input.expectedVersion,
        ]
      );
      return row ? { proposal: mapProposal(row), effects: result.effects } : null;
    },
    async claimForPoll(input) {
      assertScope(input);
      const now = timestampSchema.parse(input.now);
      const submissionBefore = new Date(
        Date.parse(now) - CUSTODY_PROPOSAL_DISCOVERY_GRACE_MS
      ).toISOString();
      const row = await db.queryOne(
        `UPDATE custody_proposals cp
            SET last_polled_at = ?
           FROM payment_transfers pt
          WHERE pt.id = cp.payment_transfer_id
            AND cp.payment_transfer_id = ? AND cp.organization_id = ? AND cp.project_id = ?
            AND cp.status = 'active' AND cp.provider_phase IN (${ACTIVE_PHASES_SQL})
            AND ${SUBMISSION_GRACE_SQL}
            AND (cp.last_polled_at IS NULL OR cp.last_polled_at < ?)
          RETURNING cp.*`,
        [
          now,
          input.transferId,
          input.organizationId,
          input.projectId,
          submissionBefore,
          input.polledBefore,
        ]
      );
      return row ? mapProposal(row) : null;
    },
    async claimDue(input) {
      assertSystem("claimDue");
      const now = timestampSchema.parse(input.now);
      const limit = z.number().int().positive().max(1000).parse(input.limit);
      const scope = recoveryScopeWhere(input);
      const submissionBefore = new Date(
        Date.parse(now) - CUSTODY_PROPOSAL_DISCOVERY_GRACE_MS
      ).toISOString();
      const clauses = [
        RECOVERABLE_PROPOSALS_SQL,
        "(cp.recheck_requested_at IS NOT NULL OR cp.next_check_at <= ?)",
        ...scope.clauses,
      ];
      // Reserve at least one ordinary slot in batches of two or more. A steady
      // stream of revocations cannot starve unrelated payment reconciliation.
      const priorityLimit = limit === 1 ? 1 : Math.min(limit - 1, Math.ceil(limit * 0.75));
      const nextCheckAt = new Date(Date.parse(now) + WORKER_INTERVAL_MS).toISOString();
      const query = `SELECT cp.id, cp.recheck_requested_at, cp.next_check_at
                       FROM custody_proposals cp
                       LEFT JOIN payment_transfers pt ON pt.id = cp.payment_transfer_id
                       JOIN projects p ON p.id = cp.project_id
                      WHERE ${clauses.join(" AND ")}`;
      const rows = await db.queryMany(
        `WITH priority AS MATERIALIZED (
           ${query} AND cp.recheck_requested_at IS NOT NULL
            ORDER BY cp.recheck_requested_at, cp.last_checked_at ASC NULLS FIRST, cp.id
            LIMIT ? FOR UPDATE OF cp SKIP LOCKED
         ), ordinary AS MATERIALIZED (
           ${query} AND cp.id NOT IN (SELECT id FROM priority)
            ORDER BY cp.recheck_requested_at IS NOT NULL, cp.next_check_at,
                     cp.last_checked_at ASC NULLS FIRST, cp.id
            LIMIT (? - (SELECT COUNT(*) FROM priority)) FOR UPDATE OF cp SKIP LOCKED
         ), due AS (SELECT * FROM priority UNION ALL SELECT * FROM ordinary), claimed AS (
           UPDATE custody_proposals cp
              SET recheck_requested_at = NULL, last_checked_at = ?, next_check_at = ?
             FROM due WHERE cp.id = due.id RETURNING cp.*
         ) SELECT cp.* FROM claimed cp JOIN due ON cp.id = due.id
            ORDER BY due.recheck_requested_at IS NULL,
                     due.recheck_requested_at, due.next_check_at, cp.id`,
        [
          input.environment,
          submissionBefore,
          now,
          ...scope.values,
          priorityLimit,
          input.environment,
          submissionBefore,
          now,
          ...scope.values,
          limit,
          now,
          nextCheckAt,
        ]
      );
      return rows.map(mapAnyProposal);
    },
    async requestRecheck(input) {
      assertSystem("requestRecheck");
      const now = timestampSchema.parse(input.now);
      await db.execute(
        `UPDATE custody_proposals
            SET recheck_requested_at = COALESCE(recheck_requested_at, ?)
          WHERE payment_transfer_id = ? AND organization_id = ? AND project_id = ?
            AND status = 'active' AND provider_phase IN (${ACTIVE_PHASES_SQL})`,
        [now, input.transferId, input.organizationId, input.projectId]
      );
    },
    async listUnalerted(input) {
      assertSystem("listUnalerted");
      const scope = recoveryScopeWhere(input);
      const rows = await db.queryMany(
        `SELECT cp.* FROM custody_proposals cp
          LEFT JOIN payment_transfers pt ON pt.id = cp.payment_transfer_id
          JOIN projects p ON p.id = cp.project_id
         WHERE p.environment = ? AND cp.status = 'active' AND cp.authorization_state IN (${UNALERTED_STATES_SQL})
            ${scope.clauses.map((clause) => `AND ${clause}`).join(" ")}
         ORDER BY cp.refused_at, cp.id LIMIT ?`,
        [
          input.environment,
          ...scope.values,
          z.number().int().positive().max(1000).parse(input.limit),
        ]
      );
      return rows.map(mapAnyProposal);
    },
    async stats(input) {
      assertSystem("stats");
      const now = timestampSchema.parse(input.now);
      const scope = recoveryScopeWhere(input);
      const row = await db.queryOne<{
        pending: number;
        transfers: number;
        signing: number;
        oldest_poll: string | null;
      }>(
        `SELECT COUNT(*)::int AS pending,
           COUNT(*) FILTER (WHERE cp.kind = 'transfer')::int AS transfers,
           COUNT(*) FILTER (WHERE cp.kind = 'signing')::int AS signing,
           MIN(COALESCE(GREATEST(cp.last_polled_at, cp.last_checked_at), cp.created_at)) AS oldest_poll
         FROM custody_proposals cp
         LEFT JOIN payment_transfers pt ON pt.id = cp.payment_transfer_id
         JOIN projects p ON p.id = cp.project_id
         WHERE ${RECOVERABLE_PROPOSALS_SQL}
           ${scope.clauses.map((clause) => `AND ${clause}`).join(" ")}`,
        [
          input.environment,
          new Date(Date.parse(now) - CUSTODY_PROPOSAL_DISCOVERY_GRACE_MS).toISOString(),
          ...scope.values,
        ]
      );
      if (row === null) throw new Error("Missing proposal reconciliation aggregate");
      return {
        pending: row.pending,
        transfers: row.transfers,
        signing: row.signing,
        oldestUnpolledAgeMs:
          row.oldest_poll === null ? 0 : Math.max(0, Date.parse(now) - Date.parse(row.oldest_poll)),
      };
    },
    async adoptLegacyTransfers(input) {
      assertSystem("adoptLegacyTransfers");
      return adoptLegacyCustodyProposals(db, input);
    },
  };
}
