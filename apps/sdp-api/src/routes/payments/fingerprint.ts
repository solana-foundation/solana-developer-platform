import { canonicalizeDecimalFields, type JsonValue } from "@/lib/idempotency";
import { normalizePaymentToken } from "@/services/payment-operation.service";

/**
 * The Idempotency-Key fingerprint form of a payment body (HOO-1918): `amount`
 * spelled canonically ("1.0" and "1" move the same) and `token` as the mint it
 * executes as on the scope's cluster ("USDC", its mint address and the native
 * SOL aliases each name one asset), so a retry that only re-spells either is
 * the same request and replays (APE SOLA9-734, SOLA9-759, SOLA9-695). Any
 * other field is left as sent; validation already ran.
 *
 * @param body - The validated request body.
 * @returns The body to fingerprint.
 * @throws AppError (400) when `token` names a mint the cluster does not have, as the handler would.
 */
export function canonicalizePaymentBody(body: JsonValue): JsonValue {
  const canonical = canonicalizeDecimalFields(body, ["amount"]);
  if (canonical === null || typeof canonical !== "object" || Array.isArray(canonical)) {
    return canonical;
  }
  const { token } = canonical;
  return typeof token === "string"
    ? { ...canonical, token: normalizePaymentToken(token) }
    : canonical;
}
