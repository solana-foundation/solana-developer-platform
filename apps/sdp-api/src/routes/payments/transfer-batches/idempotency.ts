import { canonicalizeDecimalFields, canonicalJson, type JsonValue } from "@/lib/idempotency";
import { DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION } from "./transaction";

/**
 * Option values the create route applies when an option is omitted
 * (`create.ts`), so sending one explicitly is the same batch (APE-665).
 */
const OPTION_DEFAULTS: Readonly<Record<string, JsonValue>> = {
  maxRecipientsPerTransaction: DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION,
  preflight: true,
};

/**
 * The Idempotency-Key fingerprint form of a create-batch body (HOO-1918):
 * recipients with canonical amounts ("1.0" and "1" move the same), sorted by
 * their own canonical JSON, because the order they are listed in does not
 * change what moves (APE-667), and options at their default value dropped,
 * then empty `options`, because `{}`, no options and an explicit default mean
 * the same (APE-665). Anything that is not a recipients array is left as
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
  const { options: sentOptions, ...rest } = body;
  const options = withoutDefaultOptions(sentOptions);
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

/** `options` without the entries that equal their default; anything else as sent. */
function withoutDefaultOptions(options: JsonValue | undefined): JsonValue | undefined {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    return options;
  }
  return Object.fromEntries(
    Object.entries(options).filter(([name, value]) => OPTION_DEFAULTS[name] !== value)
  );
}

/** Orders strings by UTF-16 code unit, independent of the runtime's locale: -1, 0 or 1. */
function compareCodeUnits(left: string, right: string): number {
  return Number(left > right) - Number(left < right);
}
