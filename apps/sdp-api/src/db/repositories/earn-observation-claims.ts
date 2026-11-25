import { randomUUID } from "node:crypto";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import {
  EARN_IN_FLIGHT_VAULT_WITHDRAWAL_ACTION_STATUSES,
  EARN_MOVEMENT_TRANSITIONS,
  EARN_TERMINAL_VAULT_WITHDRAWAL_REQUEST_STATUSES,
  EARN_UNPROJECTED_VAULT_WITHDRAWAL_REQUEST_STATUSES,
} from "@sdp/types/earn";
import type { DatabaseClient } from "@/db/client";
import { sqlLiteralList } from "@/db/postgres-utils";
import { FINALIZED_CURRENT_REDEMPTION_RELEASE_COVERS_REQUEST_SQL } from "./earn-redemption-release.repository";

/** Scheduler ownership only; financial transitions stay in their domain repositories. */
export type EarnObservationKind = "movement" | "withdrawal_action";

/** A short claim spans one bounded observation pass, including its RPC reads. */
export const EARN_OBSERVATION_LEASE_SECONDS = 60;

const tables = {
  movement: "earn_movements",
  withdrawal_action: "earn_vault_withdrawal_request_actions",
} as const;

/** Shared by claims and read-only health snapshots so obsolete hints cannot raise alerts. */
export const EARN_OBSERVATION_PREDICATES = {
  movement: `item.execution_model = 'vault_direct'
    AND item.status IN (${sqlLiteralList(EARN_MOVEMENT_TRANSITIONS.vault_direct.finalized)})
    AND item.chain_finalized_at IS NULL`,
  withdrawal_action: `(item.status IN (${sqlLiteralList(EARN_IN_FLIGHT_VAULT_WITHDRAWAL_ACTION_STATUSES)})
    OR item.status = 'finalized')
    AND EXISTS (
      SELECT 1 FROM earn_vault_withdrawal_requests request
      WHERE request.id = item.withdrawal_request_id
        AND request.organization_id = item.organization_id
        AND request.environment = item.environment
        AND request.status NOT IN (${sqlLiteralList(EARN_TERMINAL_VAULT_WITHDRAWAL_REQUEST_STATUSES)})
        AND (item.status <> 'finalized' OR request.status IN (${sqlLiteralList(EARN_UNPROJECTED_VAULT_WITHDRAWAL_REQUEST_STATUSES)}))
        AND NOT ${FINALIZED_CURRENT_REDEMPTION_RELEASE_COVERS_REQUEST_SQL}
    )`,
} as const;

const predicates = EARN_OBSERVATION_PREDICATES;

/** Claim disjoint due rows without holding a database transaction during RPC work. */
export async function claimEarnObservations(
  db: DatabaseClient,
  kind: EarnObservationKind,
  environment: SdpEnvironment,
  limit: number
): Promise<{ rows: Record<string, unknown>[]; scanned: number; token: string }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 128) {
    throw new Error("Earn observation batch must contain 1 to 128 rows");
  }
  const token = randomUUID();
  // Scan only the indexed page before checking parent/provider eligibility.
  // Retiring obsolete hints prevents settled parent history accumulating at
  // the head of every fast scan. Legacy NULL actions stay with minute recovery.
  const candidatePredicate =
    kind === "movement"
      ? predicates.movement
      : `(item.status IN (${sqlLiteralList(EARN_IN_FLIGHT_VAULT_WITHDRAWAL_ACTION_STATUSES)})
      OR item.status = 'finalized') AND item.observation_due_at IS NOT NULL`;
  const scanned = await db.queryMany<Record<string, unknown>>(
    `WITH candidates AS MATERIALIZED (
      SELECT item.id FROM ${tables[kind]} item
      WHERE ${candidatePredicate} AND item.environment = ?
        AND (item.observation_due_at IS NULL OR item.observation_due_at <= now())
        AND (item.observation_claim_until IS NULL OR item.observation_claim_until <= now())
      ORDER BY item.observation_due_at NULLS FIRST, item.id LIMIT ?
      FOR UPDATE OF item SKIP LOCKED
    ), decisions AS MATERIALIZED (
      SELECT item.id, (${predicates[kind]}) AS eligible
      FROM ${tables[kind]} item JOIN candidates ON item.id = candidates.id
    ) UPDATE ${tables[kind]} item
      SET observation_claim_token = CASE WHEN decisions.eligible THEN ? ELSE NULL END,
          observation_claim_until = CASE WHEN decisions.eligible
            THEN now() + make_interval(secs => ?) ELSE NULL END,
          observation_due_at = CASE WHEN decisions.eligible
            THEN now() + make_interval(secs => ${EARN_OBSERVATION_LEASE_SECONDS}) ELSE NULL END
      FROM decisions WHERE item.id = decisions.id RETURNING item.*`,
    [environment, limit, token, EARN_OBSERVATION_LEASE_SECONDS]
  );
  return {
    rows: scanned.filter((row) => row.observation_claim_token === token),
    scanned: scanned.length,
    token,
  };
}

