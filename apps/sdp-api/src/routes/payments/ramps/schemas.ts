import {
  COUNTRY_CODES,
  MURAL_SANDBOX_PAYIN_CURRENCIES,
  OFFRAMP_CRYPTO_RAILS,
  ONRAMP_CRYPTO_RAILS,
  RAMP_PROVIDERS,
  RAMPS_MEMO_LIMITS,
} from "@sdp/types";
import { RAMP_FIAT_CURRENCIES } from "@sdp/types/generated/ramp";
import { z } from "zod";

export const rampProviderSchema = z.enum(RAMP_PROVIDERS);
export const rampDirectionSchema = z.enum(["onramp", "offramp"]);
export const onrampCryptoRailSchema = z.enum(ONRAMP_CRYPTO_RAILS);
export const offrampCryptoRailSchema = z.enum(OFFRAMP_CRYPTO_RAILS);
export const rampFiatCurrencySchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
  z.enum(RAMP_FIAT_CURRENCIES)
);
export const rampDestinationCountrySchema = z.enum(COUNTRY_CODES);

export const rampsMemoSchema = z
  .record(
    z.string().min(1).max(RAMPS_MEMO_LIMITS.maxKeyLength),
    z.string().min(1).max(RAMPS_MEMO_LIMITS.maxValueLength)
  )
  .refine((value) => Object.keys(value).length <= RAMPS_MEMO_LIMITS.maxEntries, {
    message: `rampsMemo must contain at most ${RAMPS_MEMO_LIMITS.maxEntries} key-value pairs`,
  });

export const cancelRampTransferSchema = z.object({
  transferId: z.string().min(1),
});

const simulateLightsparkSandboxTransferPayloadSchema = z.object({
  quoteId: z.string().min(1),
  currencyCode: z.enum(["USD", "USDC"]).default("USD"),
  currencyAmount: z.number().int().positive().optional(),
});

const simulateBvnkSandboxPayinPayloadSchema = z.object({
  transferId: z.string().min(1),
});

const simulateMuralSandboxPayinPayloadSchema = z.object({
  counterpartyId: z.string().min(1),
  amount: z.number().positive(),
  fiatCurrency: z.enum(MURAL_SANDBOX_PAYIN_CURRENCIES),
});

export const simulateSandboxTransferSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("lightspark"),
    payload: simulateLightsparkSandboxTransferPayloadSchema,
  }),
  z.object({
    provider: z.literal("bvnk"),
    payload: simulateBvnkSandboxPayinPayloadSchema,
  }),
  z.object({
    provider: z.literal("mural"),
    payload: simulateMuralSandboxPayinPayloadSchema,
  }),
]);
