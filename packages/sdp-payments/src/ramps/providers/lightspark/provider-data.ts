import type { CounterpartyProviderData } from "@sdp/types";

/**
 * Checks whether Grid reports an external account as active.
 *
 * @param status - Provider account status.
 * @returns True only for the active status.
 */
export function isLightsparkExternalAccountActive(status: string): boolean {
  return status.trim().toUpperCase() === "ACTIVE";
}

/** Grid purpose-of-payment codes with display labels; some payout corridors mandate one on every quote. */
export const LIGHTSPARK_PURPOSE_OF_PAYMENT_LABELS = {
  GIFT: "Personal gift",
  SELF: "Transfer to yourself",
  GOODS_OR_SERVICES: "Goods or services",
  EDUCATION: "Education",
  HEALTH_OR_MEDICAL: "Health or medical",
  REAL_ESTATE_PURCHASE: "Real estate purchase",
  TAX_PAYMENT: "Tax payment",
  LOAN_PAYMENT: "Loan payment",
  UTILITY_BILL: "Utility bill",
  DONATION: "Donation",
  TRAVEL: "Travel",
  FAMILY_SUPPORT: "Family support",
  SALARY_PAYMENT: "Salary or wages",
  OTHER: "Other",
} as const satisfies Record<string, string>;

export type LightsparkPurposeOfPayment = keyof typeof LIGHTSPARK_PURPOSE_OF_PAYMENT_LABELS;

/**
 * Checks whether a value is a supported Grid purpose-of-payment code.
 *
 * @param value - Candidate purpose code.
 * @returns True when the value is a supported code.
 */
export function isLightsparkPurposeOfPayment(value: string): value is LightsparkPurposeOfPayment {
  return Object.hasOwn(LIGHTSPARK_PURPOSE_OF_PAYMENT_LABELS, value);
}

/**
 * Reads the purpose-of-payment stored during counterparty onboarding.
 *
 * @param providerData - Counterparty provider_data blob.
 * @returns The stored code, or null when none has been collected.
 */
export function readLightsparkPurposeOfPayment(
  providerData: CounterpartyProviderData
): LightsparkPurposeOfPayment | null {
  const value = readLightsparkData(providerData).purposeOfPayment;
  return typeof value === "string" && isLightsparkPurposeOfPayment(value) ? value : null;
}

/**
 * Reads the Lightspark portion of counterparty provider data.
 *
 * @param providerData - Counterparty provider-data blob.
 * @returns Lightspark provider data.
 */
export function readLightsparkData(
  providerData: CounterpartyProviderData
): Record<string, unknown> {
  const lightspark = providerData.lightspark;
  return lightspark && typeof lightspark === "object"
    ? (lightspark as Record<string, unknown>)
    : {};
}
