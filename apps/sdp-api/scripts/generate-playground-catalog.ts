import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPublicOpenApiDocument } from "../src/openapi/spec";

type JsonRecord = Record<string, unknown>;
type PlaygroundMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type PlaygroundModule = "wallets" | "payments" | "counterparties" | "issuance";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
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

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function dereferenceSchema(schema: unknown, document: JsonRecord): JsonRecord {
  if (!isRecord(schema)) {
    return {};
  }

  const reference = schema.$ref;
  if (typeof reference !== "string" || !reference.startsWith("#/")) {
    return schema;
  }

  const resolved = reference
    .slice(2)
    .split("/")
    .reduce<unknown>((current, segment) => {
      if (!isRecord(current)) {
        return undefined;
      }
      return current[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
    }, document);

  return dereferenceSchema(resolved, document);
}

function sampleObjectFromSchema(schema: JsonRecord, document: JsonRecord): JsonRecord {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const sample: JsonRecord = {};

  for (const [name, propertySchema] of Object.entries(properties)) {
    const property = dereferenceSchema(propertySchema, document);
    const hasUsefulSample =
      required.has(name) ||
      "example" in property ||
      "default" in property ||
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

function sampleFromSchema(input: unknown, document: JsonRecord, propertyName?: string): unknown {
  const schema = dereferenceSchema(input, document);

  if ("example" in schema) {
    return schema.example;
  }
  if ("default" in schema) {
    return schema.default;
  }

  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return enumValues[0];
  }

  for (const variantKey of ["oneOf", "anyOf", "allOf"]) {
    const variants = schema[variantKey];
    if (Array.isArray(variants) && variants.length > 0) {
      if (variantKey === "allOf") {
        return Object.assign(
          {},
          ...variants.map((variant) => sampleFromSchema(variant, document, propertyName))
        );
      }
      return sampleFromSchema(variants[0], document, propertyName);
    }
  }

  if (schema.type === "object" || isRecord(schema.properties)) {
    return sampleObjectFromSchema(schema, document);
  }

  if (schema.type === "array") {
    return [sampleFromSchema(schema.items, document, propertyName)];
  }
  if (schema.type === "boolean") {
    return false;
  }
  if (schema.type === "integer" || schema.type === "number") {
    return 1;
  }

  if (schema.format === "date-time") {
    return "2026-01-01T00:00:00.000Z";
  }
  if (schema.format === "date") {
    return "2026-01-01";
  }
  if (schema.format === "uri" || schema.format === "url") {
    return "https://example.com";
  }

  if (propertyName?.toLowerCase().endsWith("id")) {
    return `${propertyName.replace(/Id$/i, "").toLowerCase()}_example`;
  }
  if (propertyName?.toLowerCase().includes("address")) {
    return "11111111111111111111111111111111";
  }
  return "example";
}

function fieldFromParameter(parameterInput: unknown, document: JsonRecord): JsonRecord | null {
  const parameter = dereferenceSchema(parameterInput, document);
  if (parameter.in !== "path" && parameter.in !== "query") {
    return null;
  }

  const name = typeof parameter.name === "string" ? parameter.name : "";
  if (!name) {
    return null;
  }

  const schema = dereferenceSchema(parameter.schema, document);
  const example = sampleFromSchema(schema, document, name);
  const shouldDefault =
    parameter.in === "path" ||
    parameter.required === true ||
    "example" in parameter ||
    "example" in schema ||
    "default" in schema;
  const field: JsonRecord = {
    key: name,
    label: parameter.in === "path" ? `{${name}}` : name,
    description:
      typeof parameter.description === "string"
        ? parameter.description
        : typeof schema.description === "string"
          ? schema.description
          : undefined,
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
    field.options = schema.enum.map((value) => ({
      label: String(value),
      value: String(value),
    }));
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

  return Object.fromEntries(Object.entries(field).filter(([, value]) => value !== undefined));
}

function buildPathWithQuery(pathname: string, parameters: JsonRecord[]): string {
  const queryNames = parameters
    .filter((parameter) => parameter.in === "query" && typeof parameter.name === "string")
    .map((parameter) => `${parameter.name}={${parameter.name}}`);

  return queryNames.length > 0 ? `${pathname}?${queryNames.join("&")}` : pathname;
}

function buildBodyFields(operation: JsonRecord, document: JsonRecord): JsonRecord[] {
  const requestBody = dereferenceSchema(operation.requestBody, document);
  const content = isRecord(requestBody.content) ? requestBody.content : {};
  const jsonContent = isRecord(content["application/json"]) ? content["application/json"] : {};
  const schema = jsonContent.schema;

  if (!schema) {
    return [];
  }

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

function buildExpectedResponse(operation: JsonRecord, document: JsonRecord): unknown {
  const responses = isRecord(operation.responses) ? operation.responses : {};
  const successEntry = Object.entries(responses).find(([status]) => /^2\d\d$/.test(status));
  if (!successEntry) {
    return {};
  }

  const response = dereferenceSchema(successEntry[1], document);
  const content = isRecord(response.content) ? response.content : {};
  const jsonContent = isRecord(content["application/json"]) ? content["application/json"] : {};
  return jsonContent.schema ? sampleFromSchema(jsonContent.schema, document) : {};
}

function toEndpointId(operationId: string): string {
  return operationId
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .toLowerCase();
}

function generateCatalog(): string {
  const document = createPublicOpenApiDocument() as unknown as JsonRecord;
  const paths = isRecord(document.paths) ? document.paths : {};
  const modules: Record<PlaygroundModule, JsonRecord[]> = {
    wallets: [],
    payments: [],
    counterparties: [],
    issuance: [],
  };

  for (const [pathname, pathItemInput] of Object.entries(paths)) {
    if (!isRecord(pathItemInput)) {
      continue;
    }

    const pathParameters = Array.isArray(pathItemInput.parameters) ? pathItemInput.parameters : [];

    for (const [method, operationInput] of Object.entries(pathItemInput)) {
      if (!HTTP_METHODS.has(method) || !isRecord(operationInput)) {
        continue;
      }

      const tag = Array.isArray(operationInput.tags) ? operationInput.tags[0] : undefined;
      const module = typeof tag === "string" ? TAG_TO_MODULE.get(tag) : undefined;
      if (!module) {
        continue;
      }

      const operationId =
        typeof operationInput.operationId === "string"
          ? operationInput.operationId
          : `${method}-${pathname}`;
      const rawParameters = [
        ...pathParameters,
        ...(Array.isArray(operationInput.parameters) ? operationInput.parameters : []),
      ];
      const parameters = rawParameters
        .map((parameter) => dereferenceSchema(parameter, document))
        .filter((parameter) => parameter.in === "path" || parameter.in === "query");

      modules[module].push({
        id: toEndpointId(operationId),
        operationId,
        title: typeof operationInput.summary === "string" ? operationInput.summary : operationId,
        method: method.toUpperCase() as PlaygroundMethod,
        path: buildPathWithQuery(pathname, parameters),
        pathFields: rawParameters
          .map((parameter) => fieldFromParameter(parameter, document))
          .filter((field): field is JsonRecord => field !== null),
        bodyFields: buildBodyFields(operationInput, document),
        expectedResponse: buildExpectedResponse(operationInput, document),
      });
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
