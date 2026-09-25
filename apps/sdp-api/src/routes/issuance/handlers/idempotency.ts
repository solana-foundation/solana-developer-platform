import type { Context } from "hono";
import type { DatabaseExecutor } from "@/db";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import { conflict } from "@/lib/errors";
import { normalizeForFingerprint } from "@/lib/idempotency";
import type { AuditIntent, AuditService } from "@/services/audit.service";
import type { Env } from "@/types/env";

export interface IdempotencyContext {
  tokenId: string;
  operation: string;
  mode: string;
  params: unknown;
}

export interface IdempotencyMetadata {
  idempotencyKey?: string;
  idempotencyFingerprint?: string;
}

export const buildIdempotencyFingerprint = (input: IdempotencyContext): string =>
  JSON.stringify({
    operation: input.operation,
    mode: input.mode,
    tokenId: input.tokenId,
    params: normalizeForFingerprint(input.params),
  });

export const buildIdempotencyMetadata = (
  idempotencyKey: string | null | undefined,
  context: IdempotencyContext
): IdempotencyMetadata => {
  if (!idempotencyKey) {
    return {};
  }

  return {
    idempotencyKey,
    idempotencyFingerprint: buildIdempotencyFingerprint(context),
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// Issuance creation idempotency (APE-719 / SOLA9-195)
// ═══════════════════════════════════════════════════════════════════════════

/** Discriminates which creation route claimed a key. */
export const ISSUANCE_CREATE_IDEMPOTENCY_SCOPES = {
  tokenCreate: "token_create",
  assetProfileCreate: "asset_profile_create",
} as const;

export type IssuanceCreateIdempotencyScope =
  (typeof ISSUANCE_CREATE_IDEMPOTENCY_SCOPES)[keyof typeof ISSUANCE_CREATE_IDEMPOTENCY_SCOPES];

/**
 * Thrown when a concurrent request won the INSERT race for a creation key.
 * The losing transaction must roll back so no second pair exists; the caller
 * then re-resolves the committed record and replays or conflicts on it.
 */
export class IssuanceCreateIdempotencyRaceError extends Error {
  constructor(cause: unknown) {
    super("A concurrent request committed this issuance idempotency key first", { cause });
    this.name = "IssuanceCreateIdempotencyRaceError";
  }
}

export interface IssuanceCreateFingerprintInput {
  scope: IssuanceCreateIdempotencyScope;
  organizationId: string;
  projectId: string;
  body: unknown;
}

/** Normalized request fingerprint bound into a creation idempotency record. */
export const buildIssuanceCreateFingerprint = (input: IssuanceCreateFingerprintInput): string =>
  JSON.stringify(normalizeForFingerprint(input));

export interface IssuanceCreateRecordParams {
  scope: IssuanceCreateIdempotencyScope;
  organizationId: string;
  projectId: string;
  idempotencyKey: string;
}

/**
 * Resolve a prior committed admission for a creation key. Returns the token
 * id to replay, or null when the key is unclaimed. A key already bound to a
 * different request payload is a conflict, mirroring the money-movement
 * idempotency contract in @/lib/idempotency.
 */
export async function resolveIssuanceCreateReplay(
  db: DatabaseExecutor,
  params: IssuanceCreateRecordParams & { fingerprint: string }
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT token_id, request_fingerprint
         FROM issuance_create_idempotency
        WHERE organization_id = ? AND project_id = ? AND scope = ? AND idempotency_key = ?`
    )
    .bind(params.organizationId, params.projectId, params.scope, params.idempotencyKey)
    .first<{ token_id: string; request_fingerprint: string }>();
  if (!row) {
    return null;
  }
  if (row.request_fingerprint !== params.fingerprint) {
    throw conflict("Idempotency key already used with different request payload");
  }
  return row.token_id;
}

/**
 * Resolve the audit intent admitted before a failed creation attempt: the
 * ledger must carry an outcome, not an unresolved intent. Returns true when
 * the failure was the lost INSERT race against a concurrent identical request
 * (whose committed record the caller should replay).
 */
export async function completeFailedIssuanceCreate(params: {
  c: Context<{ Bindings: Env }>;
  auditService: AuditService;
  auditIntent: AuditIntent;
  error: unknown;
}): Promise<boolean> {
  const superseded = params.error instanceof IssuanceCreateIdempotencyRaceError;
  await params.auditService.completeCritical(params.c, params.auditIntent, {
    status: "failure",
    metadata: {
      error: superseded
        ? "Superseded by a concurrent identical request that committed this idempotency key"
        : params.error instanceof Error
          ? params.error.message
          : "Unknown error",
    },
  });
  return superseded;
}

/**
 * Bind a creation key to its generated token id inside the SAME transaction
 * that creates the token (and its default profile). The unique constraint is
 * the concurrency authority: a loser's INSERT no-ops, this throws, and the
 * loser's whole transaction — token row included — rolls back.
 */
export async function reserveIssuanceCreateRecord(
  tx: DatabaseExecutor,
  params: IssuanceCreateRecordParams & { fingerprint: string; tokenId: string }
): Promise<void> {
  try {
    const reserved = await tx
      .prepare(
        `INSERT INTO issuance_create_idempotency
           (id, organization_id, project_id, scope, idempotency_key, request_fingerprint, token_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (organization_id, project_id, scope, idempotency_key) DO NOTHING
         RETURNING id`
      )
      .bind(
        `ici_${crypto.randomUUID()}`,
        params.organizationId,
        params.projectId,
        params.scope,
        params.idempotencyKey,
        params.fingerprint,
        params.tokenId
      )
      .first<{ id: string }>();
    if (!reserved) {
      throw new IssuanceCreateIdempotencyRaceError(null);
    }
  } catch (error) {
    if (error instanceof IssuanceCreateIdempotencyRaceError) {
      throw error;
    }
    // A bare unique violation (constraint inferred without the conflict
    // target, or an older driver path) means the same race.
    if (isPostgresUniqueViolation(error)) {
      throw new IssuanceCreateIdempotencyRaceError(error);
    }
    throw error;
  }
}
