import { compareDecimalAmounts, isDecimalString } from "@sdp/solana/amount";
import { z } from "zod";
import { AMOUNT_ENTRY_UNITS } from "@/app/dashboard/[projectId]/payments/token-amount-quote.data";

/**
 * The amount fields of a form that takes a token amount (ADR 0012), as the
 * form holds them while the user edits: what was typed in each unit, and
 * which unit the input is in. A form adds `.shape` to its own schema; its
 * step schemas check the input the unit names.
 */
export const tokenAmountFieldsSchema = z.object({
  /** What the amount input holds: token units, or what wallets show. */
  amountUnit: z.enum(AMOUNT_ENTRY_UNITS),
  /** What the user typed in token units. */
  amount: z.string(),
  /** What the user typed as wallets show it. Only ever priced, never sent. */
  displayAmount: z.string(),
});

export type TokenAmountFields = z.input<typeof tokenAmountFieldsSchema>;

/**
 * A display amount the quote route prices: a decimal above zero, as the API's
 * amount check reads it.
 */
export const displayAmountSchema = z
  .string()
  .trim()
  .refine(isDecimalString, { abort: true, message: "Enter a valid amount." })
  .refine((value) => compareDecimalAmounts(value, "0") > 0, "Enter an amount greater than 0.");
