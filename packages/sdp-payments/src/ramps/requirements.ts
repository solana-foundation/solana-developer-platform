import { COUNTRY_CODES } from "@sdp/types/countries";
import type { RampProviderId } from "@sdp/types/provider-access";
import type {
  CollectedFieldData,
  CounterpartyRequirements,
  RampDirection,
  RequirementField,
  RequirementOption,
} from "@sdp/types/ramp-requirements";
import { z } from "zod";
import { SdpPaymentsError } from "../errors";

const countryCodeSchema = z.enum(COUNTRY_CODES);

export function readyCounterparty(
  provider: RampProviderId,
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
 * Creates a country requirement field validated against ISO 3166-1 alpha-2 codes.
 *
 * @param args - Country requirement field properties.
 * @returns A country requirement field.
 */
export function countryField(args: {
  key: string;
  label: string;
  required: boolean;
}): RequirementField {
  return { kind: "country", ...args };
}

export function dateField(args: {
  key: string;
  label: string;
  required: boolean;
  before?: string;
}): RequirementField {
  return { kind: "date", ...args };
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
      const [first, ...rest] = field.options.map((option) => option.value);
      if (first === undefined) {
        throw new Error(`Requirement field "${field.key}" (select) has no options`);
      }
      const schema = z.enum([first, ...rest]);
      return field.required ? schema : schema.optional();
    }
    case "country":
      return field.required ? countryCodeSchema : countryCodeSchema.optional();
    case "date": {
      const before = field.before;
      const schema =
        before === undefined
          ? z.iso.date()
          : z.iso.date().refine((value) => value < before, `Must be a date before ${before}`);
      return field.required ? schema : schema.optional();
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
