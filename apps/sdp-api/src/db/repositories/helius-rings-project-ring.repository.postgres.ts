import type { AppDb } from "@/db";
import {
  generateHeliusRingsProjectRingId,
  type HeliusRingsProjectRingRepository,
  type HeliusRingsProjectRingRow,
  type HeliusRingsRingScope,
  type MarkHeliusRingsProjectRingActiveInput,
  type MarkHeliusRingsProjectRingFailedInput,
  type ReserveHeliusRingsProjectRingInput,
} from "./helius-rings-project-ring.repository";

function mapRow(row: Record<string, unknown>): HeliusRingsProjectRingRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    ring_program_id: row.ring_program_id as string,
    status: row.status as HeliusRingsProjectRingRow["status"],
    auditor_public_key: (row.auditor_public_key ?? null) as string | null,
    failure_code: (row.failure_code ?? null) as string | null,
    failure_message: (row.failure_message ?? null) as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createPostgresHeliusRingsProjectRingRepository(
  db: AppDb
): HeliusRingsProjectRingRepository {
  return {
    async reserveRing(input: ReserveHeliusRingsProjectRingInput) {
      const id = generateHeliusRingsProjectRingId();
      const row = await db
        .prepare(
          `INSERT INTO helius_rings_project_rings (
             id,
             organization_id,
             project_id,
             ring_program_id
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT (project_id)
           -- Self-assignment so RETURNING * emits the row that already exists,
           -- program id and all: the caller decides whether that is a resume
           -- or a refused second ring.
           DO UPDATE SET updated_at = helius_rings_project_rings.updated_at
           RETURNING *`
        )
        .bind(id, input.organizationId, input.projectId, input.ringProgramId)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async repointRing(input: ReserveHeliusRingsProjectRingInput) {
      const row = await db
        .prepare(
          `UPDATE helius_rings_project_rings
              SET ring_program_id = ?,
                  status = 'pending',
                  auditor_public_key = NULL,
                  failure_code = NULL,
                  failure_message = NULL,
                  updated_at = sdp_iso_now()
            WHERE organization_id = ?
              AND project_id = ?
              -- Once active, the ring's notes are bound to the recorded
              -- program; the guard also loses cleanly against a concurrent
              -- activation.
              AND status <> 'active'
          RETURNING *`
        )
        .bind(input.ringProgramId, input.organizationId, input.projectId)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async getByProject(scope: HeliusRingsRingScope) {
      const row = await db
        .prepare(
          `SELECT * FROM helius_rings_project_rings
            WHERE organization_id = ? AND project_id = ?`
        )
        .bind(scope.organizationId, scope.projectId)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async markActive(input: MarkHeliusRingsProjectRingActiveInput) {
      const row = await db
        .prepare(
          `UPDATE helius_rings_project_rings
              SET status = 'active',
                  auditor_public_key = ?,
                  failure_code = NULL,
                  failure_message = NULL,
                  updated_at = sdp_iso_now()
            WHERE organization_id = ?
              AND project_id = ?
              AND ring_program_id = ?
          RETURNING *`
        )
        .bind(input.auditorPublicKey, input.organizationId, input.projectId, input.ringProgramId)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async markFailed(input: MarkHeliusRingsProjectRingFailedInput) {
      const row = await db
        .prepare(
          `UPDATE helius_rings_project_rings
              SET status = 'failed',
                  failure_code = ?,
                  failure_message = ?,
                  updated_at = sdp_iso_now()
            WHERE organization_id = ?
              AND project_id = ?
              AND ring_program_id = ?
              -- An active ring's bring-up already confirmed on chain; a late
              -- failure from a lost race must not un-activate it.
              AND status <> 'active'
          RETURNING *`
        )
        .bind(
          input.failureCode,
          input.failureMessage,
          input.organizationId,
          input.projectId,
          input.ringProgramId
        )
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },
  };
}
