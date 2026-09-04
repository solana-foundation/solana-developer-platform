import type { HeliusRingsErrorCode, ProjectRing, RingStatus } from "@sdp/helius-rings";
import type { HeliusRingsProjectScope } from "./helius-rings-wallet.repository";

export function generateHeliusRingsProjectRingId(): string {
  return `hrr_${crypto.randomUUID()}`;
}

export interface HeliusRingsProjectRingRow {
  id: string;
  organization_id: string;
  project_id: string;
  /** Operator-chosen slug operations select the ring by; "default" is reserved. */
  name: string;
  ring_program_id: string;
  status: RingStatus;
  /** Uncompressed SEC1 P-256 hex; null until bring-up succeeds. */
  auditor_public_key: string | null;
  /** The ring's address lookup table; null until bring-up lands it. */
  lookup_table_address: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
  updated_at: string;
}

/** A ring is addressed by its name inside the tenant scope. */
export interface HeliusRingsRingKey extends HeliusRingsProjectScope {
  name: string;
}

export interface ReserveHeliusRingsProjectRingInput extends HeliusRingsRingKey {
  ringProgramId: string;
}

export interface MarkHeliusRingsProjectRingActiveInput extends HeliusRingsRingKey {
  ringProgramId: string;
  auditorPublicKey: string;
  lookupTableAddress: string;
}

export interface MarkHeliusRingsProjectRingFailedInput extends HeliusRingsRingKey {
  ringProgramId: string;
  failureCode: string;
  failureMessage: string;
}

export interface RecordHeliusRingsLookupTableInput extends HeliusRingsProjectScope {
  ringProgramId: string;
  lookupTableAddress: string;
}

/**
 * A write that would register one program under two names in the project.
 * Surfaced as a value, not an exception: the caller turns it into a 409, and a
 * thrown unique violation would read as a 500.
 */
export type HeliusRingsProgramInUse = "program_in_use";

export interface HeliusRingsProjectRingRepository {
  /**
   * Reserves the named ring. On a replay it returns the row already under that
   * name — whatever its program id — so the caller can tell a resume from an
   * attempt to point the name at a second program.
   */
  reserveRing(
    input: ReserveHeliusRingsProjectRingInput
  ): Promise<HeliusRingsProjectRingRow | HeliusRingsProgramInUse | null>;
  /** All of the project's rings, oldest first. */
  listByProject(scope: HeliusRingsProjectScope): Promise<HeliusRingsProjectRingRow[]>;
  getByName(key: HeliusRingsRingKey): Promise<HeliusRingsProjectRingRow | null>;
  /** Well-defined per project thanks to UNIQUE(project_id, ring_program_id). */
  getByProgramId(
    input: HeliusRingsProjectScope & { ringProgramId: string }
  ): Promise<HeliusRingsProjectRingRow | null>;
  /**
   * Replaces the named ring's program id and resets the row to `pending`, but
   * only while the ring has never been active — no SDP deposit can have bound a
   * note to it yet, so correcting a mistyped id strands nothing. A new program
   * means a new lookup table, so the recorded one is cleared. Null means the
   * ring is active (re-pointing it would strand its notes) or the row is gone.
   */
  repointRing(
    input: ReserveHeliusRingsProjectRingInput
  ): Promise<HeliusRingsProjectRingRow | HeliusRingsProgramInUse | null>;
  /**
   * Persists the ring's lookup table on a still-pending row the moment it
   * lands, before bring-up finishes: a crash between the table confirming and
   * markActive resumes by adopting the table instead of renting a second one.
   * Keyed by program id (unique per project) rather than name because the
   * caller is the gateway's bring-up hook, which never sees names; the guard
   * also loses cleanly to a concurrent re-point.
   */
  recordLookupTable(
    input: RecordHeliusRingsLookupTableInput
  ): Promise<HeliusRingsProjectRingRow | null>;
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
    id: row.id,
    name: row.name,
    ringProgramId: row.ring_program_id,
    status: row.status,
    auditorPublicKeyHex: row.auditor_public_key ?? null,
    lookupTableAddress: row.lookup_table_address ?? null,
    failure:
      row.failure_code && row.failure_message !== null
        ? { code: row.failure_code as HeliusRingsErrorCode, message: row.failure_message }
        : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
