import { canonicalizeDecimalFields, canonicalJson, type JsonValue } from "@/lib/idempotency";

/**
 * The Idempotency-Key fingerprint form of a create-batch body (HOO-1918):
 * recipients with canonical amounts ("1.0" and "1" move the same), sorted by
 * their own canonical JSON, because the order they are listed in does not
 * change what moves (APE-667), and empty `options` dropped, because `{}` and no
 * options mean the same. Anything that is not a recipients array is left as
 * sent; validation refuses it.
 */
export function canonicalizeTransferBatchBody(body: JsonValue): JsonValue {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  const recipients = body.recipients;
  if (!Array.isArray(recipients)) {
    return body;
  }
  const { options, ...rest } = body;
  const emptyOptions =
    options !== null &&
    typeof options === "object" &&
    !Array.isArray(options) &&
    Object.keys(options).length === 0;
  const canonical: { [key: string]: JsonValue } = {
    ...rest,
    recipients: recipients
      .map((recipient) => canonicalizeDecimalFields(recipient, ["amount"]))
      .sort((a, b) => compareCodeUnits(canonicalJson(a), canonicalJson(b))),
  };
  if (options !== undefined && !emptyOptions) {
    canonical.options = options;
  }
  return canonical;
}

/** Orders strings by UTF-16 code unit, independent of the runtime's locale: -1, 0 or 1. */
function compareCodeUnits(left: string, right: string): number {
  return Number(left > right) - Number(left < right);
}
