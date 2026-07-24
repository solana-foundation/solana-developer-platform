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
