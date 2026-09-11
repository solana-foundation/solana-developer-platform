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
 * The human-readable half of a provider's HTTP error body. Both compliance
 * providers wrap their errors the same two ways; anything else travels as the
 * raw body, which is all an operator can act on anyway.
 */
export function extractProviderErrorMessage(body: string): string {
  if (!body) {
    return "";
  }

  try {
    const parsed = providerErrorBodySchema.safeParse(JSON.parse(body));
    if (parsed.success) {
      return parsed.data.error?.message ?? parsed.data.message ?? body;
    }
  } catch {
    // Not JSON at all: the raw body is the message.
  }

  return body;
}
