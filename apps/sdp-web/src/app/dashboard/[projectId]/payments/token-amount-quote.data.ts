import {
  TOKEN_MOVEMENT_BASES,
  type TokenAmountQuote,
  type TokenMovementBasis,
  type TokenTermsSummary,
} from "@sdp/types/token-movements";
import { z } from "zod";
import type { MessageKey } from "@/i18n/messages";
import type { TranslationValues } from "@/i18n/translate";
import { dashboardFetch } from "@/lib/dashboard-fetch";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

/**
 * What an amount input holds (ADR 0012): token units, which the API takes,
 * or display units, which a scaled or interest-bearing mint's wallets show.
 * A display amount is only ever sent to the quote route, never as a movement.
 */
export const AMOUNT_ENTRY_UNITS = ["token", "display"] as const;

export type AmountEntryUnit = (typeof AMOUNT_ENTRY_UNITS)[number];

const transferFeeEntrySchema = z.object({
  epoch: z.string(),
  basisPoints: z.number(),
  maximumFee: z.string(),
});

/** The parts of a mint's terms the amount input reads. */
const tokenTermsSchema = z.object({
  mint: z.string(),
  decimals: z.number().int().nonnegative(),
  transferFee: z
    .object({ current: transferFeeEntrySchema, next: transferFeeEntrySchema })
    .nullable(),
  display: z.discriminatedUnion("rule", [
    z.object({ rule: z.literal("plain") }),
    z.object({
      rule: z.literal("scaled"),
      multiplier: z.number(),
      newMultiplier: z.number(),
      newMultiplierEffectiveAt: z.string(),
    }),
    z.object({
      rule: z.literal("interest"),
      currentRate: z.number(),
      preUpdateAverageRate: z.number(),
      initializedAt: z.string(),
      lastUpdateAt: z.string(),
    }),
  ]),
}) satisfies z.ZodType<Pick<TokenTermsSummary, "mint" | "decimals" | "transferFee" | "display">>;

export type TokenAmountTerms = z.infer<typeof tokenTermsSchema>;

const tokenTermsEnvelopeSchema = z.object({ data: z.object({ terms: tokenTermsSchema }) });

const tokenAmountQuoteSchema = z.object({
  mint: z.string(),
  amount: z.string(),
  amounts: z.object({
    basis: z.enum(TOKEN_MOVEMENT_BASES),
    debit: z.string(),
    fee: z.string(),
    credit: z.string(),
    decimals: z.number().int().nonnegative(),
    display: z
      .object({ debit: z.string(), fee: z.string(), credit: z.string(), asOf: z.string() })
      .optional(),
  }),
  feeEpoch: z.string().nullable(),
  asOf: z.string(),
  expiresAt: z.string(),
}) satisfies z.ZodType<TokenAmountQuote>;

const tokenAmountQuoteEnvelopeSchema = z.object({
  data: z.object({ quote: tokenAmountQuoteSchema }),
});

/** What the quote route prices: exactly one of a token amount and a display amount. */
export type TokenAmountQuoteRequest =
  | { amount: string; basis: TokenMovementBasis }
  | { displayAmount: string; basis: TokenMovementBasis };

/**
 * The quote request for one entry.
 *
 * @param unit - What `value` is in.
 * @param value - The amount the user typed.
 * @param basis - The side of the movement the amount fixes.
 */
export function tokenAmountQuoteRequest(
  unit: AmountEntryUnit,
  value: string,
  basis: TokenMovementBasis
): TokenAmountQuoteRequest {
  switch (unit) {
    case "token":
      return { amount: value, basis };
    case "display":
      return { displayAmount: value, basis };
    default: {
      const unreachable: never = unit;
      throw new Error(`Unknown amount entry unit: ${String(unreachable)}`);
    }
  }
}

/**
 * The token amount a quote fixes, in token units: the debit for a debit
 * quote, the credit for a credit quote. This is the amount a movement or a
 * payment request sends.
 */
export function quotedTokenAmount(quote: TokenAmountQuote): string {
  switch (quote.amounts.basis) {
    case "debit":
      return quote.amount;
    case "credit":
      return quote.amounts.credit;
    default: {
      const unreachable: never = quote.amounts.basis;
      throw new Error(`Unknown movement basis: ${String(unreachable)}`);
    }
  }
}

/** Whether a quote may still be submitted at `now` (epoch ms). */
export function isQuoteCurrent(quote: TokenAmountQuote, now: number): boolean {
  return Date.parse(quote.expiresAt) > now;
}

/**
 * Reads a mint's terms through the dashboard proxy.
 *
 * @throws {Error} With the API's message when the read fails, or when the answer does not parse.
 */
export async function fetchTokenAmountTerms(mint: string, t: Translate): Promise<TokenAmountTerms> {
  const res = await dashboardFetch(`/api/dashboard/tokens/${encodeURIComponent(mint)}/terms`);
  if (!res.ok) throw new Error(res.error);
  const parsed = tokenTermsEnvelopeSchema.safeParse(res.data);
  if (!parsed.success) throw new Error(t("DashboardPayments.tokenAmount.termsInvalid"));
  return parsed.data.data.terms;
}

/**
 * Prices an amount under the mint's live terms through the dashboard proxy.
 *
 * @throws {Error} With the API's message when the quote is refused, or when the answer does not parse.
 */
export async function fetchTokenAmountQuote(
  mint: string,
  request: TokenAmountQuoteRequest,
  t: Translate
): Promise<TokenAmountQuote> {
  const res = await dashboardFetch(`/api/dashboard/tokens/${encodeURIComponent(mint)}/quote`, {
    method: "POST",
    body: request,
  });
  if (!res.ok) throw new Error(res.error);
  const parsed = tokenAmountQuoteEnvelopeSchema.safeParse(res.data);
  if (!parsed.success) throw new Error(t("DashboardPayments.tokenAmount.quoteInvalid"));
  return parsed.data.data.quote;
}
