import type { RampProviderId } from "@sdp/types/provider-access";
import type {
  CounterpartyRequirements,
  RampDirection,
  RequirementField,
  RequirementOption,
} from "@sdp/types/ramp-requirements";
import { z } from "zod";

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
    default: {
      const exhaustive: never = field;
      throw new Error(`Unhandled requirement field kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function buildRequirementSchema(fields: readonly RequirementField[]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    shape[field.key] = fieldToZod(field);
  }
  return z.object(shape);
}
