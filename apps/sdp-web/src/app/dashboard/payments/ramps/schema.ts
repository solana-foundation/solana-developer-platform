import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";
import { z } from "zod";

const providerField = z
  .enum(RAMP_PROVIDERS)
  .nullable()
  .refine((v): v is RampProviderId => v !== null, "Choose a provider.");

/**
 * Builds a direction's full selection schema. Only the wallet copy and the amount
 * rule differ between on-ramp (fiat amount) and off-ramp (crypto amount).
 */
function makeRampSelectionSchema(walletMessage: string, amount: z.ZodType<number, string>) {
  return z.object({
    walletId: z.string().min(1, walletMessage),
    amount,
    provider: providerField,
    counterpartyId: z.string().min(1, "Select a counterparty."),
  });
}

// Onramp (fiat -> crypto): amount is a fiat amount, so two decimal places.
const depositAmount = z
  .string()
  .trim()
  .refine((value) => /^\d+(\.\d{1,2})?$/.test(value), "Only up to two decimal places allowed.")
  .transform(Number)
  .refine((value) => value >= 1, "Enter an amount of at least 1.");

// Offramp (crypto -> fiat): amount is the crypto amount drawn from the selected
// source SDP wallet, so it allows more decimal places than a fiat amount.
const withdrawAmount = z
  .string()
  .trim()
  .refine((value) => /^\d+(\.\d{1,9})?$/.test(value), "Enter a valid crypto amount.")
  .transform(Number)
  .refine((value) => value > 0, "Enter an amount greater than 0.");

export const depositSelectionSchema = makeRampSelectionSchema(
  "Select a destination wallet.",
  depositAmount
);
export const withdrawSelectionSchema = makeRampSelectionSchema(
  "Select a source wallet.",
  withdrawAmount
);

// Per-step gating schemas.
export const counterpartySelectionSchema = depositSelectionSchema.pick({ counterpartyId: true });
export const depositAmountSchema = depositSelectionSchema.pick({
  walletId: true,
  amount: true,
  provider: true,
});
export const payoutCounterpartySchema = withdrawSelectionSchema.pick({
  counterpartyId: true,
  walletId: true,
});
export const withdrawAmountSchema = withdrawSelectionSchema.pick({
  amount: true,
  provider: true,
});

/**
 * Neutral field shape shared by both directions, used to type the wizard form.
 * The input shape is identical across on/off-ramp; only validation rules differ
 * (see {@link depositSelectionSchema} / {@link withdrawSelectionSchema}).
 */
export const rampSelectionSchema = z.object({
  walletId: z.string(),
  amount: z.string(),
  provider: z.enum(RAMP_PROVIDERS).nullable(),
  counterpartyId: z.string(),
});

export type RampFields = z.input<typeof rampSelectionSchema>;
