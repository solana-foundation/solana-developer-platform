import { type CountryCode, US_STATES } from "@sdp/types";
import type { RampProviderId } from "@sdp/types/provider-access";
import type {
  CollectedFieldData,
  CounterpartyRequirements,
  RampDirection,
  RequirementField,
  RequirementOption,
} from "@sdp/types/ramp-requirements";
import { z } from "zod";
import { badRequest, SdpPaymentsError } from "../errors";

const E164_PHONE_PATTERN = "^\\+[1-9]\\d{1,14}$";

const US_STATE_OPTIONS = US_STATES.map((state) => ({ value: state.code, label: state.name }));

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
 * Describes the canonical JIT phone field shared by ramp providers.
 *
 * @returns A required E.164 phone requirement descriptor.
 */
export function phoneField(): RequirementField {
  return textField({
    key: "phone",
    label: "Phone number",
    required: true,
    pattern: E164_PHONE_PATTERN,
    placeholder: "+14155551234",
  });
}

const BASE_ADDRESS_FIELDS: readonly RequirementField[] = [
  textField({ key: "address.line1", label: "Address line 1", required: true, maxLength: 512 }),
  textField({ key: "address.line2", label: "Address line 2", required: false, maxLength: 512 }),
  textField({ key: "address.city", label: "City", required: true, maxLength: 256 }),
  textField({ key: "address.postalCode", label: "Postal code", required: true, maxLength: 32 }),
];

const US_ADDRESS_FIELDS: readonly RequirementField[] = [
  ...BASE_ADDRESS_FIELDS,
  selectField({
    key: "address.subdivisionCode",
    label: "State",
    required: true,
    options: US_STATE_OPTIONS,
  }),
];

/**
 * Describes the canonical flat JIT address fields for a ramp country.
 *
 * @param country Counterparty country supplied in ramp request context.
 * @returns Address descriptors, including a US subdivision select only for US ramps.
 */
export function addressFields(country: CountryCode): readonly RequirementField[] {
  return country === "US" ? US_ADDRESS_FIELDS : BASE_ADDRESS_FIELDS;
}

export interface CollectedAddress {
  line1: string;
  line2?: string;
  city: string;
  postalCode: string;
  subdivisionCode?: string;
}

/**
 * Parses the canonical JIT address out of transient collected data, throwing a
 * BAD_REQUEST when the data is absent or fails the address field schema. The
 * subdivision code is present exactly when the country is US.
 *
 * @param country Counterparty country supplied in ramp request context.
 * @param collectedData Transient field values supplied for this ramp.
 * @param message BAD_REQUEST message identifying the provider context.
 * @returns The parsed canonical address parts.
 */
export function parseCollectedAddress(
  country: CountryCode,
  collectedData: CollectedFieldData | undefined,
  message: string
): CollectedAddress {
  if (collectedData === undefined) {
    throw badRequest(message);
  }
  const supplied = parseCollectedFields(addressFields(country), collectedData, message);
  const line1 = supplied["address.line1"];
  const line2 = supplied["address.line2"];
  const city = supplied["address.city"];
  const postalCode = supplied["address.postalCode"];
  if (typeof line1 !== "string" || typeof city !== "string" || typeof postalCode !== "string") {
    throw badRequest(message);
  }
  const address: CollectedAddress = { line1, city, postalCode };
  if (typeof line2 === "string") {
    address.line2 = line2;
  }
  if (country === "US") {
    const subdivisionCode = supplied["address.subdivisionCode"];
    if (typeof subdivisionCode !== "string") {
      throw badRequest(message);
    }
    address.subdivisionCode = subdivisionCode;
  }
  return address;
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
