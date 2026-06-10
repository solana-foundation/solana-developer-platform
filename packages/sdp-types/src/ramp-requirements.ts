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

export type CounterpartyRequirements = {
  provider: RampProviderId;
  direction: RampDirection;
} & (
  | { status: "ready" }
  | { status: "collect"; fields: RequirementField[] }
  | { status: "unsupported"; reason: string }
);
