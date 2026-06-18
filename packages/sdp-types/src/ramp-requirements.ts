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
    };

export type RequirementFieldKind = RequirementField["kind"];

/** Slug-keyed values the client collects for `status: "collect"` fields and passes through on the quote. */
export type CollectedFieldData = Record<string, string>;

// TODO: tag RequirementField with a `group` ("kyc" | "bank") so the FE can section collect forms; deferred — today each collect is a single group.
export type CounterpartyRequirements = { direction: RampDirection } & (
  | { provider: RampProviderId; status: "ready" }
  | { provider: RampProviderId; status: "collect"; fields: RequirementField[] }
  | { provider: RampProviderId; status: "unsupported"; reason: string }
  | { provider: "lightspark"; status: "onboarding_not_started" }
  | { provider: "bvnk"; status: "onboarding_not_started" }
  | { provider: "bvnk"; status: "customer_verification_required"; verificationUrl: string }
  | { provider: "bvnk"; status: "customer_verifying" }
  | { provider: "bvnk"; status: "customer_verification_failed" }
  | { provider: "bvnk"; status: "funding_account_provisioning" }
  | { provider: "bvnk"; status: "provisioning_failed" }
);
