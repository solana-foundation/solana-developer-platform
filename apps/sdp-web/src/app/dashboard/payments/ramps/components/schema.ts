import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";
import { z } from "zod";

export const depositSelectionSchema = z.object({
  walletId: z.string().min(1, "Select a destination wallet."),
  amount: z.coerce
    .number<string>()
    .min(1, "Enter an amount of at least 1.")
    .multipleOf(0.01, "Only up to two decimal places allowed."),
  provider: z.enum(RAMP_PROVIDERS).nullable().refine((v): v is RampProviderId => v !== null, "Choose a provider."),
  counterpartyId: z.string().min(1, "Select a counterparty."),
});

export const INITIAL_ONRAMP_FIELDS = { walletId: "", amount: "", provider: null, counterpartyId: "" };
