/**
 * Determine whether an API response value can be inspected by key.
 *
 * @param value - Untrusted value parsed from an API response.
 * @returns Whether the value is a non-null record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Read a human-readable message from an untrusted API error envelope.
 *
 * @param value - Untrusted value parsed from an API response.
 * @returns The nested or top-level message, or null when neither is valid.
 */
export function readApiErrorMessage(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  const error = value.error;
  if (typeof error === "string") {
    return error;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }

  return typeof value.message === "string" ? value.message : null;
}

/**
 * Parse an API response body into a human-readable error message.
 *
 * @param body - Raw API response body.
 * @returns A validated API message, the raw body, or the generic error message.
 */
export function parseErrorMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    return readApiErrorMessage(parsed) ?? (body || "Unknown error");
  } catch {
    return body || "Unknown error";
  }
}
