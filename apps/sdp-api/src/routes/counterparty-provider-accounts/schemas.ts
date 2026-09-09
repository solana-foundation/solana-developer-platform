import { COUNTRY_CODES } from "@sdp/types";
import { RAMP_PROVIDERS } from "@sdp/types/provider-access";
import { z } from "zod";

export const counterpartyProviderAccountParamsSchema = z.object({
  counterpartyId: z.string().min(1),
});

export const listCounterpartyProviderAccountsQuerySchema = z.object({
  provider: z.enum(RAMP_PROVIDERS).optional(),
  fiatCurrency: z.string().min(1).optional(),
  destinationCountry: z.enum(COUNTRY_CODES).optional(),
});
