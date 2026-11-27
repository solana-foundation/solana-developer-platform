import type { SdpEnvironment } from "@sdp/types/api-keys";
import {
  EARN_CONFIRMED_VAULT_WITHDRAWAL_ACTION_STATUSES,
  EARN_OPEN_VAULT_WITHDRAWAL_REQUEST_STATUSES,
} from "@sdp/types/earn";
import { TERMINAL_OPERATION_STATUSES } from "@sdp/types/operations";
import type { DatabaseClient } from "@/db/client";
import { sqlLiteralList } from "@/db/postgres-utils";
import { EARN_OBSERVATION_PREDICATES } from "./earn-observation-claims";
import { FINALIZED_CURRENT_REDEMPTION_RELEASE_COVERS_REQUEST_SQL } from "./earn-redemption-release.repository";

/** All values describe outstanding durable work; the snapshot never claims or changes it. */
export interface EarnRecoveryHealth {
  queue: string;
  overdue_seconds: number;
}

/**
 * One database round trip per minute, over active partial-index subsets only.
 * Provider delivery without a recorded deadline gets a conservative one-day
 * investigation budget, not an asserted provider SLA. Poll lateness is separate.
 */
export async function readEarnRecoveryHealth(
  db: DatabaseClient,
  environment: SdpEnvironment
): Promise<EarnRecoveryHealth[]> {
  const rows = await db.queryMany<{ queue: string; overdue_seconds: number | string }>(
    `WITH obligations AS (
      SELECT 'operations' AS queue, MIN(operation.next_check_at) AS due_at
      FROM operations operation
      WHERE operation.environment = ? AND operation.next_check_at <= now()
        AND operation.status NOT IN (${sqlLiteralList(TERMINAL_OPERATION_STATUSES)})
        AND (operation.claim_until IS NULL OR operation.claim_until <= now())
        AND EXISTS (SELECT 1 FROM operation_attempts attempt
          WHERE attempt.operation_id = operation.id AND attempt.environment = operation.environment
            AND attempt.organization_id = operation.organization_id AND attempt.project_id = operation.project_id
            AND attempt.action_id = operation.action_id AND attempt.action_version = operation.action_version
            AND (attempt.execution_requested_at IS NOT NULL OR attempt.dispatch_started_at IS NOT NULL
              OR attempt.signed_transaction IS NOT NULL))
      UNION ALL
      SELECT 'accepted', MIN(attempt.execution_requested_at::timestamptz)
      FROM operations operation JOIN operation_attempts attempt
        ON attempt.operation_id = operation.id AND attempt.environment = operation.environment
          AND attempt.organization_id = operation.organization_id AND attempt.project_id = operation.project_id
          AND attempt.action_id = operation.action_id AND attempt.action_version = operation.action_version
      WHERE operation.environment = ? AND operation.next_check_at IS NOT NULL
        AND operation.status = 'queued' AND attempt.execution_requested_at IS NOT NULL
      UNION ALL
      SELECT 'movements', MIN(COALESCE(item.observation_due_at, item.created_at::timestamptz))
      FROM earn_movements item WHERE item.environment = ? AND ${EARN_OBSERVATION_PREDICATES.movement}
        AND (item.observation_claim_until IS NULL OR item.observation_claim_until <= now())
      UNION ALL
      SELECT 'withdrawal_actions', MIN(item.observation_due_at)
      FROM earn_vault_withdrawal_request_actions item
      WHERE item.environment = ? AND item.observation_due_at IS NOT NULL
        AND ${EARN_OBSERVATION_PREDICATES.withdrawal_action}
        AND (item.observation_claim_until IS NULL OR item.observation_claim_until <= now())
      UNION ALL
      SELECT 'provider_poll', MIN(COALESCE(reconciliation_attempted_at, chain_finalized_at)::timestamptz + interval '1 minute')
      FROM earn_movements WHERE environment = ? AND execution_model = 'vault_direct'
        AND status = 'confirmed' AND chain_finalized_at IS NOT NULL
      UNION ALL
      SELECT 'provider_delivery', MIN(chain_finalized_at::timestamptz + interval '1 day')
      FROM earn_movements WHERE environment = ? AND execution_model = 'vault_direct'
        AND status = 'confirmed' AND chain_finalized_at IS NOT NULL
      UNION ALL
      SELECT 'queued_poll', MIN(COALESCE(request.next_check_at, request.updated_at)::timestamptz)
      FROM earn_vault_withdrawal_requests request
      WHERE request.environment = ? AND request.status IN (${sqlLiteralList(EARN_OPEN_VAULT_WITHDRAWAL_REQUEST_STATUSES)})
        AND NOT ${FINALIZED_CURRENT_REDEMPTION_RELEASE_COVERS_REQUEST_SQL}
        AND EXISTS (SELECT 1 FROM earn_vault_withdrawal_request_actions action
          WHERE action.withdrawal_request_id = request.id AND action.action = 'request'
            AND action.status IN (${sqlLiteralList(EARN_CONFIRMED_VAULT_WITHDRAWAL_ACTION_STATUSES)}))
      UNION ALL
      SELECT 'queued_delivery', MIN(CASE
        WHEN request.deadline_timestamp IS NOT NULL THEN to_timestamp(request.deadline_timestamp::double precision)
        WHEN request.maturity_timestamp IS NOT NULL THEN to_timestamp(request.maturity_timestamp::double precision) + interval '1 day'
        ELSE request.created_at::timestamptz + interval '1 day' END)
      FROM earn_vault_withdrawal_requests request
      WHERE request.environment = ? AND request.status IN (${sqlLiteralList(EARN_OPEN_VAULT_WITHDRAWAL_REQUEST_STATUSES)})
        AND NOT ${FINALIZED_CURRENT_REDEMPTION_RELEASE_COVERS_REQUEST_SQL}
      UNION ALL
      SELECT 'valuation', MIN(settled_at::timestamptz + interval '1 hour')
      FROM earn_movements WHERE environment = ? AND execution_model = 'vault_direct'
        AND status = 'finalized' AND signature IS NOT NULL
        AND ((direction = 'withdrawal' AND token_amount_settled IS NULL)
          OR (provider = 'kamino' AND direction = 'deposit' AND deposit_receipt_observed_at IS NULL))
    ) SELECT queue, GREATEST(0, COALESCE(EXTRACT(EPOCH FROM (now() - due_at)), 0)) AS overdue_seconds
      FROM obligations`,
    Array.from({ length: 9 }, () => environment)
  );
  return rows.map((row) => ({ queue: row.queue, overdue_seconds: Number(row.overdue_seconds) }));
}
