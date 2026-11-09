import { currentClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import { type DatabaseExecutor, getDb } from "@/db/client";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";

/**
 * How far above its busiest hour of the baseline an hour must go to be
 * flagged: by value or by count, per organization, movement kind and mint.
 */
export const MONEY_MOVEMENT_ANOMALY_FACTOR = 5;
/** The baseline: the hours before the one being checked. */
export const MONEY_MOVEMENT_BASELINE_HOURS = 7 * 24;
/**
 * Hours with any movement the baseline needs before it judges an hour. An
 * organization with less history has no baseline yet, and is not flagged.
 */
export const MONEY_MOVEMENT_MIN_BASELINE_ACTIVE_HOURS = 3;

const HOUR_MS = 60 * 60 * 1000;

/** One flagged (organization, kind, mint) hour. Amounts are decimal token amounts. */
export interface MoneyMovementAnomaly {
  organizationId: string;
  /** `transfer`, `transfer_batch` (one chunk per row), `recurring`, or another transfer type. */
  kind: string;
  token: string;
  count: number;
  value: string;
  baselineMaxCount: number;
  baselineMaxValue: string;
  baselineActiveHours: number;
}

export interface MoneyMovementAnomalyScan {
  hourStart: string;
  anomalies: MoneyMovementAnomaly[];
}

interface AnomalyRow {
  organization_id: string;
  kind: string;
  token: string;
  count: number;
  value: string;
  baseline_max_count: number;
  baseline_max_value: string;
  baseline_active_hours: number;
}

/**
 * Flags an organization whose outbound money movement in the hour that just
 * ended went well above its own busiest hour of the past week (SDP-021 SA-5,
 * HOO-2346). Runs once per Environment, hourly, and logs one
 * `sdp_api_money_movement_anomaly` per flagged hour, which pages, plus one
 * `sdp_api_money_movement_anomaly_scan` per run, so a run that stops is seen.
 *
 * Every transfer, batch chunk and recurring collection is a `payment_transfers`
 * row, so one grouped read covers them all. Each mint is compared only with
 * itself, so no price or decimals are needed, and the comparisons stay in
 * Postgres `numeric`. A failed row moved nothing and is left out.
 *
 * @param env - Process environment.
 * @param now - The clock, for tests.
 * @param db - The database, for tests.
 * @returns The hour checked and what was flagged.
 */
export async function detectMoneyMovementAnomalies(
  env: Env,
  now: Date = new Date(),
  db: DatabaseExecutor = getDb(env)
): Promise<MoneyMovementAnomalyScan> {
  const { environment } = currentClusterScope();
  const hourEnd = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  const hourStart = new Date(hourEnd - HOUR_MS).toISOString();
  const baselineStart = new Date(
    hourEnd - (MONEY_MOVEMENT_BASELINE_HOURS + 1) * HOUR_MS
  ).toISOString();
  const rows = await readAnomalies(db, {
    environment,
    baselineStart,
    hourStart,
    hourEnd: new Date(hourEnd).toISOString(),
  });
  const anomalies = rows.map(
    (row): MoneyMovementAnomaly => ({
      organizationId: row.organization_id,
      kind: row.kind,
      token: row.token,
      count: row.count,
      value: row.value,
      baselineMaxCount: row.baseline_max_count,
      baselineMaxValue: row.baseline_max_value,
      baselineActiveHours: row.baseline_active_hours,
    })
  );
  for (const anomaly of anomalies) {
    getLogger().warn(
      {
        event: "sdp_api_money_movement_anomaly",
        environment,
        hour_start: hourStart,
        organization_id: anomaly.organizationId,
        kind: anomaly.kind,
        // Named mint: a bare "token" key is scrubbed as a credential.
        mint: anomaly.token,
        count: anomaly.count,
        value: anomaly.value,
        baseline_max_count: anomaly.baselineMaxCount,
        baseline_max_value: anomaly.baselineMaxValue,
        baseline_active_hours: anomaly.baselineActiveHours,
      },
      "money movement above the organization's busiest hour of the past week"
    );
  }
  getLogger().info(
    {
      event: "sdp_api_money_movement_anomaly_scan",
      environment,
      hour_start: hourStart,
      flagged: anomalies.length,
    },
    "money movement anomaly scan"
  );
  return { hourStart, anomalies };
}

async function readAnomalies(
  db: DatabaseExecutor,
  window: {
    environment: SdpEnvironment;
    baselineStart: string;
    hourStart: string;
    hourEnd: string;
  }
): Promise<AnomalyRow[]> {
  // created_at is an ISO-8601 UTC string, so a string range selects the
  // window. The hour bucket is truncated in UTC, never the session's time
  // zone: an offset like +05:30 would put every bucket at :30 and miss the
  // hour checked.
  const result = await db
    .prepare(
      `WITH hourly AS (
         SELECT pt.organization_id,
                CASE
                  WHEN pt.type = 'transfer' AND pt.provider_data->>'recurringPaymentId' IS NOT NULL
                    THEN 'recurring'
                  ELSE pt.type
                END AS kind,
                pt.token,
                date_trunc('hour', pt.created_at::timestamptz, 'UTC') AS hour,
                count(*)::int AS count,
                sum(pt.amount::numeric) AS value
           FROM payment_transfers pt
           JOIN projects p ON p.id = pt.project_id
          WHERE p.environment = ?
            AND pt.direction = 'outbound'
            AND pt.status <> 'failed'
            AND pt.created_at >= ?
            AND pt.created_at < ?
          GROUP BY 1, 2, 3, 4
       ),
       checked AS (
         SELECT * FROM hourly WHERE hour = ?::timestamptz
       ),
       baseline AS (
         SELECT organization_id, kind, token,
                max(count) AS max_count,
                max(value) AS max_value,
                count(*)::int AS active_hours
           FROM hourly
          WHERE hour < ?::timestamptz
          GROUP BY 1, 2, 3
       )
       SELECT c.organization_id, c.kind, c.token, c.count, c.value::text AS value,
              b.max_count AS baseline_max_count,
              b.max_value::text AS baseline_max_value,
              b.active_hours AS baseline_active_hours
         FROM checked c
         JOIN baseline b USING (organization_id, kind, token)
        WHERE b.active_hours >= ?
          AND (c.value > b.max_value * ? OR c.count > b.max_count * ?)
        ORDER BY c.organization_id, c.kind, c.token`
    )
    .bind(
      window.environment,
      window.baselineStart,
      window.hourEnd,
      window.hourStart,
      window.hourStart,
      MONEY_MOVEMENT_MIN_BASELINE_ACTIVE_HOURS,
      MONEY_MOVEMENT_ANOMALY_FACTOR,
      MONEY_MOVEMENT_ANOMALY_FACTOR
    )
    .all<AnomalyRow>();
  return result.results;
}
