import type { AppDb } from "@/db";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import {
  generateHeliusRingsProjectRingId,
  type HeliusRingsProjectRingRepository,
  type HeliusRingsProjectRingRow,
  type HeliusRingsRingKey,
  type MarkHeliusRingsProjectRingActiveInput,
  type MarkHeliusRingsProjectRingFailedInput,
  type RecordHeliusRingsLookupTableInput,
  type ReserveHeliusRingsProjectRingInput,
} from "./helius-rings-project-ring.repository";
import type { HeliusRingsProjectScope } from "./helius-rings-wallet.repository";

function mapRow(row: Record<string, unknown>): HeliusRingsProjectRingRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    name: row.name as string,
    ring_program_id: row.ring_program_id as string,
    status: row.status as HeliusRingsProjectRingRow["status"],
    auditor_public_key: (row.auditor_public_key ?? null) as string | null,
    lookup_table_address: (row.lookup_table_address ?? null) as string | null,
    failure_code: (row.failure_code ?? null) as string | null,
    failure_message: (row.failure_message ?? null) as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/**
 * The write raced UNIQUE(project_id, ring_program_id): another of the
 * project's rings already claims this program.
 */
function isProgramInUseViolation(error: unknown): boolean {
  return (
    isPostgresUniqueViolation(error) &&
    (error as { constraint?: string }).constraint ===
      "idx_helius_rings_project_rings_project_program"
  );
}

async function firstRow(
  db: AppDb,
  sql: string,
  binds: readonly unknown[]
): Promise<HeliusRingsProjectRingRow | null> {
  const row = await db
    .prepare(sql)
    .bind(...binds)
    .first<Record<string, unknown>>();
  return row ? mapRow(row) : null;
}

export function createPostgresHeliusRingsProjectRingRepository(
  db: AppDb
): HeliusRingsProjectRingRepository {
  return {
    async reserveRing(input: ReserveHeliusRingsProjectRingInput) {
      const id = generateHeliusRingsProjectRingId();
      try {
        return await firstRow(
          db,
          `INSERT INTO helius_rings_project_rings (
             id,
             organization_id,
             project_id,
             name,
             ring_program_id
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (project_id, name)
           -- Self-assignment so RETURNING * emits the row that already exists,
           -- program id and all: the caller decides whether that is a resume
           -- or a refused re-point of the name.
           DO UPDATE SET updated_at = helius_rings_project_rings.updated_at
           RETURNING *`,
          [id, input.organizationId, input.projectId, input.name, input.ringProgramId]
        );
      } catch (error) {
        if (isProgramInUseViolation(error)) return "program_in_use";
        throw error;
      }
    },

    async listByProject(scope: HeliusRingsProjectScope) {
      const result = await db
        .prepare(
          `SELECT * FROM helius_rings_project_rings
            WHERE organization_id = ? AND project_id = ?
            ORDER BY created_at ASC, id ASC`
        )
        .bind(scope.organizationId, scope.projectId)
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },

    async getByName(key: HeliusRingsRingKey) {
      return firstRow(
        db,
        `SELECT * FROM helius_rings_project_rings
          WHERE organization_id = ? AND project_id = ? AND name = ?`,
        [key.organizationId, key.projectId, key.name]
      );
    },

    async getByProgramId(input) {
      return firstRow(
        db,
        `SELECT * FROM helius_rings_project_rings
          WHERE organization_id = ? AND project_id = ? AND ring_program_id = ?`,
        [input.organizationId, input.projectId, input.ringProgramId]
      );
    },

    async repointRing(input: ReserveHeliusRingsProjectRingInput) {
      try {
        return await firstRow(
          db,
          `UPDATE helius_rings_project_rings
              SET ring_program_id = ?,
                  status = 'pending',
                  auditor_public_key = NULL,
                  -- A new program means a new table: the old one addresses
                  -- PDAs derived under the old program. (No apostrophes in
                  -- this comment: the client only quote-tracks, and one here
                  -- would eat the placeholders below.)
                  lookup_table_address = NULL,
                  failure_code = NULL,
                  failure_message = NULL,
                  updated_at = sdp_iso_now()
            WHERE organization_id = ?
              AND project_id = ?
              AND name = ?
              -- Once active, the ring's notes are bound to the recorded
              -- program; the guard also loses cleanly against a concurrent
              -- activation.
              AND status <> 'active'
          RETURNING *`,
          [input.ringProgramId, input.organizationId, input.projectId, input.name]
        );
      } catch (error) {
        if (isProgramInUseViolation(error)) return "program_in_use";
        throw error;
      }
    },

    async recordLookupTable(input: RecordHeliusRingsLookupTableInput) {
      return firstRow(
        db,
        `UPDATE helius_rings_project_rings
            SET lookup_table_address = ?,
                updated_at = sdp_iso_now()
          WHERE organization_id = ?
            AND project_id = ?
            AND ring_program_id = ?
        RETURNING *`,
        [input.lookupTableAddress, input.organizationId, input.projectId, input.ringProgramId]
      );
    },

    async markActive(input: MarkHeliusRingsProjectRingActiveInput) {
      return firstRow(
        db,
        `UPDATE helius_rings_project_rings
            SET status = 'active',
                auditor_public_key = ?,
                lookup_table_address = ?,
                failure_code = NULL,
                failure_message = NULL,
                updated_at = sdp_iso_now()
          WHERE organization_id = ?
            AND project_id = ?
            AND name = ?
            AND ring_program_id = ?
        RETURNING *`,
        [
          input.auditorPublicKey,
          input.lookupTableAddress,
          input.organizationId,
          input.projectId,
          input.name,
          input.ringProgramId,
        ]
      );
    },

    async markFailed(input: MarkHeliusRingsProjectRingFailedInput) {
      return firstRow(
        db,
        `UPDATE helius_rings_project_rings
            SET status = 'failed',
                failure_code = ?,
                failure_message = ?,
                updated_at = sdp_iso_now()
          WHERE organization_id = ?
            AND project_id = ?
            AND name = ?
            AND ring_program_id = ?
            -- An active ring's bring-up already confirmed on chain; a late
            -- failure from a lost race must not un-activate it.
            AND status <> 'active'
        RETURNING *`,
        [
          input.failureCode,
          input.failureMessage,
          input.organizationId,
          input.projectId,
          input.name,
          input.ringProgramId,
        ]
      );
    },
  };
}
