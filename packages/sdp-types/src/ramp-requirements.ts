import { COUNTRY_CODES, type CountryCode } from "./countries";
import { RAMP_FIAT_CURRENCIES, type RampFiatCurrency } from "./generated/ramp.generated";
import type { RampDirection } from "./payments";
import type { RampProviderId } from "./provider-access";

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

export type CounterpartyRequirements = { direction: RampDirection } & (
  | { provider: RampProviderId; status: "ready" }
  | { provider: RampProviderId; status: "collect"; fields: RequirementField[] }
  | { provider: RampProviderId; status: "unsupported"; reason: string }
);

export const COUNTERPARTY_REQUIREMENTS_POLL_STATUSES =
  [] as const satisfies readonly CounterpartyRequirements["status"][];

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

/** Collect stages whose answer carries a `fields` array for the client to render. */
export const COLLECT_FIELDS_STATUSES = ["collect"] as const;
export type CollectFieldsStatus = (typeof COLLECT_FIELDS_STATUSES)[number];
export const COLLECT_STAGE_STATUSES = COLLECT_FIELDS_STATUSES;
export type CollectStageStatus = CollectFieldsStatus;

export function isCollectStageStatus(
  status: CounterpartyRequirements["status"]
): status is CollectStageStatus {
  return status === "collect";
}

export type CollectFieldsRequirements = Extract<CounterpartyRequirements, { status: "collect" }>;

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
