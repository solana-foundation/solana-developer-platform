import { compareDecimalAmounts } from "@sdp/solana/amount";
import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";
import {
  offeredCountryCodes,
  offeredFiatCurrencies,
  type RequirementField,
} from "@sdp/types/ramp-requirements";
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

export const ONCHAIN_AMOUNT_PATTERN = /^\d+(\.\d{1,9})?$/;

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
  .refine((value) => ONCHAIN_AMOUNT_PATTERN.test(value), "Enter a valid crypto amount.")
  .transform(Number)
  .refine((value) => value > 0, "Enter an amount greater than 0.");

/**
 * Coinbase's headless create-order refuses a quote without buyer contact, so the
 * deposit step gates on them for that provider alone. Required by provider
 * rather than outright: making them mandatory for all seven would block six
 * providers that never send them.
 *
 * The rule is deliberately shallow, because the provider is the authority. The
 * Coinbase client strips spaces, parens and hyphens and sends the rest
 * (packages/sdp-payments/src/ramps/providers/coinbase/client.ts), and the API
 * itself only requires a non-empty string. So this accepts the punctuation the
 * client removes and bounds the DIGITS by E.164, rather than inventing a
 * country-by-country rule that would reject real numbers.
 */
const BUYER_PHONE_ALLOWED_CHARACTERS = /^\+?[0-9 ()-]+$/;
const BUYER_PHONE_MIN_DIGITS = 7;
const BUYER_PHONE_MAX_DIGITS = 15;

const depositSelectionBase = makeRampSelectionSchema(
  "Select a destination wallet.",
  depositAmount
).extend({
  buyerEmail: z.string().trim(),
  buyerPhone: z.string().trim(),
});

const buyerEmailSchema = z.string().email();

/** Whether the value would satisfy Coinbase's create-order. */
export function isValidBuyerEmail(value: string): boolean {
  return buyerEmailSchema.safeParse(value.trim()).success;
}

/**
 * Counts digits rather than characters: `()---- --` is nine characters and no
 * phone number at all.
 */
export function isValidBuyerPhone(value: string): boolean {
  const trimmed = value.trim();
  if (!BUYER_PHONE_ALLOWED_CHARACTERS.test(trimmed)) {
    return false;
  }
  const digits = trimmed.replace(/[^0-9]/g, "").length;
  return digits >= BUYER_PHONE_MIN_DIGITS && digits <= BUYER_PHONE_MAX_DIGITS;
}

/**
 * Shared by the deposit step gate and the full selection schema, so the Next
 * button and the quote agree on what a complete Coinbase selection is.
 *
 * The issue messages are internal reasons, never shown: the wizard reads these
 * schemas as a pass/fail boolean. BuyerContactFields renders the translated
 * copy from the catalogue.
 */
function requireCoinbaseBuyerContact(
  value: { provider: RampProviderId | null; buyerEmail: string; buyerPhone: string },
  ctx: z.RefinementCtx
): void {
  if (value.provider !== "coinbase") {
    return;
  }
  if (!isValidBuyerEmail(value.buyerEmail)) {
    ctx.addIssue({ code: "custom", path: ["buyerEmail"], message: "buyer email is not valid" });
  }
  if (!isValidBuyerPhone(value.buyerPhone)) {
    ctx.addIssue({ code: "custom", path: ["buyerPhone"], message: "buyer phone is not valid" });
  }
}

export const depositSelectionSchema = depositSelectionBase.superRefine(requireCoinbaseBuyerContact);

export const withdrawSelectionSchema = makeRampSelectionSchema(
  "Select a source wallet.",
  withdrawAmount
);

// Per-step gating schemas.
export const depositAmountSchema = depositSelectionBase
  .pick({
    walletId: true,
    amount: true,
    provider: true,
    buyerEmail: true,
    buyerPhone: true,
  })
  .superRefine(requireCoinbaseBuyerContact);
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
  // Coinbase only. Collected on the deposit step because its headless
  // create-order requires them; every other provider leaves them empty and the
  // API rejects them as unknown keys.
  buyerEmail: z.string(),
  buyerPhone: z.string(),
});

export type RampFields = z.input<typeof rampSelectionSchema>;

const onchainAmount = z
  .string()
  .trim()
  .refine((value) => ONCHAIN_AMOUNT_PATTERN.test(value), {
    abort: true,
    message: "Enter a valid amount.",
  })
  .refine((value) => compareDecimalAmounts(value, "0") > 0, "Enter an amount greater than 0.");

export const cryptoWalletAccountDetailsSchema = z.object({ address: z.string().min(1) });

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
  externalId: z.string().trim().max(256).optional(),
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
  if (field.kind === "address") {
    throw new Error(`Address field "${field.key}" is validated through its nested fields.`);
  }
  const value = raw === undefined ? "" : raw.trim();
  if (value.length === 0) {
    return field.required ? `${field.label} is required.` : null;
  }
  if (field.kind === "select") {
    return field.options.some((option) => option.value === value)
      ? null
      : `Select a valid ${field.label.toLowerCase()}.`;
  }
  if (field.kind === "country") {
    return offeredCountryCodes(field).some((code) => code === value)
      ? null
      : `Select a valid ${field.label.toLowerCase()}.`;
  }
  if (field.kind === "currency") {
    return offeredFiatCurrencies(field).some((code) => code === value)
      ? null
      : `Select a valid ${field.label.toLowerCase()}.`;
  }
  if (field.kind === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
      return `${field.label} must be a valid date.`;
    }
    if (field.before !== undefined && value >= field.before) {
      return `${field.label} must be before ${field.before}.`;
    }
    return null;
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
