import { canonicalJson, type JsonValue } from "@/lib/idempotency";

/**
 * The Idempotency-Key fingerprint form of a create-batch body (HOO-1918):
 * recipients sorted by their own canonical JSON, because the order they are
 * listed in does not change what moves (APE-667). Anything that is not a
 * recipients array is left as sent; validation refuses it.
 */
export function canonicalizeTransferBatchBody(body: JsonValue): JsonValue {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  const recipients = body.recipients;
  if (!Array.isArray(recipients)) {
    return body;
  }
  return {
    ...body,
    recipients: [...recipients].sort((a, b) => {
      const left = canonicalJson(a);
      const right = canonicalJson(b);
      return left < right ? -1 : left > right ? 1 : 0;
    }),
  };
}
