import { COUNTRY_CODES } from "@sdp/types/countries";
import { RAMP_FIAT_CURRENCIES } from "@sdp/types/generated/ramp";
import { RAMP_DIRECTIONS } from "@sdp/types/payments";
import {
  isRetiredRampProviderId,
  PERSISTED_RAMP_PROVIDERS,
  type RampProviderId,
} from "@sdp/types/provider-access";
import type { CounterpartyRequirements, RequirementField } from "@sdp/types/ramp-requirements";
import { z } from "zod";

const fieldBase = { key: z.string(), label: z.string(), required: z.boolean() };

const requirementFieldSchema: z.ZodType<RequirementField> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("text"),
      ...fieldBase,
      pattern: z.string().optional(),
      minLength: z.number().int().optional(),
      maxLength: z.number().int().optional(),
      placeholder: z.string().optional(),
      mask: z.string().optional(),
    }),
    z.object({
      kind: z.literal("select"),
      ...fieldBase,
      options: z.array(z.object({ value: z.string(), label: z.string() })),
    }),
    z.object({
      kind: z.literal("country"),
      ...fieldBase,
      options: z.array(z.enum(COUNTRY_CODES)).optional(),
    }),
    z.object({
      kind: z.literal("currency"),
      ...fieldBase,
      options: z.array(z.enum(RAMP_FIAT_CURRENCIES)).optional(),
    }),
    z.object({ kind: z.literal("date"), ...fieldBase, before: z.string().optional() }),
    z.object({ kind: z.literal("address"), ...fieldBase, fields: z.array(requirementFieldSchema) }),
  ])
);

// A live provider: requirements are only asked of one the dashboard can still onboard with.
const rampProviderIdSchema = z.custom<RampProviderId>(
  (value) =>
    typeof value === "string" &&
    PERSISTED_RAMP_PROVIDERS.some((provider) => provider === value) &&
    !isRetiredRampProviderId(value)
);

const requirementsBase = { direction: z.enum(RAMP_DIRECTIONS), provider: rampProviderIdSchema };

export const counterpartyRequirementsResponseSchema = z.object({
  data: z.discriminatedUnion("status", [
    z.object({ ...requirementsBase, status: z.literal("ready") }),
    z.object({
      ...requirementsBase,
      status: z.literal("collect"),
      fields: z.array(requirementFieldSchema),
    }),
    z.object({ ...requirementsBase, status: z.literal("unsupported"), reason: z.string() }),
  ]) satisfies z.ZodType<CounterpartyRequirements>,
});
