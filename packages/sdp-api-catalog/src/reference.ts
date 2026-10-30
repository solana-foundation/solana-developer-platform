import { ACTIONS } from "@sdp/types/actions";
import { SDP_MODULES } from "@sdp/types/release-channels";
import { z } from "zod";
import { SNIPPET_AUTH_MODES } from "./snippets";

/**
 * The API reference model: every operation one release channel's public OpenAPI document
 * carries, with what a reader needs to call it. The API builds it from that document
 * (`apps/sdp-api/src/openapi/reference.ts`, written beside `openapi.json` by `openapi:generate`)
 * and the docs render the reference from it, so a field, example or status appears there only
 * when the channel publishes it.
 */

/** The methods the public API uses, in the order a reference lists them. */
export const API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export type ApiMethod = (typeof API_METHODS)[number];

/** Where a parameter travels, in the order a reference lists them. */
export const API_PARAMETER_LOCATIONS = ["path", "query", "header"] as const;

export type ApiParameterLocation = (typeof API_PARAMETER_LOCATIONS)[number];

export const API_SCHEMA_TYPES = [
  "string",
  "integer",
  "number",
  "boolean",
  "object",
  "array",
] as const;

export type ApiSchemaType = (typeof API_SCHEMA_TYPES)[number];

/** Numeric bounds, from OpenAPI 3.0 (`exclusiveMinimum: true` turns `minimum` into its own bound). */
export const API_BOUND_KINDS = [
  "minLength",
  "maxLength",
  "minimum",
  "exclusiveMinimum",
  "maximum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
  "minProperties",
] as const;

const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);

export const apiConstraintSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(API_BOUND_KINDS), value: z.number() }),
  z.object({ kind: z.literal("pattern"), value: z.string() }),
  /**
   * `required` names the schema lists no property for, as a variant names its parent's: the
   * value must include these properties.
   */
  z.object({ kind: z.literal("includes"), value: z.array(z.string().min(1)).min(1) }),
  /** `not: { required: [...] }`: the value must leave these properties out. */
  z.object({ kind: z.literal("excludes"), value: z.array(z.string().min(1)).min(1) }),
]);

export type ApiConstraint = z.infer<typeof apiConstraintSchema>;

/** One value's schema, dereferenced. `oneOf` and `anyOf` keep their branches as variants. */
export const apiSchemaSchema = z.object({
  /** Null when only the variants type the value, as with a string or an integer. */
  type: z.enum(API_SCHEMA_TYPES).nullable(),
  format: z.string().nullable(),
  nullable: z.boolean(),
  description: z.string().nullable(),
  enum: z.array(scalarSchema).nullable(),
  default: z.json().optional(),
  example: z.json().optional(),
  constraints: z.array(apiConstraintSchema),
  get properties() {
    return z.array(apiPropertySchema);
  },
  /** An array's items; null for any other type. */
  get items() {
    return apiSchemaSchema.nullable();
  },
  /** A map's values (`additionalProperties`); null when the object names its properties only. */
  get additionalProperties() {
    return apiSchemaSchema.nullable();
  },
  /** `oneOf` takes exactly one variant and `anyOf` at least one; null without variants. */
  variantMode: z.enum(["oneOf", "anyOf"]).nullable(),
  get variants() {
    return z.array(apiVariantSchema);
  },
});

export type ApiSchema = z.infer<typeof apiSchemaSchema>;

export const apiPropertySchema = z.object({
  name: z.string().min(1),
  required: z.boolean(),
  get schema() {
    return apiSchemaSchema;
  },
});

export type ApiProperty = z.infer<typeof apiPropertySchema>;

export const apiVariantSchema = z.object({
  /** What sets the variant apart: its one-value field (`provider: "privy"`), else its description. */
  title: z.string().min(1),
  get schema() {
    return apiSchemaSchema;
  },
});

export type ApiVariant = z.infer<typeof apiVariantSchema>;

export const apiParameterSchema = z.object({
  name: z.string().min(1),
  in: z.enum(API_PARAMETER_LOCATIONS),
  required: z.boolean(),
  description: z.string().nullable(),
  /** Carries the parameter's example, whether the document gives it on the parameter or its schema. */
  schema: apiSchemaSchema,
  /** The value the docs and playground put in a sample call, including a schema fallback. */
  sample: z.json(),
});

export type ApiParameter = z.infer<typeof apiParameterSchema>;

export const apiRequestBodySchema = z.object({
  required: z.boolean(),
  /** The body's description, or its schema's where the document puts it there. */
  description: z.string().nullable(),
  contentType: z.literal("application/json"),
  schema: apiSchemaSchema,
});

export type ApiRequestBody = z.infer<typeof apiRequestBodySchema>;

export const apiResponseBodySchema = z.discriminatedUnion("kind", [
  /** A JSON body: its schema, which names the fields an example can leave out, and an example. */
  z.object({ kind: z.literal("json"), schema: apiSchemaSchema, example: z.json() }),
  /** No body, as with 204. */
  z.object({ kind: z.literal("empty") }),
]);

export const apiResponseSchema = z.object({
  status: z.string().regex(/^[1-5]\d\d$/),
  description: z.string(),
  body: apiResponseBodySchema,
});

export type ApiResponse = z.infer<typeof apiResponseSchema>;

export const apiOperationSchema = z.object({
  operationId: z.string().min(1),
  /** The dashboard playground's id for the operation (`list-wallets`). */
  endpointId: z.string().min(1),
  method: z.enum(API_METHODS),
  path: z.string().startsWith("/"),
  /** The module that owns the route (`apps/sdp-api/src/routes/route-modules.ts`). */
  module: z.enum([...SDP_MODULES, "core"]),
  /** The action the route requires; null for a public route. */
  action: z.enum(ACTIONS).nullable(),
  /** How the route authenticates, which is how its samples do. */
  auth: z.enum(SNIPPET_AUTH_MODES),
  /**
   * Whether the route declares an `Idempotency-Key` header, required or optional, which is
   * whether its samples send one.
   */
  takesIdempotencyKey: z.boolean(),
  summary: z.string().min(1),
  /**
   * The group the operation sits in within its family (the document's `x-sdp-group`), or null
   * for a family that groups none. A family's operations name one each or none.
   */
  group: z.string().min(1).nullable(),
  description: z.string().nullable(),
  deprecated: z.boolean(),
  parameters: z.array(apiParameterSchema),
  requestBody: apiRequestBodySchema.nullable(),
  responses: z.array(apiResponseSchema).min(1),
  /**
   * The call the reference's samples make: the path with its parameters and any required query
   * parameters filled from their examples, and the body the dashboard playground starts from.
   */
  request: z.object({ path: z.string().startsWith("/"), body: z.json().nullable() }),
});

export type ApiOperation = z.infer<typeof apiOperationSchema>;

/** An API family: one tag of the document, its operations in document order. */
export const apiFamilySchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  operations: z.array(apiOperationSchema).min(1),
});

export type ApiFamily = z.infer<typeof apiFamilySchema>;

export const apiReferenceSchema = z.object({
  families: z.array(apiFamilySchema).min(1),
});

export type ApiReference = z.infer<typeof apiReferenceSchema>;
