import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";
import { z } from "zod";

export const depositSelectionSchema = z.object({
  walletId: z.string().min(1, "Select a destination wallet."),
  amount: z
    .string()
    .trim()
    .refine((value) => /^\d+(\.\d{1,2})?$/.test(value), "Only up to two decimal places allowed.")
    .transform(Number)
    .refine((value) => value >= 1, "Enter an amount of at least 1."),
  provider: z
    .enum(RAMP_PROVIDERS)
    .nullable()
    .refine((v): v is RampProviderId => v !== null, "Choose a provider."),
  counterpartyId: z.string().min(1, "Select a counterparty."),
});

export const counterpartySelectionSchema = depositSelectionSchema.pick({ counterpartyId: true });

export const depositAmountSchema = depositSelectionSchema.pick({
  walletId: true,
  amount: true,
  provider: true,
});

export const INITIAL_ONRAMP_FIELDS = {
  walletId: "",
  amount: "",
  provider: null,
  counterpartyId: "",
};
