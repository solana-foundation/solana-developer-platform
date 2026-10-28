import { redactCredentialString } from "@sdp/redaction/credentials";
import {
  summarizeUpstreamErrorBody,
  UNKNOWN_UPSTREAM_ERROR_CODE,
} from "@sdp/redaction/upstream-error";
import { prettifyError, z } from "zod";

/**
 * One-line rendering of why a provider response failed its schema, for the
 * operator-facing `message` on a failed screening. `prettifyError` names the
 * offending field, which is the part an on-call reader needs.
 */
export function describeSchemaFailure(error: z.ZodError): string {
  return prettifyError(error).replace(/\s+/g, " ").trim();
}

const providerErrorBodySchema = z.object({
  error: z.object({ message: z.string() }).optional(),
  message: z.string().optional(),
});

/**
 * Upper bound on provider-authored prose kept in a client-facing message.
 */
const PROVIDER_MESSAGE_MAX_LENGTH = 200;

/**
 * The human-readable half of a provider's HTTP error body, made safe to return
 * to the API client.
 *
 * Upstream error bodies routinely echo request headers, credential ids, or key
 * material back to us, so they must never reach a client or log verbatim
 * (`@sdp/redaction/upstream-error` states the rule). Only the two known
 * envelope shapes yield their `message` prose, credential-scrubbed and
 * truncated; every other body — free-form HTML, unknown JSON — collapses to a
 * single identifier-shaped code from the redaction package, or to nothing when
 * it has none to give.
 */
export function extractProviderErrorMessage(body: string, httpStatus?: number): string {
  if (!body) {
    return "";
  }

  let prose: string | undefined;
  try {
    const parsed = providerErrorBodySchema.safeParse(JSON.parse(body));
    if (parsed.success) {
      prose = parsed.data.error?.message ?? parsed.data.message;
    }
  } catch {
    // Not JSON at all: the code summary below decides what survives.
  }

  if (prose === undefined) {
    const code = summarizeUpstreamErrorBody(body, httpStatus);
    return code === UNKNOWN_UPSTREAM_ERROR_CODE ? "" : code;
  }

  return redactCredentialString(prose)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PROVIDER_MESSAGE_MAX_LENGTH);
}
