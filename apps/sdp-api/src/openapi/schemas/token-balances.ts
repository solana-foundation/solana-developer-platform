import { TOKEN_DISPLAY_RULES } from "@sdp/types/token-movements";
import { z } from "zod";

/**
 * A held amount in its three units (ADR 0012), shared by every balance
 * response. Display is computed from the summed base units under the mint's
 * Token Terms, never taken from the RPC.
 */
export const tokenBalanceAmountFields = {
  amount: z.string().openapi({
    description: "Base units, summed over every token account the wallet holds for the mint.",
    example: "1250000",
  }),
  tokenAmount: z.string().openapi({
    description:
      "Token units: `amount` ÷ 10^decimals, as a decimal string. Use it for balance checks and as the most a transfer can send.",
    example: "1.25",
  }),
  displayAmount: z.string().openapi({
    description:
      "What a wallet shows for `amount` under the mint's display rule: equal to `tokenAmount` for most tokens, multiplied on a scaled UI amount mint, with interest accrued on an interest-bearing mint (approximate, it changes every second). For screens only; never send it as an amount.",
    example: "1.25",
  }),
  displayAsOf: z.string().datetime().nullable().openapi({
    description:
      "The chain time `displayAmount` was computed at (ISO 8601). Null under the `plain` rule, where display never changes.",
    example: null,
  }),
  displayRule: z.enum(TOKEN_DISPLAY_RULES).openapi({
    description:
      "How the mint's wallets show an amount: `plain` (token units), `scaled` (Token-2022 scaled UI amount) or `interest` (Token-2022 interest-bearing).",
    example: "plain",
  }),
  decimals: z.number().int().nonnegative().openapi({ description: "Token decimals.", example: 6 }),
  usdPrice: z.number().optional().openapi({
    description: "Resolved USD price per token when available.",
    example: 1,
  }),
  usdValue: z.number().optional().openapi({
    description:
      "Resolved USD value of `displayAmount` when pricing is available: a token's price refers to what its wallets show.",
    example: 1.25,
  }),
};
