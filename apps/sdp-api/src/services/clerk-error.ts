/**
 * Clerk returns failures as `{"errors":[{"message":"…","long_message":"…"}]}`.
 * Reporting only "Clerk request failed" leaves an operator with a 500 and no
 * way to tell a bad redirect URL from a duplicate invitation, so the reason is
 * folded into the thrown message while the raw body stays in the details.
 */
export function describeClerkFailure(status: number, body: string): string {
  const reason = extractClerkReason(body);
  return reason
    ? `Clerk request failed (${status}): ${reason}`
    : `Clerk request failed (${status})`;
}

const MAX_REASON_LENGTH = 300;

/** Applied to every branch: a parsed message is no more bounded than a raw body. */
function truncate(value: string): string {
  return value.length > MAX_REASON_LENGTH ? `${value.slice(0, MAX_REASON_LENGTH)}…` : value;
}

function extractClerkReason(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      errors?: Array<{ message?: string; long_message?: string }>;
      message?: string;
    };

    const first = parsed.errors?.[0];
    // long_message is the human-readable form; message is the short code-ish one.
    const reason = first?.long_message ?? first?.message ?? parsed.message;
    if (reason) {
      return truncate(reason);
    }
  } catch {
    // Not JSON — fall through and use the raw text.
  }

  return truncate(trimmed);
}
