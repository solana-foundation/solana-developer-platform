import type { CountryCode } from "@sdp/types/countries";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import type { RampProviderId } from "@sdp/types/provider-access";
import type {
  CollectedFieldData,
  CounterpartyRequirements,
  RampDirection,
  RequirementField,
  RequirementOption,
} from "@sdp/types/ramp-requirements";
import { offeredCountryCodes, offeredFiatCurrencies } from "@sdp/types/ramp-requirements";
import { z } from "zod";
import { SdpPaymentsError } from "../errors";

/**
 * Builds the ready state for a non-Lightspark ramp counterparty.
 *
 * @param provider - Ramp provider whose requirements are complete.
 * @param direction - Ramp direction whose requirements are complete.
 * @returns The provider's ready counterparty state.
 */
export function readyCounterparty(
  provider: Exclude<RampProviderId, "lightspark">,
  direction: RampDirection
): CounterpartyRequirements {
  return { provider, direction, status: "ready" };
}

export function humanizeEnumLabel(value: string): string {
  const lower = value.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function enumOptions(values: readonly string[]): RequirementOption[] {
  return values.map((value) => ({ value, label: humanizeEnumLabel(value) }));
}

export function textField(args: {
  key: string;
  label: string;
  required: boolean;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  placeholder?: string;
  mask?: string;
}): RequirementField {
  return { kind: "text", ...args };
}

export function selectField(args: {
  key: string;
  label: string;
  required: boolean;
  options: RequirementOption[];
}): RequirementField {
  return { kind: "select", ...args };
}

/**
 * Builds a zod enum for requirement option values, rejecting empty option sets
 * with the requirement field's name.
 *
 * @param values - Option values the field accepts.
 * @param field - Requirement field the values belong to.
 * @returns The corresponding enum schema.
 */
function requirementEnumSchema(values: readonly string[], field: RequirementField): z.ZodTypeAny {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error(`Requirement field "${field.key}" (${field.kind}) has no options`);
  }
  return z.enum([first, ...rest]);
}

/**
 * Creates a country requirement field validated against ISO 3166-1 alpha-2 codes.
 *
 * @param args - Country requirement field properties.
 * @returns A country requirement field.
 */
export function countryField(args: {
  key: string;
  label: string;
  required: boolean;
  options?: CountryCode[];
}): RequirementField {
  return { kind: "country", ...args };
}

/** Creates a currency requirement field validated against the supported ramp fiat currencies. */
export function currencyField(args: {
  key: string;
  label: string;
  required: boolean;
  options?: RampFiatCurrency[];
}): RequirementField {
  return { kind: "currency", ...args };
}

export function dateField(args: {
  key: string;
  label: string;
  required: boolean;
  before?: string;
}): RequirementField {
  return { kind: "date", ...args };
}

export function consentField(args: {
  key: string;
  label: string;
  required: boolean;
  documentUrl: string;
  documentLabel?: string;
}): RequirementField {
  return { kind: "consent", ...args };
}

export function fieldToZod(field: RequirementField): z.ZodTypeAny {
  switch (field.kind) {
    case "text": {
      let schema = z.string().trim();
      if (field.maxLength !== undefined) {
        schema = schema.max(field.maxLength);
      }
      if (field.minLength !== undefined) {
        schema = schema.min(field.minLength);
      } else if (field.required) {
        schema = schema.min(1);
      }
      if (field.pattern !== undefined) {
        schema = schema.regex(new RegExp(field.pattern));
      }
      return field.required ? schema : schema.optional();
    }
    case "select": {
      const schema = requirementEnumSchema(
        field.options.map((option) => option.value),
        field
      );
      return field.required ? schema : schema.optional();
    }
    case "country": {
      const schema = requirementEnumSchema(offeredCountryCodes(field), field);
      return field.required ? schema : schema.optional();
    }
    case "currency": {
      const schema = requirementEnumSchema(offeredFiatCurrencies(field), field);
      return field.required ? schema : schema.optional();
    }
    case "date": {
      const before = field.before;
      const schema =
        before === undefined
          ? z.iso.date()
          : z.iso.date().refine((value) => value < before, `Must be a date before ${before}`);
      return field.required ? schema : schema.optional();
    }
    case "consent": {
      // Only the affirmative literal satisfies a required consent; an optional one may be left unticked,
      // which the web form sends as "" and a headless caller may send as "false" or omit.
      if (field.required) {
        return z.literal("true", {
          error: `${field.documentLabel ?? field.label} must be accepted`,
        });
      }
      return z.enum(["true", "false", ""]).optional();
    }
    case "address":
      throw new Error(
        `Requirement field "${field.key}" (address) collects its nested fields; it has no scalar schema`
      );
    default: {
      const exhaustive: never = field;
      throw new Error(`Unhandled requirement field kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function buildRequirementSchema(fields: readonly RequirementField[]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    if (field.kind === "address") {
      for (const part of field.fields) {
        shape[part.key] = fieldToZod(part);
      }
      continue;
    }
    shape[field.key] = fieldToZod(field);
  }
  return z.object(shape);
}

/**
 * Validates collected requirement-field data and returns the parsed values,
 * throwing a BAD_REQUEST with the zod error tree when validation fails.
 */
export function parseCollectedFields(
  fields: readonly RequirementField[],
  collectedData: CollectedFieldData,
  message: string
): Record<string, unknown> {
  const result = buildRequirementSchema(fields).safeParse(collectedData);
  if (!result.success) {
    throw new SdpPaymentsError("BAD_REQUEST", message, { errors: z.treeifyError(result.error) });
  }
  return result.data;
}
