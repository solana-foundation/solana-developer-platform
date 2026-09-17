import { COUNTRY_CODES, type CountryCode } from "./countries";
import { RAMP_FIAT_CURRENCIES, type RampFiatCurrency } from "./generated/ramp.generated";
import type { RampDirection } from "./payments";
import type { RampProviderId } from "./provider-access";

export type { RampDirection };

export interface RequirementOption {
  value: string;
  label: string;
}

export type RequirementField =
  | {
      kind: "text";
      key: string;
      label: string;
      required: boolean;
      pattern?: string;
      minLength?: number;
      maxLength?: number;
      placeholder?: string;
      mask?: string;
    }
  | {
      kind: "select";
      key: string;
      label: string;
      required: boolean;
      options: RequirementOption[];
    }
  | {
      kind: "country";
      key: string;
      label: string;
      required: boolean;
      /** Subset of country codes the client may offer; absent means every supported country. */
      options?: CountryCode[];
    }
  | {
      kind: "currency";
      key: string;
      label: string;
      required: boolean;
      /** Subset of fiat currencies the client may offer; absent means every supported currency. */
      options?: RampFiatCurrency[];
    }
  | {
      kind: "date";
      key: string;
      label: string;
      required: boolean;
      /** ISO date (YYYY-MM-DD) the collected date must fall before, e.g. today for birth dates. */
      before?: string;
    }
  | {
      kind: "address";
      key: string;
      label: string;
      required: boolean;
      /** Nested parts collected under dotted keys, e.g. `customer.address.line1`. */
      fields: RequirementField[];
    }
  | {
      /**
       * An affirmative acceptance of a provider document (terms of service, privacy policy), collected as
       * the literal `"true"`. The label is the sentence up to the document's name and `documentLabel`
       * completes it as a link to `documentUrl`, so the person reads what they accept where they accept it.
       */
      kind: "consent";
      key: string;
      label: string;
      required: boolean;
      documentUrl: string;
      documentLabel?: string;
    };

export type RequirementFieldKind = RequirementField["kind"];

/**
 * Extracts the final field name from a dotted requirement key.
 *
 * @param key - Requirement key, which may contain a dotted path.
 * @returns The field name after the final dot.
 */
export function requirementFieldName(key: string): string {
  const separator = key.lastIndexOf(".");
  if (separator === -1) {
    return key;
  }
  return key.slice(separator + 1);
}

/**
 * Country codes a country field may accept.
 *
 * @param field - Country requirement field whose options bound the offer.
 * @returns The field's option subset, or every supported country when the field lists none.
 */
export function offeredCountryCodes(
  field: Extract<RequirementField, { kind: "country" }>
): readonly CountryCode[] {
  return field.options === undefined ? COUNTRY_CODES : field.options;
}

/**
 * @param field - A currency requirement field.
 * @returns The field's option subset, or every supported fiat currency when the field lists none.
 */
export function offeredFiatCurrencies(
  field: Extract<RequirementField, { kind: "currency" }>
): readonly RampFiatCurrency[] {
  return field.options === undefined ? RAMP_FIAT_CURRENCIES : field.options;
}

/** Slug-keyed values the client collects for `status: "collect"` fields and passes through on the quote. */
export type CollectedFieldData = Record<string, string>;

/** An existing payout external account for the corridor's fiat currency. */
export interface PayoutRequirementAccount {
  id: string;
  destinationCountry: CountryCode;
  paymentRail: string | null;
  /** Provider-reported external-account status (e.g. Grid's CREATED/ACTIVE). */
  status: string;
  bankName?: string;
  accountNumberLast4?: string;
}

/**
 * Destination-first payout collection: the client collects a destination
 * country from `countryRails` keys, offers that country's rails, then renders
 * exactly `railFields[rail]` with true per-rail requiredness. `accounts` lists
 * corridor accounts that already exist so the client can reuse one instead of
 * collecting bank fields again.
 */
export interface PayoutRequirementTree {
  countryRails: Partial<Record<CountryCode, RequirementOption[]>>;
  railFields: Record<string, RequirementField[]>;
  accounts: PayoutRequirementAccount[];
}

