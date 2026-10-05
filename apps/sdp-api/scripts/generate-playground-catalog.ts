import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isReferenceObject,
  type OpenAPIObject,
  type OperationObject,
  type ParameterObject,
  type ReferenceObject,
  type RequestBodyObject,
  type ResponseObject,
  type SchemaObject,
  type SecurityRequirementObject,
} from "openapi3-ts/oas30";

import { createPublicOpenApiDocument } from "../src/openapi/spec";

type PlaygroundMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type PlaygroundModule = "wallets" | "payments" | "counterparties" | "issuance";

interface PlaygroundFieldOption {
  label: string;
  value: string;
}

interface PlaygroundField {
  key: string;
  label: string;
  description?: string;
  defaultValue?: string;
  required: boolean;
  kind?: "select" | "textarea";
  options?: PlaygroundFieldOption[];
  valueType?: "boolean" | "number" | "string_array" | "json";
}

interface PlaygroundOperation {
  id: string;
  operationId: string;
  title: string;
  method: PlaygroundMethod;
  path: string;
  pathFields: PlaygroundField[];
  bodyFields: PlaygroundField[];
  expectedResponse: unknown;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];
const HTTP_METHOD_SET: ReadonlySet<string> = new Set(HTTP_METHODS);

function isHttpMethod(key: string): key is HttpMethod {
  return HTTP_METHOD_SET.has(key);
}
const TAG_TO_MODULE = new Map<string, PlaygroundModule>([
  ["Wallets", "wallets"],
  ["Payments", "payments"],
  ["Counterparties", "counterparties"],
  ["Issuance", "issuance"],
]);

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const outputPath = path.resolve(
  scriptDirectory,
  "../../sdp-web/src/lib/api-playground-catalog.generated.json"
);

/**
 * Whether an operation is callable with an API key. Operations that only
 * accept dashboard credentials would 401 under the playground's key auth.
 *
 * @param security The operation's security requirements; absent means the document default applies.
 * @returns True when some requirement is empty or names `apiKeyAuth`.
 */
