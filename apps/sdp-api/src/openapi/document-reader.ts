import {
  isReferenceObject,
  type OpenAPIObject,
  type ParameterObject,
  type ReferenceObject,
  type RequestBodyObject,
  type ResponseObject,
  type SchemaObject,
} from "openapi3-ts/oas30";

/**
 * What the generators read from a generated public OpenAPI document: its operations by method,
 * dereferenced components, example values synthesized from schemas, and the dashboard's endpoint
 * ids. The playground catalog (`scripts/generate-playground-catalog.ts`) and the API reference
 * (`openapi/reference.ts`) both read through here, so a sample the docs show is the one the
 * dashboard playground starts from.
 */

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
const HTTP_METHOD_SET: ReadonlySet<string> = new Set(HTTP_METHODS);

export function isHttpMethod(key: string): key is HttpMethod {
  return HTTP_METHOD_SET.has(key);
}

/**
 * Resolves a local `#/components/<section>/<name>` reference against the document.
 *
 * @param reference The `$ref` string.
 * @param section The components section the reference must point into.
 * @param document The OpenAPI document.
 * @returns The referenced component.
 */
function resolveComponent<T>(
  reference: string,
  section: ComponentSection,
  document: OpenAPIObject
): T | ReferenceObject {
  const prefix = `#/components/${section}/`;
  if (!reference.startsWith(prefix)) {
    throw new Error(`Unsupported $ref outside components.${section}: ${reference}`);
  }
  const name = reference.slice(prefix.length).replaceAll("~1", "/").replaceAll("~0", "~");
  const components = document.components;
  if (!components) {
    throw new Error(`Document has no components but ${reference} was referenced`);
  }
  const entry = (components[section] as Record<string, T | ReferenceObject> | undefined)?.[name];
  if (entry === undefined) {
    throw new Error(`Unresolved $ref: ${reference}`);
  }
  return entry;
}

type ComponentSection = "schemas" | "parameters" | "requestBodies" | "responses";

/**
 * Follows `$ref` chains until a concrete component object is reached.
 *
 * @param value The inline object or a reference to one.
 * @param section The components section the reference must resolve within.
 * @param document The OpenAPI document.
 * @returns The concrete object.
 */
export function dereference<T extends object>(
  value: T | ReferenceObject,
  section: ComponentSection,
  document: OpenAPIObject
): T {
  if (!isReferenceObject(value)) return value;
  return dereference(resolveComponent<T>(value.$ref, section, document), section, document);
}

export const dereferenceSchema = (
  schema: SchemaObject | ReferenceObject,
  document: OpenAPIObject
) => dereference<SchemaObject>(schema, "schemas", document);
export const dereferenceParameter = (
  parameter: ParameterObject | ReferenceObject,
  document: OpenAPIObject
) => dereference<ParameterObject>(parameter, "parameters", document);
export const dereferenceRequestBody = (
  requestBody: RequestBodyObject | ReferenceObject,
  document: OpenAPIObject
) => dereference<RequestBodyObject>(requestBody, "requestBodies", document);
export const dereferenceResponse = (
  response: ResponseObject | ReferenceObject,
  document: OpenAPIObject
) => dereference<ResponseObject>(response, "responses", document);

function sampleObjectFromSchema(
  schema: SchemaObject,
  document: OpenAPIObject
): Record<string, unknown> {
  const required = new Set(schema.required ?? []);
  const sample: Record<string, unknown> = {};

  for (const [name, propertySchema] of Object.entries(schema.properties ?? {})) {
    const property = dereferenceSchema(propertySchema, document);
    const hasUsefulSample =
      required.has(name) ||
      property.example !== undefined ||
      property.default !== undefined ||
      Array.isArray(property.enum) ||
      property.type === "object" ||
      property.type === "array" ||
      Array.isArray(property.oneOf) ||
      Array.isArray(property.anyOf);

    if (hasUsefulSample) {
      sample[name] = sampleFromSchema(property, document, name);
    }
  }

  return sample;
}

export function sampleFromSchema(
  input: SchemaObject | ReferenceObject,
  document: OpenAPIObject,
  propertyName?: string
): unknown {
  const schema = dereferenceSchema(input, document);

  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  if (schema.allOf && schema.allOf.length > 0) {
    return Object.assign(
      {},
      ...schema.allOf.map((variant) => sampleFromSchema(variant, document, propertyName))
    );
  }
  const variant = schema.oneOf?.[0] ?? schema.anyOf?.[0];
  if (variant) return sampleFromSchema(variant, document, propertyName);

  if (schema.type === "object" || schema.properties !== undefined) {
    return sampleObjectFromSchema(schema, document);
  }
  if (schema.type === "array") {
    return schema.items ? [sampleFromSchema(schema.items, document, propertyName)] : [];
  }
  if (schema.type === "boolean") return false;
  if (schema.type === "integer" || schema.type === "number") return 1;

  if (schema.format === "date-time") return "2026-01-01T00:00:00.000Z";
  if (schema.format === "date") return "2026-01-01";
  if (schema.format === "uri" || schema.format === "url") return "https://example.com";

  if (propertyName?.toLowerCase().endsWith("id")) {
    return `${propertyName.replace(/Id$/i, "").toLowerCase()}_example`;
  }
  if (propertyName?.toLowerCase().includes("address")) {
    return "11111111111111111111111111111111";
  }
  return "example";
}

export function toEndpointId(operationId: string): string {
  return operationId
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .toLowerCase();
}
