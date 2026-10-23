import { DEFAULT_TOKEN_MOVEMENT_BASIS, TOKEN_MOVEMENT_BASES } from "@sdp/types/token-movements";
import { z } from "zod";
import { paymentAmountSchema, solanaAddressSchema } from "@/routes/payments/schemas";

export const tokenMintParamsSchema = z.object({ mint: solanaAddressSchema("mint") });

const EXACTLY_ONE_AMOUNT = "Send exactly one of amount and displayAmount";

/**
 * A quote request names its amount in token units (`amount`) or in display
 * units (`displayAmount`, what a scaled or interest-bearing mint's wallets
 * show), never both. Both are positive decimal strings. `basis` defaults to
 * `debit`, as on every request amount.
 */
export const quoteTokenAmountSchema = z
  .strictObject({
    amount: paymentAmountSchema.optional(),
    displayAmount: paymentAmountSchema.optional(),
    basis: z.enum(TOKEN_MOVEMENT_BASES).default(DEFAULT_TOKEN_MOVEMENT_BASIS),
  })
  .transform((body, ctx) => {
    if (body.amount !== undefined && body.displayAmount === undefined) {
      return { input: "token" as const, amount: body.amount, basis: body.basis };
    }
    if (body.displayAmount !== undefined && body.amount === undefined) {
      return { input: "display" as const, displayAmount: body.displayAmount, basis: body.basis };
    }
    ctx.addIssue({ code: "custom", message: EXACTLY_ONE_AMOUNT, input: body });
    return z.NEVER;
  });