/** Refresh available recovery candidates without reserving them during shared RPC reads. */
export async function readEarnRecoveryObservations(
  db: DatabaseClient,
  kind: EarnObservationKind,
  rows: readonly { id: string; organization_id: string; environment: SdpEnvironment }[]
): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return [];
  return db.queryMany<Record<string, unknown>>(
    `SELECT item.* FROM ${tables[kind]} item
      JOIN unnest(?::text[], ?::text[], ?::text[]) AS selected(id, organization_id, environment)
        ON item.id = selected.id AND item.organization_id = selected.organization_id
          AND item.environment = selected.environment
      WHERE ${predicates[kind]}
        AND (item.observation_claim_until IS NULL OR item.observation_claim_until <= now())
      ORDER BY item.id`,
    [
      rows.map((row) => row.id),
      rows.map((row) => row.organization_id),
      rows.map((row) => row.environment),
    ]
  );
}

/** Reserve only the recovery rows whose reducers are ready to run after shared observation. */
export async function claimSelectedEarnObservations(
  db: DatabaseClient,
  kind: EarnObservationKind,
  rows: readonly { id: string; organization_id: string; environment: SdpEnvironment }[]
): Promise<{ rows: Record<string, unknown>[]; ids: Set<string>; token: string }> {
  const token = randomUUID();
  const claimed = await db.queryMany<{ id: string } & Record<string, unknown>>(
    `WITH candidates AS MATERIALIZED (
      SELECT item.id FROM ${tables[kind]} item
      JOIN unnest(?::text[], ?::text[], ?::text[]) AS owned(id, organization_id, environment)
        ON item.id = owned.id AND item.organization_id = owned.organization_id
          AND item.environment = owned.environment
      WHERE ${predicates[kind]}
        AND (item.observation_claim_until IS NULL OR item.observation_claim_until <= now())
      ORDER BY item.id FOR UPDATE OF item SKIP LOCKED
    ) UPDATE ${tables[kind]} item SET observation_claim_token = ?,
      observation_claim_until = now() + make_interval(secs => ?),
          observation_due_at = now() + make_interval(secs => ${EARN_OBSERVATION_LEASE_SECONDS})
      FROM candidates WHERE item.id = candidates.id RETURNING item.*`,
    [
      rows.map((row) => row.id),
      rows.map((row) => row.organization_id),
      rows.map((row) => row.environment),
      token,
      EARN_OBSERVATION_LEASE_SECONDS,
    ]
  );
  return { rows: claimed, ids: new Set(claimed.map((row) => row.id)), token };
}

/** A delayed recovery pass cannot act after its claim expired or changed hands. */
export async function renewEarnObservation(
  db: DatabaseClient,
  kind: EarnObservationKind,
  row: { id: string; organization_id: string; environment: SdpEnvironment },
  token: string
): Promise<boolean> {
  const renewed = await db.queryOne<{ id: string }>(
    `UPDATE ${tables[kind]} item
      SET observation_claim_until = now() + make_interval(secs => ?),
          observation_due_at = now() + make_interval(secs => ${EARN_OBSERVATION_LEASE_SECONDS})
      WHERE id = ? AND organization_id = ? AND environment = ?
        AND observation_claim_token = ? AND observation_claim_until > now()
        AND ${predicates[kind]} RETURNING id`,
    [EARN_OBSERVATION_LEASE_SECONDS, row.id, row.organization_id, row.environment, token]
  );
  return renewed !== null;
}

/** Only the current owner can release or reschedule a row after a takeover. */
export function releaseEarnObservation(
  db: DatabaseClient,
  kind: EarnObservationKind,
  row: { id: string; organization_id: string; environment: SdpEnvironment },
  token: string,
  delayMs: number
): Promise<void> {
  return releaseEarnObservations(db, kind, [row], token, delayMs);
}

/** Batch scheduler writes instead of one round trip per signature. */
export async function releaseEarnObservations(
  db: DatabaseClient,
  kind: EarnObservationKind,
  rows: readonly { id: string; organization_id: string; environment: SdpEnvironment }[],
  token: string,
  delayMs: number
): Promise<void> {
  await db.execute(
    `UPDATE ${tables[kind]} item SET observation_claim_token = NULL,
      observation_claim_until = NULL,
      observation_due_at = CASE WHEN ${predicates[kind]}
        THEN now() + (? * interval '1 millisecond') ELSE NULL END
      FROM unnest(?::text[], ?::text[], ?::text[]) AS owned(id, organization_id, environment)
      WHERE item.id = owned.id AND item.organization_id = owned.organization_id
        AND item.environment = owned.environment AND item.observation_claim_token = ?`,
    [
      delayMs,
      rows.map((row) => row.id),
      rows.map((row) => row.organization_id),
      rows.map((row) => row.environment),
      token,
    ]
  );
}

/** Recent signatures stay responsive; old or unreadable work does not monopolize RPC. */
export function earnObservationDelay(createdAt: string, failed: boolean): number {
  if (failed) return 5_000;
  return Date.now() - Date.parse(createdAt) < 120_000 ? 250 : 30_000;
}
