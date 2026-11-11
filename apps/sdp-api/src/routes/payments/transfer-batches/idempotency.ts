import { canonicalJson } from "@sdp/types/idempotency";
import { canonicalizeDecimalFields, type JsonValue } from "@/lib/idempotency";
import { normalizePaymentToken } from "@/services/payment-operation.service";

/**
 * The Idempotency-Key fingerprint form of a create-batch body (HOO-1918):
 * recipients with canonical amounts ("1.0" and "1" move the same), sorted by
 * their own canonical JSON, because the order they are listed in does not
 * change what moves (APE-667), and the token as the mint it executes as.
 * Anything that is not a recipients array is left as sent; validation refuses it.
 */
export function canonicalizeTransferBatchBody(body: JsonValue): JsonValue {
  const canonical = canonicalBatchBody(body);
  if (canonical === null || typeof canonical !== "object" || Array.isArray(canonical)) {
    return canonical;
  }
  // The mint the batch executes as: a symbol and its mint move the same asset (APE SOLA9-695).
  const { token } = canonical;
  return typeof token === "string"
    ? { ...canonical, token: normalizePaymentToken(token) }
    : canonical;
}

/**
 * {@link canonicalizeTransferBatchBody} with the token as sent, so a key or
 * batch row saved under that form still matches its retry (`previousCanonicalize`).
 */
export function previousCanonicalTransferBatchBody(body: JsonValue): JsonValue {
  return canonicalBatchBody(body);
}

function canonicalBatchBody(body: JsonValue): JsonValue {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  const recipients = body.recipients;
  if (!Array.isArray(recipients)) {
    return body;
  }
  return {
    ...body,
    recipients: recipients
      .map((recipient) => canonicalizeDecimalFields(recipient, ["amount"]))
      .sort((a, b) => compareCodeUnits(canonicalJson(a), canonicalJson(b))),
  };
}

/** Orders strings by UTF-16 code unit, independent of the runtime's locale: -1, 0 or 1. */
function compareCodeUnits(left: string, right: string): number {
  return Number(left > right) - Number(left < right);
}
