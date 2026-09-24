import { z } from "zod";
import { paymentAmountSchema } from "../../schemas";
import {
  onrampCryptoRailSchema,
  rampFiatCurrencySchema,
  rampProviderSchema,
  rampsMemoSchema,
} from "../schemas";

export const listOnrampCurrenciesQuerySchema = z.object({
  source: rampFiatCurrencySchema.optional(),
  dest: onrampCryptoRailSchema.optional(),
  provider: rampProviderSchema.optional(),
});

export const estimateOnrampSchema = z.strictObject({
  assetRail: onrampCryptoRailSchema,
  fiatCurrency: rampFiatCurrencySchema,
  fiatAmount: paymentAmountSchema,
});

export const createOnrampQuoteSchema = z.strictObject({
  provider: rampProviderSchema,
  counterpartyId: z.string().min(1),
  destinationCustodyWalletId: z.string().min(1),
  assetRail: onrampCryptoRailSchema,
  fiatCurrency: rampFiatCurrencySchema,
  fiatAmount: paymentAmountSchema,
  rampsMemo: rampsMemoSchema.optional(),
  // Embedding domain for Coinbase's Apple Pay payment link (browser origin host).
  domain: z.string().min(1).optional(),
});
