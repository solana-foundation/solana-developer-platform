import type { DatabaseExecutor } from "./client";

const POSTGRES_UNIQUE_VIOLATION = "23505";

export function buildInClause(length: number): string {
  return Array.from({ length }, () => "?").join(", ");
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function isPostgresUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === POSTGRES_UNIQUE_VIOLATION
  );
}

/**
 * A keyed custody wallet create lost the race for its request id (migration
 * 0136): another attempt under the same key already recorded the wallet. The
 * losing insert can fail on either unique constraint: the request id's, or the
 * owner-and-wallet one when the provider deduped on the id and returned the
 * winner's own wallet. So the row is looked up by the request id instead of
 * judging the error by its constraint name.
 */
export async function isCustodyWalletRequestRecorded(
  db: DatabaseExecutor,
  error: unknown,
  requestId: string | null
): Promise<boolean> {
  if (requestId === null || !isPostgresUniqueViolation(error)) return false;
  const row = await db.queryOne<{ id: string }>(
    "SELECT id FROM custody_wallets WHERE idempotency_request_id = ?",
    [requestId]
  );
  return row !== null;
}

export function parsePostgresJson<T>(value: unknown): T {
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }
  return value as T;
}

export function parsePostgresJsonOr<T>(value: unknown, fallback: T): T {
  try {
    return parsePostgresJson<T>(value);
  } catch {
    return fallback;
  }
}

export function parseOptionalPostgresJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) {
    return null;
  }
  return parsePostgresJson<T>(value);
}

export function parseOptionalPostgresJsonOr<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }
  return parsePostgresJsonOr(value, fallback);
}

export function asPostgresJsonObject(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }
  return parsePostgresJson<Record<string, unknown>>(value);
}
