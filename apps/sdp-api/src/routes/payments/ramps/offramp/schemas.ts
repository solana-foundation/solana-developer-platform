import { z } from "zod";
import { paymentAmountSchema } from "../../schemas";
import {
  offrampCryptoRailSchema,
  rampDestinationCountrySchema,
  rampFiatCurrencySchema,
  rampProviderSchema,
  rampsMemoSchema,
} from "../schemas";

export const listOfframpCurrenciesQuerySchema = z.object({
  source: offrampCryptoRailSchema.optional(),
  dest: rampFiatCurrencySchema.optional(),
  provider: rampProviderSchema.optional(),
});

export const estimateOfframpSchema = z.strictObject({
  assetRail: offrampCryptoRailSchema,
  fiatCurrency: rampFiatCurrencySchema,
  cryptoAmount: paymentAmountSchema,
});

const offrampQuoteBaseShape = {
  counterpartyId: z.string().min(1),
  sourceCustodyWalletId: z.string().min(1),
  assetRail: offrampCryptoRailSchema,
  cryptoAmount: paymentAmountSchema,
  rampsMemo: rampsMemoSchema.optional(),
};

export const createOfframpQuoteSchema = z.discriminatedUnion("provider", [
  z.strictObject({
    provider: z.literal("lightspark"),
    ...offrampQuoteBaseShape,
    fiatCurrency: rampFiatCurrencySchema,
    destinationCountry: rampDestinationCountrySchema,
    providerAccountId: z.string().min(1).optional(),
  }),
  z.strictObject({
    provider: z.enum(["moonpay", "bvnk", "moneygram", "mural", "coinbase", "stripe"]),
    ...offrampQuoteBaseShape,
    fiatCurrency: rampFiatCurrencySchema.optional(),
  }),
]);
