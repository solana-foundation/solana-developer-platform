export function isRotationDeadlineReached(
  rotationDeadline: string | null | undefined,
  now = Date.now()
): boolean {
  if (!rotationDeadline) {
    return false;
  }

  const deadline = Date.parse(rotationDeadline);
  // Rotation deadlines are generated internally as ISO timestamps. Fail closed
  // if persisted data is malformed rather than silently keeping the key active.
  return !Number.isFinite(deadline) || deadline <= now;
}

/** The live `api_keys` columns that decide whether a key may still authenticate. */
export interface ApiKeyLifecycleColumns {
  status: string;
  expires_at: string | null;
  rotation_deadline: string | null;
}

/**
 * Why a key's live row can no longer authenticate, or null while it can: it
 * must be `active`, not past its expiry, and not past its rotation grace
 * period (a rotated key stays `active` in the row and is retired by the
 * deadline alone). Every live re-check of a key applies this one predicate.
 */
export function apiKeyRowRefusal(
  row: ApiKeyLifecycleColumns,
  now = Date.now()
): "revoked" | "expired" | null {
  if (row.status === "expired") {
    return "expired";
  }
  if (row.status !== "active") {
    return "revoked";
  }
  if (row.expires_at && new Date(row.expires_at).getTime() < now) {
    return "expired";
  }
  if (isRotationDeadlineReached(row.rotation_deadline, now)) {
    return "expired";
  }
  return null;
}
