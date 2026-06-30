import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";
import type { RequirementField } from "@sdp/types/ramp-requirements";
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
export const depositAmountSchema = depositSelectionSchema.pick({
  walletId: true,
  amount: true,
  provider: true,
});
export const sourceWalletSchema = withdrawSelectionSchema.pick({ walletId: true });
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

const onchainAmount = z
  .string()
  .trim()
  .refine((value) => /^\d+(\.\d{1,9})?$/.test(value), "Enter a valid amount.")
  .transform(Number)
  .refine((value) => value > 0, "Enter an amount greater than 0.");

export const onchainSendSelectionSchema = z.object({
  accountId: z.string().min(1, "Select a destination account."),
  walletId: z.string().min(1, "Select a source wallet."),
  asset: z.string().min(1, "Select an asset."),
  amount: onchainAmount,
});

export const onchainDestinationSchema = onchainSendSelectionSchema.pick({ accountId: true });
export const onchainDetailsSchema = onchainSendSelectionSchema.pick({
  walletId: true,
  asset: true,
  amount: true,
});

export const onchainSendSchema = z.object({
  accountId: z.string(),
  walletId: z.string(),
  asset: z.string(),
  amount: z.string(),
  memo: z.string(),
});

export type OnchainSendFields = z.input<typeof onchainSendSchema>;

export const batchRecipientSchema = z.object({
  counterpartyId: z.string().min(1),
  counterpartyAccountId: z.string().min(1),
  amount: onchainAmount,
});

export const MAX_BATCH_RECIPIENTS = 500;

export const batchSendSchema = z.object({
  walletId: z.string().min(1, "Select a source wallet."),
  asset: z.string().min(1, "Select an asset."),
  recipients: z
    .array(batchRecipientSchema)
    .min(1, "Add at least one recipient.")
    .max(MAX_BATCH_RECIPIENTS),
});

export function applyRequirementMask(mask: string, raw: string): string {
  const digits = raw.replace(/\D/g, "");
  let out = "";
  let next = 0;
  for (const slot of mask) {
    if (next >= digits.length) break;
    if (slot === "#") {
      out += digits[next];
      next += 1;
    } else {
      out += slot;
    }
  }
  return out;
}

export function requirementFieldError(
  field: RequirementField,
  raw: string | undefined
): string | null {
  const value = raw === undefined ? "" : raw.trim();
  if (value.length === 0) {
    return field.required ? `${field.label} is required.` : null;
  }
  if (field.kind === "select") {
    return field.options.some((option) => option.value === value)
      ? null
      : `Select a valid ${field.label.toLowerCase()}.`;
  }
  if (field.minLength !== undefined && value.length < field.minLength) {
    return `${field.label} must be at least ${field.minLength} characters.`;
  }
  if (field.maxLength !== undefined && value.length > field.maxLength) {
    return `${field.label} must be at most ${field.maxLength} characters.`;
  }
  if (field.pattern !== undefined && !new RegExp(field.pattern).test(value)) {
    return `${field.label} doesn't match the expected format${field.placeholder ? ` (e.g. ${field.placeholder})` : ""}.`;
  }
  return null;
}
