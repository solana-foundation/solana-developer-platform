import { assertIsAddress, isAddress } from "@sdp/solana/address";
import { isDecimalString } from "@sdp/solana/amount";
import { isWellKnownTokenSymbol } from "@sdp/types";
import {
  getI64Encoder,
  getU64Encoder,
  isSolanaError,
  SOLANA_ERROR__ADDRESSES__INVALID_BYTE_LENGTH,
  SOLANA_ERROR__ADDRESSES__STRING_LENGTH_OUT_OF_RANGE,
  SOLANA_ERROR__CODECS__INVALID_STRING_FOR_BASE,
} from "@solana/kit";
import { z } from "zod";
import { SOL_MINT } from "@/services/payment-operation.service";

export function solanaAddressSchema(fieldName: string) {
  return z
    .string()
    .trim()
    .superRefine((value, ctx) => {
      try {
        assertIsAddress(value);
      } catch (error) {
        if (isSolanaError(error, SOLANA_ERROR__ADDRESSES__STRING_LENGTH_OUT_OF_RANGE)) {
          ctx.addIssue({
            code: "custom",
            message: `${fieldName} must be 32 to 44 characters (got ${error.context.actualLength})`,
            input: value,
          });
          return;
        }
        if (isSolanaError(error, SOLANA_ERROR__CODECS__INVALID_STRING_FOR_BASE)) {
          ctx.addIssue({
            code: "custom",
            message: `${fieldName} contains characters outside the base58 alphabet`,
            input: value,
          });
          return;
        }
        if (isSolanaError(error, SOLANA_ERROR__ADDRESSES__INVALID_BYTE_LENGTH)) {
          ctx.addIssue({
            code: "custom",
            message: `${fieldName} must decode to 32 bytes (got ${error.context.actualLength})`,
            input: value,
          });
          return;
        }
        throw error;
      }
    });
}

// Payments token field: a well-known token symbol (SOL, USDC, ...) or a base58
// Solana mint address. Trim and case-fold symbols in a preprocess so validation
// matches `normalizePaymentToken` (which resolves well-known symbols to the
// configured cluster's mint). A single refine (rather than a union with
// `.min(32)`) avoids generic "String must contain at least 32 character(s)"
// errors for short inputs like `"BTC"`.
export const PAYMENT_TOKEN_VALIDATION_MESSAGE =
  "token must be a well-known token symbol (e.g. 'SOL', 'USDC') or a base58 Solana mint address";

export const paymentTokenSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    const symbol = trimmed.toUpperCase();
    return isWellKnownTokenSymbol(symbol) ? symbol : trimmed;
  },
  z.string().refine(
    (value) => {
      if (isWellKnownTokenSymbol(value) || value === SOL_MINT) return true;
      return value.length >= 32 && value.length <= 44 && isAddress(value);
    },
    { message: PAYMENT_TOKEN_VALIDATION_MESSAGE }
  )
);

export const transferIdParamsSchema = z.object({
  transferId: z.string().min(1),
});

export const paymentAmountSchema = z
  .string()
  .refine((value) => isDecimalString(value), { message: "Invalid amount format" })
  // Avoid adding a second error when the decimal-format check already failed.
  .refine((value) => !isDecimalString(value) || /[1-9]/.test(value), {
    message: "Amount must be greater than zero",
  });

export const recurringTimestampSchema = z.string().datetime({ offset: true });
export const u64StringSchema = z
  .string()
  .regex(/^\d+$/, { message: "Value must be an unsigned integer string" })
  .refine((value) => {
    try {
      getU64Encoder().encode(BigInt(value));
      return true;
    } catch {
      return false;
    }
  }, "Value must fit in an unsigned 64-bit integer");
export const i64StringSchema = z
  .string()
  .regex(/^-?\d+$/, { message: "Value must be a signed integer string" })
  .refine((value) => {
    try {
      getI64Encoder().encode(BigInt(value));
      return true;
    } catch {
      return false;
    }
  }, "Value must fit in a signed 64-bit integer");
