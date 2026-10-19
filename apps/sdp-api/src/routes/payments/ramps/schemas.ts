import { COUNTRY_CODES } from "@sdp/types/countries";
import { RAMP_FIAT_CURRENCIES } from "@sdp/types/generated/ramp";
import { OFFRAMP_CRYPTO_RAILS, ONRAMP_CRYPTO_RAILS } from "@sdp/types/payment-rails";
import { RAMPS_MEMO_LIMITS } from "@sdp/types/payments";
import { RAMP_PROVIDERS } from "@sdp/types/provider-access";
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

export const simulateSandboxTransferSchema = z.strictObject({
  transferId: z.string().min(1),
});
