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

// TODO: tag RequirementField with a `group` ("kyc" | "bank") so the FE can section collect forms; deferred — today each collect is a single group.
export type CounterpartyRequirements = { direction: RampDirection } & (
  | { provider: RampProviderId; status: "ready" }
  | { provider: RampProviderId; status: "collect"; fields: RequirementField[] }
  | { provider: RampProviderId; status: "unsupported"; reason: string }
  | { provider: "lightspark"; status: "onboarding_not_started" }
  | { provider: "lightspark"; status: "collect_counterparty"; fields: RequirementField[] }
  | { provider: "lightspark"; status: "collect_account"; fields: RequirementField[] }
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
