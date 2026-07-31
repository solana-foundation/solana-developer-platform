import { decimalScale, isDecimalString } from "@sdp/solana/amount";
import { z } from "zod";

/** Positive default-USDC decimal amount with at most six fractional digits. */
export const privateChannelTransferAmountSchema = z
  .string()
  .trim()
  .refine((value) => isDecimalString(value), { message: "Invalid amount format", abort: true })
  .refine((value) => /[1-9]/.test(value), { message: "Amount must be greater than zero" })
  .refine((value) => decimalScale(value) <= 6, { message: "Amount has too many decimal places" });
