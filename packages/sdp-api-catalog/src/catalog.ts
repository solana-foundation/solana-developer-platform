import type { ApiOperation, ApiParameter, ApiReference } from "./reference";

/** An operation with the family that owns its reference page. */
export interface ApiCatalogEntry {
  family: string;
  operation: ApiOperation;
}

/** Every operation in a channel's public reference, in document order. */
export function listApiCatalogOperations(reference: ApiReference): ApiCatalogEntry[] {
  return reference.families.flatMap((family) =>
    family.operations.map((operation) => ({ family: family.name, operation }))
  );
}

/** Dashboard playground sections, which are narrower than the public API families. */
export type PlaygroundModule = "wallets" | "payments" | "counterparties" | "issuance";

/** Where the dashboard already has a playground for a public API family. */
export const PLAYGROUND_FAMILY_SECTIONS: ReadonlyMap<string, PlaygroundModule> = new Map([
  ["Wallets", "wallets"],
  ["Payments", "payments"],
  ["Counterparties", "counterparties"],
  ["Issuance", "issuance"],
]);

/** The fields a generated dashboard playground form reads. */
export interface PlaygroundField {
  key: string;
  label: string;
  description?: string;
  defaultValue?: string;
  required: boolean;
  kind?: "select" | "textarea";
  options?: { label: string; value: string }[];
  valueType?: "boolean" | "number" | "string_array" | "json";
}

/** A playground form projected from the same operation the docs render. */
export interface PlaygroundEndpoint {
  id: string;
  operationId: string;
  title: string;
  method: ApiOperation["method"];
  path: string;
  pathFields: PlaygroundField[];
  bodyFields: PlaygroundField[];
  expectedResponse: unknown;
}

function fieldFromParameter(parameter: ApiParameter): PlaygroundField | null {
  if (parameter.in !== "path" && parameter.in !== "query") return null;
  const { schema } = parameter;
  const example = parameter.sample;
  const shouldDefault =
    parameter.in === "path" ||
    parameter.required ||
    schema.example !== undefined ||
    schema.default !== undefined;
  const field: PlaygroundField = {
    key: parameter.name,
    label: parameter.in === "path" ? `{${parameter.name}}` : parameter.name,
    description: parameter.description ?? schema.description ?? undefined,
    defaultValue: shouldDefault
      ? example === undefined || example === null
        ? ""
        : typeof example === "string"
          ? example
          : JSON.stringify(example)
      : undefined,
    required: parameter.required,
  };

  if (schema.enum !== null) {
    field.kind = "select";
    field.options = schema.enum.map((value) => ({ label: String(value), value: String(value) }));
  } else if (schema.type === "boolean") {
    field.kind = "select";
    field.options = [
      { label: "true", value: "true" },
      { label: "false", value: "false" },
    ];
    field.valueType = "boolean";
  } else if (schema.type === "integer" || schema.type === "number") {
    field.valueType = "number";
  } else if (schema.type === "array") {
    field.valueType = "string_array";
  }
  return field;
}

/** Keep the playground's form fields and examples aligned with a public reference operation. */
export function toPlaygroundEndpoint(operation: ApiOperation): PlaygroundEndpoint {
  const queryNames = operation.parameters
    .filter((parameter) => parameter.in === "query")
    .map((parameter) => `${parameter.name}={${parameter.name}}`);
  const path =
    queryNames.length === 0 ? operation.path : `${operation.path}?${queryNames.join("&")}`;
  const bodyFields: PlaygroundField[] =
    operation.requestBody === null
      ? []
      : [
          {
            key: "$body",
            label: "JSON request body",
            description: "Generated from this operation's public OpenAPI request schema.",
            kind: "textarea",
            valueType: "json",
            defaultValue: JSON.stringify(operation.request.body, null, 2),
            required: operation.requestBody.required,
          },
        ];
  const success = operation.responses.find((response) => /^2\d\d$/.test(response.status));
  return {
    id: operation.endpointId,
    operationId: operation.operationId,
    title: operation.summary,
    method: operation.method,
    path,
    pathFields: operation.parameters
      .map(fieldFromParameter)
      .filter((field): field is PlaygroundField => field !== null),
    bodyFields,
    expectedResponse: success?.body.kind === "json" ? success.body.example : {},
  };
}
