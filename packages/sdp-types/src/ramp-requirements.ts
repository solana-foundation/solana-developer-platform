import type { CountryCode } from "./countries";
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

/** Slug-keyed values the client collects for `status: "collect"` fields and passes through on the quote. */
export type CollectedFieldData = Record<string, string>;

/** An existing payout external account for the corridor's fiat currency. */
export interface PayoutRequirementAccount {
  destinationCountry: CountryCode;
  /** Provider-reported external-account status (e.g. Grid's CREATED/ACTIVE). */
  status: string;
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
  | { provider: RampProviderId; status: "ready" }
  | { provider: RampProviderId; status: "collect"; fields: RequirementField[] }
  | { provider: RampProviderId; status: "unsupported"; reason: string }
  | { provider: "lightspark"; status: "onboarding_not_started" }
  | { provider: "lightspark"; status: "collect_counterparty"; fields: RequirementField[] }
  | { provider: "lightspark"; status: "collect_account"; payout: PayoutRequirementTree }
  | { provider: "bvnk"; status: "onboarding_not_started" }
  | { provider: "bvnk"; status: "customer_verification_required"; verificationUrl: string }
  | { provider: "bvnk"; status: "customer_verifying" }
  | { provider: "bvnk"; status: "customer_verification_failed" }
  | { provider: "bvnk"; status: "funding_account_provisioning" }
  | { provider: "bvnk"; status: "provisioning_failed" }
  | { provider: "mural"; status: "onboarding_not_started" }
  | { provider: "mural"; status: "terms_of_service_required"; termsOfServiceUrl: string }
  | { provider: "mural"; status: "customer_verification_required"; verificationUrl: string }
  | { provider: "mural"; status: "customer_verifying" }
  | { provider: "mural"; status: "customer_verification_failed" }
  | { provider: "mural"; status: "funding_account_provisioning" }
);