// TODO: tag RequirementField with a `group` ("kyc" | "bank") so the FE can section collect forms; deferred — today each collect is a single group.
export type CounterpartyRequirements = { direction: RampDirection } & (
  | { provider: Exclude<RampProviderId, "lightspark">; status: "ready" }
  | { provider: "lightspark"; direction: "onramp"; status: "ready" }
  | {
      provider: "lightspark";
      direction: "offramp";
      status: "ready";
      /** Payout account resolved for the corridor, for explicit quote selection. */
      providerAccountId: string;
      /** Corridor tree for destination re-selection; present on requirements GET answers, omitted by advances. */
      payout?: PayoutRequirementTree;
    }
  | { provider: RampProviderId; status: "collect"; fields: RequirementField[] }
  | { provider: RampProviderId; status: "unsupported"; reason: string }
  | { provider: "lightspark"; status: "onboarding_not_started" }
  | { provider: "lightspark"; status: "collect_counterparty"; fields: RequirementField[] }
  | { provider: "lightspark"; status: "collect_account"; payout: PayoutRequirementTree }
  | { provider: "bvnk"; status: "collect_counterparty"; fields: RequirementField[] }
  | {
      provider: "bvnk";
      /**
       * First BVNK step: collects only the tax-residence country so agreements
       * can be minted for it before any other PII is requested.
       */
      status: "collect_counterparty_residence";
      fields: RequirementField[];
    }
  | {
      provider: "bvnk";
      status: "counterparty_collect_agreement";
      /**
       * Agreements of the minted v1 session. The document links are the
       * session's static help-centre URLs stored on the customer link; nothing
       * is minted per response. `name` is the v1 agreement identifier (v1 has
       * no id).
       */
      agreements: {
        name: string;
        displayName: string;
        description: string;
        url: string;
        privacyPolicyUrl: string;
      }[];
    }
  | {
      provider: "bvnk";
      status: "customer_verification_required";
      /** The authenticated verification link is minted JIT per response. */
      verificationUrl: string;
    }
  | { provider: "bvnk"; status: "customer_verifying" }
  | { provider: "bvnk"; status: "counterparty_agreement_signing" }
  | { provider: "bvnk"; status: "customer_verification_failed" }
  | { provider: "bvnk"; status: "customer_funding_account_provisioning" }
  | { provider: "bvnk"; status: "customer_funding_account_provisioning_failed" }
  | { provider: "mural"; status: "onboarding_not_started" }
  | { provider: "mural"; status: "terms_of_service_required"; termsOfServiceUrl: string }
  | { provider: "mural"; status: "customer_verification_required"; verificationUrl: string }
  | { provider: "mural"; status: "customer_verifying" }
  | { provider: "mural"; status: "customer_verification_failed" }
  | { provider: "mural"; status: "funding_account_provisioning" }
  | { provider: "hercle"; status: "customer_verification_required"; verificationUrl: string }
  | { provider: "hercle"; status: "customer_verifying" }
  | { provider: "hercle"; status: "customer_verification_failed" }
);

export const COUNTERPARTY_REQUIREMENTS_POLL_STATUSES = [
  "terms_of_service_required",
  "customer_verification_required",
  "customer_verifying",
  "counterparty_agreement_signing",
  "customer_funding_account_provisioning",
  "funding_account_provisioning",
] as const satisfies readonly CounterpartyRequirements["status"][];

export type CounterpartyRequirementsPollStatus =
  (typeof COUNTERPARTY_REQUIREMENTS_POLL_STATUSES)[number];

/**
 * Whether a requirements status should continue polling its provider lifecycle.
 *
 * @param status - Requirements lifecycle status to classify.
 * @returns True when the requirements request should poll for a provider transition.
 */
export function isCounterpartyRequirementsPollStatus(
  status: CounterpartyRequirements["status"]
): status is CounterpartyRequirementsPollStatus {
  return COUNTERPARTY_REQUIREMENTS_POLL_STATUSES.some((candidate) => candidate === status);
}

export const RAMP_ONBOARDING_PENDING_STATUSES = [
  "customer_verifying",
  "counterparty_agreement_signing",
  "customer_funding_account_provisioning",
  "funding_account_provisioning",
] as const satisfies readonly CounterpartyRequirements["status"][];

export type RampOnboardingPendingStatus = (typeof RAMP_ONBOARDING_PENDING_STATUSES)[number];

/**
 * Whether a requirements status blocks ramp progression while a provider transition completes.
 *
 * @param status - Requirements lifecycle status to classify.
 * @returns True when the provider transition is still pending.
 */
export function isRampOnboardingPendingStatus(
  status: CounterpartyRequirements["status"]
): status is RampOnboardingPendingStatus {
  return RAMP_ONBOARDING_PENDING_STATUSES.some((candidate) => candidate === status);
}

/** Collect stages whose answer carries a `fields` array for the client to render. */
export const COLLECT_FIELDS_STATUSES = [
  "collect",
  "collect_counterparty",
  "collect_counterparty_residence",
] as const;

export type CollectFieldsStatus = (typeof COLLECT_FIELDS_STATUSES)[number];

/**
 * Requirement statuses answered on the client's requirements step before the
 * provider can advance: field collection, payout-account selection, or
 * agreement consent.
 */
export const COLLECT_STAGE_STATUSES = [
  ...COLLECT_FIELDS_STATUSES,
  "collect_account",
  "counterparty_collect_agreement",
] as const;

export type CollectStageStatus = (typeof COLLECT_STAGE_STATUSES)[number];

/**
 * Whether a requirements status is a collect stage.
 *
 * @param status - Requirements lifecycle status to classify.
 * @returns True for the collect-stage statuses.
 */
export function isCollectStageStatus(
  status: CounterpartyRequirements["status"]
): status is CollectStageStatus {
  return COLLECT_STAGE_STATUSES.some((candidate) => candidate === status);
}

/** Collect-stage requirements whose answer carries a field set rather than a payout tree or agreements. */
export type CollectFieldsRequirements = Extract<
  CounterpartyRequirements,
  { status: CollectFieldsStatus }
>;

/**
 * Whether a requirements answer is a collect stage with collectable fields.
 *
 * @param requirements - Requirements answer to classify.
 * @returns True when `requirements.fields` is present for the client to render.
 */
export function isCollectFieldsRequirements(
  requirements: CounterpartyRequirements
): requirements is CollectFieldsRequirements {
  return COLLECT_FIELDS_STATUSES.some((candidate) => candidate === requirements.status);
}
