import type { Counterparty } from "@sdp/types/counterparties";
import type { CountryCode } from "@sdp/types/countries";
import type { RampDirection } from "@sdp/types/payments";
import type { CounterpartyRequirements, RequirementField } from "@sdp/types/ramp-requirements";
import { SdpPaymentsError, unsupportedCounterparty } from "#/errors";
import { consentField, countryField, readyCounterparty, textField } from "#/ramps/requirements";
import type { ValidateCounterpartyOptions } from "#/ramps/types";
import type { HercleVerificationStatus } from "./customer-status-mapping";

/**
 * Hercle onboards regulated businesses in its Swiss and EEA perimeter.
 * The country of registration picks the Hercle entity that holds the account.
 */
const HERCLE_JURISDICTION_BY_COUNTRY = {
  CH: "SWISS",
  AT: "EU",
  BE: "EU",
  BG: "EU",
  CY: "EU",
  CZ: "EU",
  DE: "EU",
  DK: "EU",
  EE: "EU",
  ES: "EU",
  FI: "EU",
  FR: "EU",
  GR: "EU",
  HR: "EU",
  HU: "EU",
  IE: "EU",
  IS: "EU",
  IT: "EU",
  LI: "EU",
  LT: "EU",
  LU: "EU",
  LV: "EU",
  MT: "EU",
  NL: "EU",
  NO: "EU",
  PL: "EU",
  PT: "EU",
  RO: "EU",
  SE: "EU",
  SI: "EU",
  SK: "EU",
} as const satisfies Partial<Record<CountryCode, "SWISS" | "EU">>;

type HercleCountry = keyof typeof HERCLE_JURISDICTION_BY_COUNTRY;
export type HercleJurisdiction = (typeof HERCLE_JURISDICTION_BY_COUNTRY)[HercleCountry];

function isHercleCountry(countryCode: string): countryCode is HercleCountry {
  return Object.hasOwn(HERCLE_JURISDICTION_BY_COUNTRY, countryCode);
}

const HERCLE_COUNTRIES: HercleCountry[] = Object.keys(HERCLE_JURISDICTION_BY_COUNTRY).filter(
  isHercleCountry
);

/** The jurisdiction Hercle opens a business's account under, or undefined outside its perimeter. */
export function hercleJurisdictionForCountry(countryCode: string): HercleJurisdiction | undefined {
  return isHercleCountry(countryCode) ? HERCLE_JURISDICTION_BY_COUNTRY[countryCode] : undefined;
}

export const HERCLE_FIELD_KEYS = {
  legalName: "registeredCompanyName",
  registrationNumber: "registrationNumber",
  registrationCountry: "registrationCountry",
  addressLine1: "registeredAddressLine1",
  addressCity: "registeredAddressCity",
  addressPostalCode: "registeredAddressPostalCode",
  termsConsent: "acceptHercleTerms",
  privacyConsent: "acceptHerclePrivacy",
} as const;

export const HERCLE_TERMS_URL = "https://hercle.com/terms/";
export const HERCLE_PRIVACY_POLICY_URL = "https://hercle.com/privacy/";

/**
 * The KYB inputs Hercle needs to open the business's account.
 * They include the business's acceptance of Hercle's terms and privacy policy, without which Hercle opens no account.
 * SDP passes them to Hercle and stores none of them.
 * The registered name is asked for, not taken from the counterparty's display name.
 * Hercle prefills its KYB with it, and its bank returns a wire sent from any other account holder name.
 */
