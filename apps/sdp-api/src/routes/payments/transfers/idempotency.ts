import { TOKEN_MOVEMENT_BASES } from "@sdp/types/token-movements";
import { z } from "zod";
import { canonicalizeDecimalFields, type JsonValue } from "@/lib/idempotency";
import { canonicalizePaymentBody } from "@/routes/payments/fingerprint";
import { resolvePaymentAsset } from "@/services/payment-operation.service";
import { defaultTransferBasis } from "./schemas";

/** The fields of a create-transfer body its canonical form rewrites; the rest stay as sent. */
const intentFieldsSchema = z.looseObject({
  token: z.string(),
  transferId: z.string().optional(),
  amountBasis: z.enum(TOKEN_MOVEMENT_BASES).optional(),
});

/** "native" for native SOL, the mint for a token: one spelling per asset. */
function canonicalAsset(token: string): string {
  const asset = resolvePaymentAsset(token);
  return asset.kind === "native" ? "native" : asset.mint;
}

/**
 * The Idempotency-Key fingerprint form of a create-transfer body (ADR 0009,
 * ADR 0012): the canonical intent. `token` becomes `asset`, the asset it
 * names on the project's cluster, so "USDC" and its mint are one request and
 * the wrapped SOL mint is refused; the amount is canonical, so
 * "1.0" and "1" are one; and the basis has its default applied, so an omitted
 * and an explicit default `amountBasis` are one. No earlier form has an
 * `asset` key, so this form never equals one of them for another request. A
 * body that is not a create-transfer body is left as sent; validation refuses it.
 */
export function canonicalizeTransferBody(body: JsonValue): JsonValue {
  const fields = intentFieldsSchema.safeParse(body);
  const canonical = canonicalizeDecimalFields(body, ["amount"]);
  if (
    !fields.success ||
    canonical === null ||
    typeof canonical !== "object" ||
    Array.isArray(canonical)
  ) {
    return canonical;
  }
  const { token: _token, ...rest } = canonical;
  return {
    ...rest,
    asset: canonicalAsset(fields.data.token),
    amountBasis:
      fields.data.amountBasis === undefined
        ? defaultTransferBasis(fields.data)
        : fields.data.amountBasis,
  };
}

/**
 * The fingerprint form before ADR 0012 (`previousCanonicalForms`): the token as
 * the mint it executed as and the amount canonical (`canonicalizePaymentBody`),
 * so a key or row saved under it still answers its retry. No body had a basis
 * then: a default basis is dropped, so a retry that now names it still
 * matches, and any other basis is kept, so it never matches a movement
 * recorded on the default.
 */
export function previousCanonicalTransferBody(body: JsonValue): JsonValue {
  const fields = intentFieldsSchema.safeParse(body);
  if (
    !fields.success ||
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    fields.data.amountBasis !== defaultTransferBasis(fields.data)
  ) {
    return canonicalizePaymentBody(body);
  }
  const { amountBasis: _defaultBasis, ...asSentBefore } = body;
  return canonicalizePaymentBody(asSentBefore);
}