function acceptsApiKeyAuth(security: SecurityRequirementObject[] | undefined): boolean {
  if (security === undefined) return true;
  return security.some(
    (requirement) => "apiKeyAuth" in requirement || Object.keys(requirement).length === 0
  );
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
function dereference<T extends object>(
  value: T | ReferenceObject,
  section: ComponentSection,
  document: OpenAPIObject
): T {
  if (!isReferenceObject(value)) return value;
  return dereference(resolveComponent<T>(value.$ref, section, document), section, document);
}

const dereferenceSchema = (schema: SchemaObject | ReferenceObject, document: OpenAPIObject) =>
  dereference<SchemaObject>(schema, "schemas", document);
const dereferenceParameter = (
  parameter: ParameterObject | ReferenceObject,
  document: OpenAPIObject
) => dereference<ParameterObject>(parameter, "parameters", document);
const dereferenceRequestBody = (
  requestBody: RequestBodyObject | ReferenceObject,
  document: OpenAPIObject
) => dereference<RequestBodyObject>(requestBody, "requestBodies", document);
const dereferenceResponse = (response: ResponseObject | ReferenceObject, document: OpenAPIObject) =>
  dereference<ResponseObject>(response, "responses", document);

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

function sampleFromSchema(
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

function fieldFromParameter(
  parameter: ParameterObject,
  document: OpenAPIObject
): PlaygroundField | null {
  if (parameter.in !== "path" && parameter.in !== "query") return null;
  if (!parameter.name) return null;

  const schema = parameter.schema ? dereferenceSchema(parameter.schema, document) : {};
  const example = sampleFromSchema(schema, document, parameter.name);
  const shouldDefault =
    parameter.in === "path" ||
    parameter.required === true ||
    parameter.example !== undefined ||
    schema.example !== undefined ||
    schema.default !== undefined;
  const field: PlaygroundField = {
    key: parameter.name,
    label: parameter.in === "path" ? `{${parameter.name}}` : parameter.name,
    description: parameter.description ?? schema.description,
    defaultValue: shouldDefault
      ? example === undefined || example === null
        ? ""
        : typeof example === "string"
          ? example
          : JSON.stringify(example)
      : undefined,
    required: parameter.in === "path" || parameter.required === true,
  };

  if (Array.isArray(schema.enum)) {
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

function buildPathWithQuery(pathname: string, parameters: ParameterObject[]): string {
  const queryNames = parameters
    .filter((parameter) => parameter.in === "query")
    .map((parameter) => `${parameter.name}={${parameter.name}}`);

  return queryNames.length > 0 ? `${pathname}?${queryNames.join("&")}` : pathname;
}

function buildBodyFields(operation: OperationObject, document: OpenAPIObject): PlaygroundField[] {
  if (!operation.requestBody) return [];
  const requestBody = dereferenceRequestBody(operation.requestBody, document);
  const schema = requestBody.content["application/json"]?.schema;
  if (!schema) return [];

  return [
    {
      key: "$body",
      label: "JSON request body",
      description: "Generated from this operation's public OpenAPI request schema.",
      kind: "textarea",
      valueType: "json",
      defaultValue: JSON.stringify(sampleFromSchema(schema, document), null, 2),
      required: requestBody.required === true,
    },
  ];
}

function buildExpectedResponse(operation: OperationObject, document: OpenAPIObject): unknown {
  const successEntry = Object.entries(operation.responses).find(([status]) =>
    /^2\d\d$/.test(status)
  );
  if (!successEntry) return {};

  const response = dereferenceResponse(successEntry[1], document);
  const schema = response.content?.["application/json"]?.schema;
  return schema ? sampleFromSchema(schema, document) : {};
}

function toEndpointId(operationId: string): string {
  return operationId
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .toLowerCase();
}

interface CatalogEntry {
  module: PlaygroundModule;
  op: PlaygroundOperation;
}

function buildCatalogEntry(
  pathname: string,
  method: HttpMethod,
  operation: OperationObject,
  pathParameters: (ParameterObject | ReferenceObject)[],
  document: OpenAPIObject
): CatalogEntry | null {
  const tag = operation.tags?.[0];
  const module = tag === undefined ? undefined : TAG_TO_MODULE.get(tag);
  if (!module) return null;
  if (!acceptsApiKeyAuth(operation.security)) return null;

  const operationId = operation.operationId ?? `${method}-${pathname}`;
  const parameters = [...pathParameters, ...(operation.parameters ?? [])].map((parameter) =>
    dereferenceParameter(parameter, document)
  );
  const pathAndQuery = parameters.filter(
    (parameter) => parameter.in === "path" || parameter.in === "query"
  );

  return {
    module,
    op: {
      id: toEndpointId(operationId),
      operationId,
      title: operation.summary ?? operationId,
      method: method.toUpperCase() as PlaygroundMethod,
      path: buildPathWithQuery(pathname, pathAndQuery),
      pathFields: parameters
        .map((parameter) => fieldFromParameter(parameter, document))
        .filter((field): field is PlaygroundField => field !== null),
      bodyFields: buildBodyFields(operation, document),
      expectedResponse: buildExpectedResponse(operation, document),
    },
  };
}

function generateCatalog(): string {
  const document = createPublicOpenApiDocument();
  const modules: Record<PlaygroundModule, PlaygroundOperation[]> = {
    wallets: [],
    payments: [],
    counterparties: [],
    issuance: [],
  };

  for (const [pathname, pathItem] of Object.entries(document.paths)) {
    const pathParameters = pathItem.parameters ?? [];
    for (const key of Object.keys(pathItem)) {
      if (!isHttpMethod(key)) continue;
      const operation = pathItem[key];
      if (!operation) continue;
      const entry = buildCatalogEntry(pathname, key, operation, pathParameters, document);
      if (entry) modules[entry.module].push(entry.op);
    }
  }

  return `${JSON.stringify(
    {
      _generated: {
        source: "apps/sdp-api/src/openapi/**",
        command: "pnpm -C apps/sdp-api playground:generate",
        modules: Object.fromEntries(
          Object.entries(modules).map(([module, endpoints]) => [module, endpoints.length])
        ),
      },
      modules,
    },
    null,
    2
  )}\n`;
}

async function formatCatalog(catalog: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-playground-catalog-"));
  const temporaryPath = path.join(directory, "catalog.json");

  try {
    await writeFile(temporaryPath, catalog, "utf8");
    execFileSync(
      "pnpm",
      ["--dir", repositoryRoot, "exec", "biome", "format", "--write", temporaryPath],
      { stdio: "ignore" }
    );
    return await readFile(temporaryPath, "utf8");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

const expected = await formatCatalog(generateCatalog());
if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== expected) {
    process.stderr.write(
      "API playground catalog is stale. Run: pnpm -C apps/sdp-api playground:generate\n"
    );
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, expected, "utf8");
  process.stdout.write(`API playground catalog generated at ${outputPath}\n`);
}
