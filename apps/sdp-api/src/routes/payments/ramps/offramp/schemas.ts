import { z } from "zod";
import {
  offrampCryptoRailSchema,
  rampFiatCurrencySchema,
  rampProviderSchema,
  rampsMemoSchema,
} from "@/routes/payments/ramps/schemas";
import { paymentAmountSchema } from "@/routes/payments/schemas";

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

export const createOfframpQuoteSchema = z.strictObject({
  provider: z.enum(["moonpay", "stripe"]),
  ...offrampQuoteBaseShape,
  fiatCurrency: rampFiatCurrencySchema.optional(),
});
