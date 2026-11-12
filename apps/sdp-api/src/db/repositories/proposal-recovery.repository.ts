import type { SdpEnvironment } from "@sdp/types/api-keys";
import {
  FIREBLOCKS_CANCELLABLE_TRANSACTION_STATUSES,
  FIREBLOCKS_CANCELLED_TRANSACTION_STATUSES,
  FIREBLOCKS_FAILED_TRANSACTION_STATUSES,
} from "@sdp/types/fireblocks";
import { SUCCESSFUL_PAYMENT_TRANSFER_STATUSES } from "@sdp/types/payments";
import { z } from "zod";
import type { DatabaseExecutor } from "@/db/client";
import { type MoneyPrincipal, moneyPrincipalSchema } from "@/lib/money-principal";

/** Give a live sender time to claim before adopting an orphaned native payment. */
export const CUSTODY_PROPOSAL_DISCOVERY_GRACE_MS = 2 * 60 * 1000;

const SUCCESSFUL_SQL = SUCCESSFUL_PAYMENT_TRANSFER_STATUSES.map((status) => `'${status}'`).join(
  ", "
);
const CANCELLABLE_SQL = FIREBLOCKS_CANCELLABLE_TRANSACTION_STATUSES.map(
  (status) => `'${status}'`
).join(", ");
const CANCELLED_SQL = FIREBLOCKS_CANCELLED_TRANSACTION_STATUSES.map((status) => `'${status}'`).join(
  ", "
);
const FAILED_SQL = FIREBLOCKS_FAILED_TRANSACTION_STATUSES.map((status) => `'${status}'`).join(", ");

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
  return db.execute(
    `WITH clock AS (SELECT ?::text AS now), missing AS MATERIALIZED (
       SELECT pt.* FROM payment_transfers pt JOIN projects p ON p.id = pt.project_id
        WHERE ${clauses.join(" AND ")} AND ${legacyStatus}
          AND (${missingProposal} OR (pt.status = 'processing' AND EXISTS (
            SELECT 1 FROM custody_proposals cp WHERE cp.payment_transfer_id = pt.id
              AND cp.status = 'active' AND cp.provider_phase = 'unsent'
              AND cp.authorization_state = 'authorized' AND ${attemptedSubmission})))
        ORDER BY pt.created_at, pt.id ${limitClause}
     ), advanced AS MATERIALIZED (
       SELECT pt.* FROM custody_proposals cp
         JOIN payment_transfers pt ON pt.id = cp.payment_transfer_id
         JOIN projects p ON p.id = pt.project_id
        WHERE ${clauses.join(" AND ")}
          AND cp.status = 'active' AND cp.provider_phase = 'unsent'
          AND cp.authorization_state = 'authorized'
          AND (pt.status = 'failed' OR pt.status IN (${SUCCESSFUL_SQL}))
        ORDER BY pt.created_at, pt.id ${limitClause}
     ), legacy AS (
       SELECT * FROM missing UNION ALL SELECT * FROM advanced
       ORDER BY created_at, id ${limitClause}
     ) INSERT INTO custody_proposals (
       id, organization_id, project_id, custody_wallet_id, payment_transfer_id, provider,
       binding, provider_phase, authorization_state, provider_transaction_id,
       provider_status, provider_sub_status, submission_started_at, first_missing_at,
       refused_at, refusal_reason, refusal_message, cancel_requested_at,
       cancel_acknowledged_at, alerted_at, next_check_at, created_at, updated_at
     ) SELECT
       'cproposal_legacy_' || pt.id, pt.organization_id, pt.project_id, pt.custody_wallet_id,
       pt.id, 'fireblocks', jsonb_build_object('version', 1, 'provider', 'fireblocks',
         'connectionId', pt.provider_data #> '{fireblocksTransfer,connectionId}',
         'accountFingerprint', pt.provider_data #> '{fireblocksTransfer,accountFingerprint}',
         'vaultAccountId', pt.provider_data #> '{fireblocksTransfer,vaultAccountId}',
         'assetId', pt.provider_data #> '{fireblocksTransfer,assetId}'),
       CASE
         WHEN pt.status IN (${SUCCESSFUL_SQL}) THEN 'completed'
         WHEN pt.status = 'failed' OR pt.provider_data->>'fireblocksStatus' IN (${FAILED_SQL})
           THEN CASE WHEN pt.provider_data->>'fireblocksStatus' IN (${CANCELLED_SQL}) THEN 'cancelled' ELSE 'failed' END
         WHEN pt.provider_reference IS NOT NULL
           THEN CASE WHEN pt.provider_data->>'fireblocksStatus' IN (${CANCELLABLE_SQL}) THEN 'pending' ELSE 'executing' END
         WHEN pt.provider_data->>'fireblocksFirstMissingAt' IS NOT NULL THEN 'absent'
         WHEN pt.provider_data->>'fireblocksSubmissionStartedAt' IS NOT NULL THEN 'submitting'
         ELSE 'unsent'
       END,
       CASE
         WHEN pt.provider_data->'proposalRefusal' IS NULL THEN 'authorized'
         WHEN pt.status IN (${SUCCESSFUL_SQL}) THEN 'committed_after_refusal'
         WHEN pt.provider_data->>'proposalCancellationAcceptedAt' IS NOT NULL THEN 'cancel_acknowledged'
         ELSE 'refused'
       END,
       pt.provider_reference, pt.provider_data->>'fireblocksStatus', pt.provider_data->>'fireblocksSubStatus',
       pt.provider_data->>'fireblocksSubmissionStartedAt', pt.provider_data->>'fireblocksFirstMissingAt',
       pt.provider_data #>> '{proposalRefusal,at}', pt.provider_data #>> '{proposalRefusal,reason}',
       pt.provider_data #>> '{proposalRefusal,message}',
       pt.provider_data->>'proposalCancellationAcceptedAt', pt.provider_data->>'proposalCancellationAcceptedAt',
       pt.provider_data->>'proposalRefusalAlertedAt', clock.now, pt.created_at, clock.now
       FROM legacy pt CROSS JOIN clock
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
         cancel_acknowledged_at = EXCLUDED.cancel_acknowledged_at,
         alerted_at = EXCLUDED.alerted_at,
         version = custody_proposals.version + 1,
         updated_at = EXCLUDED.updated_at
       WHERE custody_proposals.status = 'active'
         AND custody_proposals.provider_phase = 'unsent'
         AND custody_proposals.authorization_state = 'authorized'
         AND EXCLUDED.provider_phase <> 'unsent'
         AND custody_proposals.provider = EXCLUDED.provider
         AND custody_proposals.binding = EXCLUDED.binding
         AND custody_proposals.custody_wallet_id IS NOT DISTINCT FROM EXCLUDED.custody_wallet_id`,
    [now, ...values, ...limitValues, ...values, ...limitValues, ...limitValues]
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
