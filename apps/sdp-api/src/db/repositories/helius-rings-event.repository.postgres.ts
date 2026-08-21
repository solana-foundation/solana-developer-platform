import type { AppDb } from "@/db";
import {
  type AppendHeliusRingsEventInput,
  DEFAULT_RINGS_EVENT_LIST_LIMIT,
  generateHeliusRingsEventId,
  type HeliusRingsEventRepository,
  type HeliusRingsEventRow,
  type ListHeliusRingsEventsInput,
  redactHeliusRingsEventPayload,
} from "./helius-rings-event.repository";

function mapRow(row: Record<string, unknown>): HeliusRingsEventRow {
  return {
    id: row.id as string,
    operation_id: row.operation_id as string,
    kind: row.kind as string,
    payload: (row.payload ?? null) as Record<string, unknown> | null,
    created_at: row.created_at as string,
  };
}

export function createPostgresHeliusRingsEventRepository(db: AppDb): HeliusRingsEventRepository {
  return {
    async append(input: AppendHeliusRingsEventInput) {
      const id = generateHeliusRingsEventId();
      // Redact before the value ever reaches the driver, so nothing sensitive
      // exists in a query log or a statement parameter either.
      const payload =
        input.payload === undefined || input.payload === null
          ? null
          : JSON.stringify(redactHeliusRingsEventPayload(input.payload));
      const row = await db
        .prepare(
          `INSERT INTO helius_rings_events (id, operation_id, kind, payload)
           VALUES (?, ?, ?, ?::jsonb)
           RETURNING *`
        )
        .bind(id, input.operationId, input.kind, payload)
        .first<Record<string, unknown>>();
      if (!row) {
        throw new Error("helius rings event append returned no row");
      }
      return mapRow(row);
    },

    async listByOperation(input: ListHeliusRingsEventsInput) {
      const result = await db
        .prepare(
          `SELECT * FROM helius_rings_events
            WHERE operation_id = ?
            ORDER BY created_at ASC, id ASC
            LIMIT ?`
        )
        .bind(input.operationId, input.limit ?? DEFAULT_RINGS_EVENT_LIST_LIMIT)
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },
  };
}
