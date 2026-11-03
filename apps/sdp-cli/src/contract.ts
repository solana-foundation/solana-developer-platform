import { ACTIONS } from "@sdp/types/actions";
import Ajv from "ajv-draft-04";
import addFormats from "ajv-formats";
import { z } from "zod";
import generated from "./contract.generated.json";

const schemaDocument = z.record(z.string(), z.json());
const operationSchema = z.object({
  operationId: z.string().min(1),
  summary: z.string().min(1),
  description: z.string().min(1),
  shadowedBy: z.array(z.string().startsWith("/")),
  authorization: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("signup") }),
    z.object({ kind: z.literal("membership") }),
    z.object({ kind: z.literal("session") }),
    z.object({
      kind: z.literal("webhook"),
      signatureHeaders: z.array(z.array(z.string().min(1)).min(1)).min(1),
    }),
    z.object({ kind: z.literal("payment-link") }),
    z.object({ kind: z.literal("public") }),
    z.object({ kind: z.literal("action"), action: z.enum(ACTIONS) }),
  ]),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z
    .string()
    .regex(
      /^\/(?:$|health(?:\/ready)?$|openapi\.json$|docs$|llms\.txt$|v1\/|pay\/|webhooks\/|internal\/dashboard\/(?:(?:helius-rings|custody|wallets|fireblocks)\/|network$))/
    ),
  sessionOnly: z.boolean(),
  returnsApiKeySecret: z.boolean(),
  returnsPaymentLinkToken: z.boolean(),
  returnsRampClientSecret: z.boolean(),
  parameters: z.array(
    z.object({
      name: z.string(),
      location: z.enum(["path", "query", "header"]),
      required: z.boolean(),
      schema: schemaDocument,
    })
  ),
  body: schemaDocument.nullable(),
  rawBody: z
    .object({ contentType: z.literal("application/json"), maxBytes: z.number().int().positive() })
    .nullable(),
  responses: z.record(z.string(), schemaDocument.nullable()),
  binaryResponses: z.record(z.string(), z.literal("image/png")),
  specialResponses: z.record(
    z.string(),
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("text"),
        contentType: z.enum(["text/plain", "text/html"]),
        schema: schemaDocument,
      }),
      z.object({ kind: z.literal("redirect"), locationSchema: schemaDocument }),
      z.object({ kind: z.literal("not-modified") }),
      z.object({ kind: z.literal("diagnostic"), schema: schemaDocument }),
    ])
  ),
});

export const operations = z
  .object({ operations: z.array(operationSchema) })
  .parse(generated).operations;
export type Operation = z.infer<typeof operationSchema>;
export type Json = z.infer<ReturnType<typeof z.json>>;
export type JsonObject = Record<string, Json>;
export type QueryValue = string | number | boolean | string[];

export function operationById(id: string): Operation {
  const operation = operations.find((entry) => entry.operationId === id);
  if (!operation) throw new Error(`Missing CLI contract operation: ${id}`);
  return operation;
}

// OpenAPI 3.0 uses draft-04 bounds and wallet ownership uses `not` and unions.
// Validate directly; conversion to Zod cannot represent every constraint.
const validator = new Ajv({ strict: false, allErrors: true, ownProperties: true, logger: false });
addFormats(validator);

/** Validate without transforming the wire payload or exposing input values in errors. */
export function validatePayload(
  schema: z.infer<typeof schemaDocument>,
  value: Json,
  label: string
) {
  const check = validator.compile<Json>(schema);
  if (!check(value))
    throw new Error(`${label}: ${validator.errorsText(check.errors, { separator: "; " })}`);
}