export function hercleOnboardingFields(): RequirementField[] {
  return [
    textField({
      key: HERCLE_FIELD_KEYS.legalName,
      label: "Registered company name",
      required: true,
      minLength: 2,
      maxLength: 128,
      placeholder: "Acme Trading AG",
    }),
    textField({
      key: HERCLE_FIELD_KEYS.registrationNumber,
      label: "Company registration number",
      required: true,
      minLength: 2,
      maxLength: 64,
      placeholder: "CHE-123.456.789",
    }),
    countryField({
      key: HERCLE_FIELD_KEYS.registrationCountry,
      label: "Country of registration",
      required: true,
      options: HERCLE_COUNTRIES,
    }),
    textField({
      key: HERCLE_FIELD_KEYS.addressLine1,
      label: "Registered address",
      required: true,
      minLength: 2,
      maxLength: 128,
      placeholder: "Bahnhofstrasse 1",
    }),
    textField({
      key: HERCLE_FIELD_KEYS.addressCity,
      label: "City",
      required: true,
      minLength: 1,
      maxLength: 64,
      placeholder: "Zurich",
    }),
    textField({
      key: HERCLE_FIELD_KEYS.addressPostalCode,
      label: "Postal code",
      required: true,
      minLength: 2,
      maxLength: 16,
      placeholder: "8001",
    }),
    consentField({
      key: HERCLE_FIELD_KEYS.termsConsent,
      label: "I declare that I have read and accepted Hercle's",
      documentLabel: "Terms & Conditions",
      documentUrl: HERCLE_TERMS_URL,
      required: true,
    }),
    consentField({
      key: HERCLE_FIELD_KEYS.privacyConsent,
      label: "I declare that I have read, agreed and accepted Hercle's",
      documentLabel: "Privacy Policy",
      documentUrl: HERCLE_PRIVACY_POLICY_URL,
      required: true,
    }),
  ];
}

/**
 * What the counterparty alone shows: Hercle serves businesses on-ramp only.
 * A business with no Hercle account yet must hand over its KYB details.
 * `ready` here only means the account exists.
 * Its verification lives at Hercle, so the requirements member answers from there.
 *
 * @param counterparty - The counterparty asking.
 * @param direction - The ramp direction it asks for.
 * @param linked - Whether the counterparty already has a Hercle account.
 * @returns The requirements the counterparty alone settles.
 */
export function hercleOnboardingDecision(
  counterparty: Counterparty,
  direction: RampDirection,
  linked: boolean
): CounterpartyRequirements {
  if (direction === "offramp") {
    return unsupportedCounterparty("hercle", direction, "Hercle supports on-ramp only.");
  }
  if (counterparty.entityType !== "business") {
    return unsupportedCounterparty(
      "hercle",
      direction,
      "Hercle supports business counterparties only."
    );
  }
  if (!linked) {
    return { provider: "hercle", direction, status: "collect", fields: hercleOnboardingFields() };
  }
  return readyCounterparty("hercle", direction);
}

export function hercleCounterpartyRequirements(
  counterparty: Counterparty,
  options: ValidateCounterpartyOptions
): CounterpartyRequirements {
  return hercleOnboardingDecision(
    counterparty,
    options.direction,
    options.providerCustomerReference !== undefined
  );
}

/**
 * The answer for a business whose financial operations Hercle has suspended.
 * Hercle refuses its orders until it lifts the suspension.
 * A requirements read after that answers with Hercle's verdict again.
 */
export function hercleSuspendedRequirements(direction: RampDirection): CounterpartyRequirements {
  return unsupportedCounterparty(
    "hercle",
    direction,
    "Hercle has suspended the business's account."
  );
}

/**
 * The requirements answer for a business with a Hercle account.
 *
 * @param verification - Hercle's verdict, and the hosted link it minted while it needs the business.
 * @param direction - The ramp direction asked for.
 * @returns The requirements arm for the verdict.
 * @throws SdpPaymentsError PROVIDER_RESPONSE_INVALID when Hercle needs the business but sent no link.
 */
export function hercleVerificationRequirements(
  verification: { status: HercleVerificationStatus; verificationUrl?: string },
  direction: RampDirection
): CounterpartyRequirements {
  switch (verification.status) {
    case "approved":
      return readyCounterparty("hercle", direction);
    case "pending":
      return { provider: "hercle", direction, status: "customer_verifying" };
    case "rejected":
      return { provider: "hercle", direction, status: "customer_verification_failed" };
    case "action_required": {
      if (verification.verificationUrl === undefined) {
        throw new SdpPaymentsError(
          "PROVIDER_RESPONSE_INVALID",
          "Hercle asked for verification without a verification link",
          { provider: "hercle", outcome: "unknown" }
        );
      }
      return {
        provider: "hercle",
        direction,
        status: "customer_verification_required",
        verificationUrl: verification.verificationUrl,
      };
    }
    default: {
      const exhaustive: never = verification.status;
      throw new Error(`Unhandled Hercle verification status: ${String(exhaustive)}`);
    }
  }
}
