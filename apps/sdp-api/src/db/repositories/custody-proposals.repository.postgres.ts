import { CUSTODY_PROVIDERS } from "@sdp/types/custody";
import {
  CUSTODY_PROPOSAL_ACTIVE_PHASES,
  CUSTODY_PROPOSAL_AUTHORIZATION_STATES,
  CUSTODY_PROPOSAL_PROVIDER_PHASES,
  custodyProposalStateSchema,
  transitionCustodyProposal,
} from "@sdp/types/custody-proposals";
import { z } from "zod";
import type { DatabaseExecutor } from "@/db/client";
import { currentDatabaseIdentity } from "@/db/identity";
import { moneyPrincipalSchema } from "@/lib/money-principal";
import { assertTenantClaim, type TenantScope, TenantScopeViolationError } from "@/lib/tenant-scope";
import type {
  CustodyProposalIdentity,
  CustodyProposalRecoveryScope,
  CustodyProposalRow,
  CustodyProposalsRepository,
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
  payment_transfer_id: z.string().min(1),
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

function mapProposal(value: Record<string, unknown>): CustodyProposalRow {
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
    cancelAcknowledgedAt: row.cancel_acknowledged_at,
    alertedAt: row.alerted_at,
  });
  return {
    id: row.id,
    organization_id: row.organization_id,
    project_id: row.project_id,
    custody_wallet_id: row.custody_wallet_id,
    payment_transfer_id: row.payment_transfer_id,
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
  "cancel_acknowledged_at",
  "alerted_at",
];
const ACTIVE_PHASES_SQL = CUSTODY_PROPOSAL_ACTIVE_PHASES.map((phase) => `'${phase}'`).join(", ");
const WORKER_INTERVAL_MS = 60_000;
// A status read or authority wake may adopt a payment before its creator has
// claimed submission. Only recovery waits; the create transition stays immediate.
const SUBMISSION_GRACE_SQL = "(cp.provider_phase <> 'unsent' OR pt.created_at <= ?)";

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
  const assertScope = (identity: CustodyProposalIdentity): void => {
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
  return {
    getForTransfer,
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
                ${STATE_COLUMNS.map(() => "?").join(", ")}, ?, ?, ?
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
              AND cp.provider_phase = 'unsent' AND cp.authorization_state = 'authorized'
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
        "p.environment = ?",
        `cp.provider_phase IN (${ACTIVE_PHASES_SQL})`,
        "cp.status = 'active'",
        SUBMISSION_GRACE_SQL,
        "(cp.recheck_requested_at IS NOT NULL OR cp.next_check_at <= ?)",
        ...scope.clauses,
      ];
      // Reserve at least one ordinary slot in batches of two or more. A steady
      // stream of revocations cannot starve unrelated payment reconciliation.
      const priorityLimit = limit === 1 ? 1 : Math.min(limit - 1, Math.ceil(limit * 0.75));
      const nextCheckAt = new Date(Date.parse(now) + WORKER_INTERVAL_MS).toISOString();
      const query = `SELECT cp.id, cp.recheck_requested_at, cp.next_check_at
                       FROM custody_proposals cp
                       JOIN payment_transfers pt ON pt.id = cp.payment_transfer_id
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
      return rows.map(mapProposal);
    },
    async listUnalerted(input) {
      assertSystem("listUnalerted");
      const scope = recoveryScopeWhere(input);
      const rows = await db.queryMany(
        `SELECT cp.* FROM custody_proposals cp
          JOIN payment_transfers pt ON pt.id = cp.payment_transfer_id
          JOIN projects p ON p.id = cp.project_id
         WHERE p.environment = ? AND cp.status = 'active' AND cp.authorization_state = 'committed_after_refusal'
           AND cp.alerted_at IS NULL ${scope.clauses.map((clause) => `AND ${clause}`).join(" ")}
         ORDER BY cp.refused_at, cp.id LIMIT ?`,
        [
          input.environment,
          ...scope.values,
          z.number().int().positive().max(1000).parse(input.limit),
        ]
      );
      return rows.map(mapProposal);
    },
    async adoptLegacyTransfers(input) {
      assertSystem("adoptLegacyTransfers");
      return adoptLegacyCustodyProposals(db, input);
    },
  };
}
