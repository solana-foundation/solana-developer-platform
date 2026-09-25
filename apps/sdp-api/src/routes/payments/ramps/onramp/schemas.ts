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
  // Embedding host for Coinbase's payment link (browser origin hostname, no scheme or port);
  // forwarded to Coinbase, which only accepts CDP-registered hosts. IP literals are accepted
  // here so a dashboard on 127.0.0.1 or [::1] can quote; the client drops local ones.
  domain: z.union([z.hostname(), z.ipv4(), z.ipv6()]).optional(),
});
