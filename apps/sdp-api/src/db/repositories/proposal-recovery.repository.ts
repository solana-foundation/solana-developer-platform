import type { SdpEnvironment } from "@sdp/types/api-keys";
import {
  createCustodyProposalState,
  custodyProposalStateSchema,
} from "@sdp/types/custody-proposals";
import {
  PAYMENT_TRANSFER_STATUSES,
  SUCCESSFUL_PAYMENT_TRANSFER_STATUSES,
} from "@sdp/types/payments";
import { DatabaseError } from "pg";
import { z } from "zod";
import type { DatabaseExecutor } from "@/db/client";
import { legacyFireblocksProposalState } from "@/lib/fireblocks-proposal-compatibility";
import {
  describeMoneyPrincipal,
  type MoneyPrincipal,
  moneyPrincipalSchema,
} from "@/lib/money-principal";
import { getLogger } from "@/runtime/logger";

/** Give a live sender time to claim before recovery observes an unsent payment. */
export const CUSTODY_PROPOSAL_DISCOVERY_GRACE_MS = 2 * 60 * 1000;

const SUCCESSFUL_SQL = SUCCESSFUL_PAYMENT_TRANSFER_STATUSES.map((status) => `'${status}'`).join(
  ", "
);
const INITIAL = createCustodyProposalState();
const legacyPaymentSchema = z.object({
  id: z.string().min(1),
  organization_id: z.string().min(1),
  project_id: z.string().min(1),
  custody_wallet_id: z.string().nullable(),
  status: z.enum(PAYMENT_TRANSFER_STATUSES),
  provider_reference: z.string().nullable(),
  provider_data: z.record(z.string(), z.unknown()),
  legacy_binding: z.record(z.string(), z.unknown()),
  initiated_by_principal: moneyPrincipalSchema.nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

/** Internal bridge shared by the sweep and transactional authority-change enqueue. */
export async function adoptLegacyCustodyProposals(
  db: DatabaseExecutor,
  input: {
    environment?: SdpEnvironment;
    organizationId?: string;
    projectId?: string;
    principal?: MoneyPrincipal;
    now: string;
    limit?: number;
  }
): Promise<number> {
  const missingProposal =
    "NOT EXISTS (SELECT 1 FROM custody_proposals cp WHERE cp.payment_transfer_id = pt.id)";
  const legacyStatus = `(pt.status = 'processing' OR (pt.status IN (${SUCCESSFUL_SQL})
    AND pt.provider_data->'proposalRefusal' IS NOT NULL
    AND pt.provider_data->>'proposalRefusalAlertedAt' IS NULL))`;
  const attemptedSubmission =
    // biome-ignore lint/security/noSecrets: legacy JSON timestamp field, not a credential.
    "(pt.provider_reference IS NOT NULL OR pt.provider_data->>'fireblocksSubmissionStartedAt' IS NOT NULL)";
  const clauses = [
    "pt.provider_data->'fireblocksTransfer' IS NOT NULL",
    // biome-ignore lint/security/noSecrets: SQL JSON field, not a credential.
    "jsonb_typeof(pt.provider_data->'fireblocksTransfer') = 'object'",
    "pt.project_id IS NOT NULL",
  ];
  const now = z.string().datetime().parse(input.now);
  const values: unknown[] = [];
  if (input.environment !== undefined) {
    clauses.push("p.environment = ?");
    values.push(input.environment);
    // Let an in-flight request claim its new payment first. After the grace,
    // a crash before proposal creation must still enter observation-only
    // recovery; absence never grants permission to submit it again.
    clauses.push(`(${attemptedSubmission} OR (pt.status = 'processing' AND pt.created_at <= ?))`);
    values.push(new Date(Date.parse(now) - CUSTODY_PROPOSAL_DISCOVERY_GRACE_MS).toISOString());
  }
  if (input.organizationId !== undefined) {
    clauses.push("pt.organization_id = ?");
    values.push(input.organizationId);
  }
  if (input.projectId !== undefined) {
    clauses.push("pt.project_id = ?");
    values.push(input.projectId);
  }
  if (input.principal !== undefined) {
    clauses.push("pt.initiated_by_principal = ?::jsonb");
    values.push(JSON.stringify(moneyPrincipalSchema.parse(input.principal)));
  }
  let limitClause = "";
  const limitValues: unknown[] = [];
  if (input.limit !== undefined) {
    limitClause = "LIMIT ?";
    limitValues.push(z.number().int().positive().max(1000).parse(input.limit));
  }
  const rows = await db.queryMany(
    `WITH missing AS MATERIALIZED (
       SELECT pt.* FROM payment_transfers pt JOIN projects p ON p.id = pt.project_id
        WHERE ${clauses.join(" AND ")} AND ${legacyStatus}
          AND (${missingProposal} OR (pt.status = 'processing' AND EXISTS (
            SELECT 1 FROM custody_proposals cp WHERE cp.payment_transfer_id = pt.id
              AND cp.status = 'active' AND cp.provider_phase = '${INITIAL.providerPhase}'
              AND cp.authorization_state = '${INITIAL.authorizationState}' AND ${attemptedSubmission})))
        ORDER BY pt.created_at, pt.id ${limitClause}
     ), advanced AS MATERIALIZED (
       SELECT pt.* FROM custody_proposals cp
         JOIN payment_transfers pt ON pt.id = cp.payment_transfer_id
         JOIN projects p ON p.id = pt.project_id
        WHERE ${clauses.join(" AND ")}
          AND cp.status = 'active' AND cp.provider_phase = '${INITIAL.providerPhase}'
          AND cp.authorization_state = '${INITIAL.authorizationState}'
          AND (pt.status = 'failed' OR pt.status IN (${SUCCESSFUL_SQL}))
        ORDER BY pt.created_at, pt.id ${limitClause}
     ), legacy AS (
       SELECT * FROM missing UNION ALL SELECT * FROM advanced
       ORDER BY created_at, id ${limitClause}
     ) SELECT legacy.*, jsonb_build_object('version', 1, 'provider', 'fireblocks',
         'connectionId', provider_data #> '{fireblocksTransfer,connectionId}',
         'accountFingerprint', provider_data #> '{fireblocksTransfer,accountFingerprint}',
         'vaultAccountId', provider_data #> '{fireblocksTransfer,vaultAccountId}',
         'assetId', provider_data #> '{fireblocksTransfer,assetId}') AS legacy_binding
       FROM legacy ORDER BY created_at, id`,
    [...values, ...limitValues, ...values, ...limitValues, ...limitValues]
  );
  // Decode the complete page before writing. The viewer and adoption bridge use
  // one lifecycle mapping; malformed legacy evidence never imports partially.
  const legacy = rows.map((value) => {
    const payment = legacyPaymentSchema.parse(value);
    const state = custodyProposalStateSchema.parse(legacyFireblocksProposalState(payment));
    return {
      payment_transfer_id: payment.id,
      organization_id: payment.organization_id,
      project_id: payment.project_id,
      custody_wallet_id: payment.custody_wallet_id,
      payment_status: payment.status,
      payment_reference: payment.provider_reference,
      payment_data: payment.provider_data,
      payment_principal: payment.initiated_by_principal,
      payment_updated_at: payment.updated_at,
      binding: payment.legacy_binding,
      provider_phase: state.providerPhase,
      authorization_state: state.authorizationState,
      provider_transaction_id: state.providerTransactionId,
      provider_status: state.providerStatus,
      provider_sub_status: state.providerSubStatus,
      submission_started_at: state.submissionStartedAt,
      first_missing_at: state.firstMissingAt,
      refused_at: state.refusal?.at ?? null,
      refusal_reason: state.refusal?.reason ?? null,
      refusal_message: state.refusal?.message ?? null,
      cancel_requested_at: state.cancelRequestedAt,
      cancel_declined_at: state.cancelDeclinedAt,
      cancel_acknowledged_at: state.cancelAcknowledgedAt,
      alerted_at: state.alertedAt,
      created_at: payment.created_at,
    };
  });
  if (legacy.length === 0) return 0;
  return db.execute(
    `WITH clock AS (SELECT ?::text AS now), snapshots AS (
       SELECT * FROM jsonb_to_recordset(?::jsonb) AS snapshot(
         payment_transfer_id text, organization_id text, project_id text, custody_wallet_id text,
         payment_status text, payment_reference text, payment_data jsonb, payment_principal jsonb,
         payment_updated_at text, binding jsonb, provider_phase text, authorization_state text,
         provider_transaction_id text, provider_status text, provider_sub_status text,
         submission_started_at text, first_missing_at text, refused_at text, refusal_reason text,
         refusal_message text, cancel_requested_at text,
         cancel_declined_at text, cancel_acknowledged_at text, alerted_at text, created_at text
       )
     ), legacy AS MATERIALIZED (
       SELECT snapshot.* FROM snapshots snapshot
       JOIN payment_transfers pt ON pt.id = snapshot.payment_transfer_id
         AND pt.organization_id = snapshot.organization_id AND pt.project_id = snapshot.project_id
       WHERE pt.status = snapshot.payment_status
         AND pt.provider_reference IS NOT DISTINCT FROM snapshot.payment_reference
         AND pt.provider_data = snapshot.payment_data
         AND pt.initiated_by_principal IS NOT DISTINCT FROM snapshot.payment_principal
         AND pt.custody_wallet_id IS NOT DISTINCT FROM snapshot.custody_wallet_id
         AND pt.updated_at = snapshot.payment_updated_at
       ORDER BY pt.id FOR UPDATE OF pt
     ) INSERT INTO custody_proposals (
       id, organization_id, project_id, custody_wallet_id, payment_transfer_id, provider,
       binding, provider_phase, authorization_state, provider_transaction_id,
       provider_status, provider_sub_status, submission_started_at, first_missing_at,
       refused_at, refusal_reason, refusal_message, cancel_requested_at,
       cancel_declined_at, cancel_acknowledged_at, alerted_at, next_check_at, created_at, updated_at
     ) SELECT
       'cproposal_legacy_' || gen_random_uuid()::text, legacy.organization_id,
       legacy.project_id, legacy.custody_wallet_id, legacy.payment_transfer_id, 'fireblocks',
       legacy.binding, legacy.provider_phase, legacy.authorization_state, legacy.provider_transaction_id,
       legacy.provider_status, legacy.provider_sub_status, legacy.submission_started_at, legacy.first_missing_at,
       legacy.refused_at, legacy.refusal_reason, legacy.refusal_message, legacy.cancel_requested_at,
       legacy.cancel_declined_at, legacy.cancel_acknowledged_at, legacy.alerted_at,
       clock.now, legacy.created_at, clock.now FROM legacy CROSS JOIN clock
       ON CONFLICT (payment_transfer_id) DO UPDATE SET
         provider_phase = EXCLUDED.provider_phase,
         authorization_state = EXCLUDED.authorization_state,
         provider_transaction_id = EXCLUDED.provider_transaction_id,
         provider_status = EXCLUDED.provider_status,
         provider_sub_status = EXCLUDED.provider_sub_status,
         submission_started_at = EXCLUDED.submission_started_at,
         first_missing_at = EXCLUDED.first_missing_at,
         refused_at = EXCLUDED.refused_at,
         refusal_reason = EXCLUDED.refusal_reason,
         refusal_message = EXCLUDED.refusal_message,
         cancel_requested_at = EXCLUDED.cancel_requested_at,
         cancel_declined_at = EXCLUDED.cancel_declined_at,
         cancel_acknowledged_at = EXCLUDED.cancel_acknowledged_at,
         alerted_at = EXCLUDED.alerted_at,
         version = custody_proposals.version + 1,
         updated_at = EXCLUDED.updated_at
       WHERE custody_proposals.status = 'active'
         AND custody_proposals.provider_phase = '${INITIAL.providerPhase}'
         AND custody_proposals.authorization_state = '${INITIAL.authorizationState}'
         AND EXCLUDED.provider_phase <> '${INITIAL.providerPhase}'
         AND custody_proposals.provider = EXCLUDED.provider
         AND custody_proposals.binding = EXCLUDED.binding
         AND custody_proposals.custody_wallet_id IS NOT DISTINCT FROM EXCLUDED.custody_wallet_id`,
    [now, JSON.stringify(legacy)]
  );
}

/** Flag exactly the affected principal while its authority change commits. */
export async function requestPendingProposalRecovery(
  db: DatabaseExecutor,
  input: {
    organizationId: string;
    projectId?: string;
    principal: MoneyPrincipal;
    now: string;
  }
): Promise<void> {
  const principal = moneyPrincipalSchema.parse(input.principal);
  await adoptLegacyCustodyProposals(db, input);
  const projectClause = input.projectId === undefined ? "" : " AND cp.project_id = ?";
  await db.execute(
    `UPDATE custody_proposals cp
        SET recheck_requested_at = ?
       FROM payment_transfers pt
      WHERE pt.id = cp.payment_transfer_id AND cp.organization_id = ?${projectClause}
        AND cp.status = 'active' AND pt.status = 'processing'
        AND pt.initiated_by_principal = ?::jsonb`,
    [
      input.now,
      input.organizationId,
      ...(input.projectId === undefined ? [] : [input.projectId]),
      JSON.stringify(principal),
    ]
  );
}

/**
 * Expedite recovery after withdrawing authority, without making withdrawal
 * depend on legacy adoption. The caller must hold an open transaction and
 * complete its authority writes first. The minute sweep remains the fallback.
 * Savepoint failures propagate because the outer transaction is then unsafe.
 */
export async function wakePendingProposalRecoveryBestEffort(
  tx: DatabaseExecutor,
  input: Parameters<typeof requestPendingProposalRecovery>[1]
): Promise<void> {
  await tx.execute("SAVEPOINT custody_proposal_recovery_wake");
  try {
    await requestPendingProposalRecovery(tx, input);
  } catch (error) {
    await tx.execute("ROLLBACK TO SAVEPOINT custody_proposal_recovery_wake");
    await tx.execute("RELEASE SAVEPOINT custody_proposal_recovery_wake");
    // A PostgreSQL CHECK failure can include the full row in its DETAIL.
    // Never log that error, its message, or legacy provider metadata.
    getLogger().error(
      {
        event: "proposal_recovery_wake_failed",
        organizationId: input.organizationId,
        projectId: input.projectId,
        principal: describeMoneyPrincipal(input.principal),
        sqlstate: error instanceof DatabaseError ? error.code : undefined,
      },
      "Proposal recovery wake failed; the minute sweep will retry"
    );
    return;
  }
  await tx.execute("RELEASE SAVEPOINT custody_proposal_recovery_wake");
}
