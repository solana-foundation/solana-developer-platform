const POSTGRES_UNIQUE_VIOLATION = "23505";

export function isPostgresUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === POSTGRES_UNIQUE_VIOLATION
  );
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

export function asPostgresJsonArray(value: unknown): Record<string, unknown>[] {
  if (!value) {
    return [];
  }
  return parsePostgresJson<Record<string, unknown>[]>(value);
}
