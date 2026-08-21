import type { AppDb } from "@/db";
import type {
  HeliusRingsHealthRepository,
  HeliusRingsRuntimeHealthRow,
  RecordHeliusRingsHealthInput,
} from "./helius-rings-health.repository";

function mapRow(row: Record<string, unknown>): HeliusRingsRuntimeHealthRow {
  return {
    project_id: row.project_id as string,
    component: row.component as HeliusRingsRuntimeHealthRow["component"],
    status: row.status as HeliusRingsRuntimeHealthRow["status"],
    observed_at: row.observed_at as string,
    detail: (row.detail ?? null) as Record<string, string> | null,
  };
}

export function createPostgresHeliusRingsHealthRepository(db: AppDb): HeliusRingsHealthRepository {
  return {
    async recordHealth(input: RecordHeliusRingsHealthInput) {
      const detail =
        input.detail === undefined || input.detail === null ? null : JSON.stringify(input.detail);
      const row = await db
        .prepare(
          `INSERT INTO helius_rings_runtime_health (project_id, component, status, observed_at, detail)
           VALUES (?, ?, ?, sdp_iso_now(), ?::jsonb)
           ON CONFLICT (project_id, component)
           -- Overwrite in place: this table is a status board, not a history.
           -- observed_at moves even when the status is unchanged, because "still
           -- green as of a minute ago" and "green, last checked on Tuesday" are
           -- different answers for the operator staring at the diagnostics page.
           DO UPDATE SET
             status = EXCLUDED.status,
             observed_at = EXCLUDED.observed_at,
             detail = EXCLUDED.detail
           RETURNING *`
        )
        .bind(input.projectId, input.component, input.status, detail)
        .first<Record<string, unknown>>();
      if (!row) {
        throw new Error("helius rings recordHealth returned no row");
      }
      return mapRow(row);
    },

    async listHealthByProject(input: { projectId: string }) {
      const result = await db
        .prepare(
          `SELECT * FROM helius_rings_runtime_health
            WHERE project_id = ?
            ORDER BY component ASC`
        )
        .bind(input.projectId)
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },
  };
}
