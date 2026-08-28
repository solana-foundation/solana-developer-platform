import type { HeliusRingsErrorCode, ProjectRing, RingStatus } from "@sdp/helius-rings";

export function generateHeliusRingsProjectRingId(): string {
  return `hrr_${crypto.randomUUID()}`;
}

export interface HeliusRingsProjectRingRow {
  id: string;
  organization_id: string;
  project_id: string;
  ring_program_id: string;
  status: RingStatus;
  /** Uncompressed SEC1 P-256 hex; null until bring-up succeeds. */
  auditor_public_key: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface HeliusRingsRingScope {
  organizationId: string;
  projectId: string;
}

export interface ReserveHeliusRingsProjectRingInput extends HeliusRingsRingScope {
  ringProgramId: string;
}

export interface MarkHeliusRingsProjectRingActiveInput extends HeliusRingsRingScope {
  ringProgramId: string;
  auditorPublicKey: string;
}

export interface MarkHeliusRingsProjectRingFailedInput extends HeliusRingsRingScope {
  ringProgramId: string;
  failureCode: string;
  failureMessage: string;
}

export interface HeliusRingsProjectRingRepository {
  /**
   * Reserves the one ring allowed per project. On a replay it returns the row
   * already there — whatever its program id — so the caller can tell a resume
   * from an attempt to point the project at a second ring.
   */
  reserveRing(input: ReserveHeliusRingsProjectRingInput): Promise<HeliusRingsProjectRingRow | null>;
  getByProject(scope: HeliusRingsRingScope): Promise<HeliusRingsProjectRingRow | null>;
  /**
   * Replaces the recorded program id and resets the row to `pending`, but only
   * while the ring has never been active — no SDP deposit can have bound a note
   * to it yet, so correcting a mistyped id strands nothing. Null means the ring
   * is active (re-pointing it would strand its notes) or the row is gone.
   */
  repointRing(input: ReserveHeliusRingsProjectRingInput): Promise<HeliusRingsProjectRingRow | null>;
  /**
   * Guarded on the program id, not on status: a resumed bring-up re-activates a
   * `failed` row, but never one that was re-pointed under it.
   */
  markActive(
    input: MarkHeliusRingsProjectRingActiveInput
  ): Promise<HeliusRingsProjectRingRow | null>;
  markFailed(
    input: MarkHeliusRingsProjectRingFailedInput
  ): Promise<HeliusRingsProjectRingRow | null>;
}

/** Row to domain object; the caller already knows the scope it queried by. */
export function mapHeliusRingsProjectRingRow(row: HeliusRingsProjectRingRow): ProjectRing {
  return {
    ringProgramId: row.ring_program_id,
    status: row.status,
    auditorPublicKeyHex: row.auditor_public_key ?? null,
    failure:
      row.failure_code && row.failure_message !== null
        ? { code: row.failure_code as HeliusRingsErrorCode, message: row.failure_message }
        : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
