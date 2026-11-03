import { STAGED_PROVIDER_REFUSAL_REASONS } from "@sdp/types/custody";
import { RAMP_FIAT_CURRENCIES } from "@sdp/types/generated/ramp";
import { SOLANA_CRYPTO_RAILS } from "@sdp/types/payment-rails";
import { RAMP_AMOUNT_LIMIT_REASONS, RAMP_DIRECTIONS } from "@sdp/types/payments";
import { RAMP_PROVIDERS } from "@sdp/types/provider-access";
import { z } from "zod";
import {
  createOfframpQuoteSchema,
  estimateOfframpSchema,
} from "@/routes/payments/ramps/offramp/schemas";
import { estimateOnrampSchema } from "@/routes/payments/ramps/onramp/schemas";
import { cancelRampTransferSchema } from "@/routes/payments/ramps/schemas";
import { withOpenApi } from "./base";
import { onrampQuoteResponseSchema } from "./payments";

export const estimateOnrampRequestSchema = withOpenApi(estimateOnrampSchema, {
  description: "Fiat amount and rail to estimate across eligible on-ramp providers.",
});
export const estimateOfframpRequestSchema = withOpenApi(estimateOfframpSchema, {
  description: "Crypto amount and fiat currency to estimate across eligible off-ramp providers.",
});
export const createOfframpQuoteRequestSchema = createOfframpQuoteSchema.extend({
  sourceCustodyWalletId: withOpenApi(createOfframpQuoteSchema.shape.sourceCustodyWalletId, {
    description: "Exact SDP wallet record ID (id returned by GET /v1/wallets).",
  }),
  fiatCurrency: withOpenApi(createOfframpQuoteSchema.shape.fiatCurrency, {
    description:
      "Optional payout currency. The existing MoonPay handler defaults an omitted currency to USD.",
  }),
});
export const cancelRampTransferRequestSchema = withOpenApi(cancelRampTransferSchema, {
  description: "SDP ramp transfer record ID to cancel.",
});

export const offrampQuoteResponseSchema = withOpenApi(
  onrampQuoteResponseSchema.extend({
    quote: withOpenApi(onrampQuoteResponseSchema.shape.quote, {
      description: "Off-ramp provider quote details.",
    }),
  }),
  { description: "Off-ramp quote response payload." }
);

const estimateSchema = z.object({
  provider: z.enum(RAMP_PROVIDERS),
  direction: z.enum(RAMP_DIRECTIONS),
  fiatCurrency: z.enum(RAMP_FIAT_CURRENCIES),
  assetRail: z.enum(SOLANA_CRYPTO_RAILS),
  fiatAmount: z.string(),
  cryptoAmount: z.string(),
  exchangeRate: z.string(),
  totalFiatAmount: z.string().optional(),
  fees: z.object({
    currency: z.string(),
    total: z.string(),
    network: z.string().optional(),
    networkCurrency: z.string().optional(),
    provider: z.string().optional(),
    providerCurrency: z.string().optional(),
  }),
  minFiatAmount: z.string().optional(),
  maxFiatAmount: z.string().optional(),
  expiresAt: z.string().optional(),
});

export const rampEstimatesResponseSchema = z.object({
  estimates: z.array(
    z.discriminatedUnion("status", [
      z.object({
        provider: z.enum(RAMP_PROVIDERS),
        status: z.literal("ok"),
        estimate: estimateSchema,
      }),
      z.object({ provider: z.enum(RAMP_PROVIDERS), status: z.literal("unsupported") }),
      z.object({
        provider: z.enum(RAMP_PROVIDERS),
        status: z.literal("error"),
        error: z.string(),
        reason: z
          .enum([...STAGED_PROVIDER_REFUSAL_REASONS, ...RAMP_AMOUNT_LIMIT_REASONS])
          .optional(),
        limit: z.object({ amount: z.string(), currency: z.string() }).optional(),
      }),
    ])
  ),
});
