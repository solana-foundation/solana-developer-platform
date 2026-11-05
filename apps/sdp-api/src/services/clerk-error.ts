import { z } from "zod";
import { AppError, type ErrorResponse, PUBLIC_INTERNAL_ERROR_MESSAGE } from "@/lib/errors";

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

/** The part of Clerk's error body that names what went wrong, by code. */
const clerkErrorBodySchema = z.object({
  errors: z.array(z.object({ code: z.string() })),
});

/**
 * A failed Clerk Backend API call. The message carries Clerk's reason for the
 * logs, and `details` its status and body for the callers that branch on them,
 * but neither reaches the response: Clerk's wording describes Clerk's state, not
 * anything a dashboard user can act on, so they see the generic internal error.
 */
export class ClerkRequestError extends AppError {
  constructor(status: number, body: string) {
    super("INTERNAL_ERROR", describeClerkFailure(status, body), { status, body });
    this.name = "ClerkRequestError";
  }

  /** Clerk's machine-readable code for its first error, when the body names one. */
  get clerkCode(): string | null {
    const body = this.details?.body;
    if (typeof body !== "string") {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
    return clerkErrorBodySchema.safeParse(parsed).data?.errors[0]?.code ?? null;
  }

  override toResponse(): ErrorResponse {
    return { error: { code: "INTERNAL_ERROR", message: PUBLIC_INTERNAL_ERROR_MESSAGE } };
  }
}
