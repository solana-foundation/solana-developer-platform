import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getPrimaryTagName,
  isPublicOperation,
  POSTMAN_COLLECTION_FILENAME,
} from "./lib/public-openapi.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const generatedSpecPath = path.resolve(__dirname, "../../sdp-api/generated/openapi.json");
const outputDir = path.resolve(__dirname, "../public/postman");
const outputPath = path.join(outputDir, POSTMAN_COLLECTION_FILENAME);

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

function resolveSchemaRef(spec, schema) {
  if (!schema || typeof schema !== "object" || !("$ref" in schema) || !schema.$ref) {
    return schema;
  }

  const ref = schema.$ref;
  if (!ref.startsWith("#/")) {
    return schema;
  }

  const segments = ref.slice(2).split("/");
  let current = spec;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return schema;
    }
    current = current[segment];
  }

  return current;
}

function getSchemaRef(schema) {
  return schema && typeof schema === "object" && "$ref" in schema && schema.$ref
    ? schema.$ref
    : null;
}

function buildExampleFromSchema(spec, schema, visitedRefs = new Set()) {
  const schemaRef = getSchemaRef(schema);
  if (schemaRef) {
    if (visitedRefs.has(schemaRef)) {
      return null;
    }
    visitedRefs.add(schemaRef);
  }

  const resolvedSchema = resolveSchemaRef(spec, schema);
  if (!resolvedSchema || typeof resolvedSchema !== "object") {
    return null;
  }

  if ("example" in resolvedSchema && resolvedSchema.example !== undefined) {
    return resolvedSchema.example;
  }

  if ("default" in resolvedSchema && resolvedSchema.default !== undefined) {
    return resolvedSchema.default;
  }

  if (Array.isArray(resolvedSchema.enum) && resolvedSchema.enum.length > 0) {
    return resolvedSchema.enum[0];
  }

  if (Array.isArray(resolvedSchema.oneOf) && resolvedSchema.oneOf.length > 0) {
    return buildExampleFromSchema(spec, resolvedSchema.oneOf[0], new Set(visitedRefs));
  }

  if (Array.isArray(resolvedSchema.anyOf) && resolvedSchema.anyOf.length > 0) {
    return buildExampleFromSchema(spec, resolvedSchema.anyOf[0], new Set(visitedRefs));
  }

  if (Array.isArray(resolvedSchema.allOf) && resolvedSchema.allOf.length > 0) {
    return resolvedSchema.allOf.reduce((merged, branch) => {
      const branchExample = buildExampleFromSchema(spec, branch, new Set(visitedRefs));
      if (
        branchExample &&
        typeof branchExample === "object" &&
        !Array.isArray(branchExample) &&
        merged &&
        typeof merged === "object" &&
        !Array.isArray(merged)
      ) {
        return Object.assign(merged, branchExample);
      }
      return branchExample ?? merged;
    }, {});
  }

  const schemaType =
    typeof resolvedSchema.type === "string"
      ? resolvedSchema.type
      : resolvedSchema.properties
        ? "object"
        : null;

  if (schemaType === "object") {
    const properties = resolvedSchema.properties ?? {};
    return Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [
        key,
        buildExampleFromSchema(spec, value, new Set(visitedRefs)),
      ])
    );
  }

  if (schemaType === "array") {
    return [buildExampleFromSchema(spec, resolvedSchema.items, new Set(visitedRefs))];
  }

  if (schemaType === "string") {
    if (resolvedSchema.format === "date-time") {
      return "2026-01-01T00:00:00.000Z";
    }
    if (resolvedSchema.format === "uri") {
      return "https://example.com";
    }
    if (resolvedSchema.format === "email") {
      return "user@example.com";
    }
    return "";
  }

  if (schemaType === "integer" || schemaType === "number") {
    return 0;
  }

  if (schemaType === "boolean") {
    return false;
  }

  return null;
}

function getNamedExampleValue(examples) {
  if (!examples || typeof examples !== "object") {
    return undefined;
  }

  for (const example of Object.values(examples)) {
    if (
      example &&
      typeof example === "object" &&
      "value" in example &&
      example.value !== undefined
    ) {
      return example.value;
    }
  }

  return undefined;
}

function getRequestHeaders(operation) {
  const headers = [];

  if (operation.requestBody?.content?.["application/json"]) {
    headers.push({
      key: "Content-Type",
      value: "application/json",
      type: "text",
    });
  }

  return headers;
}

function getRequestBody(spec, operation) {
  const jsonBody = operation.requestBody?.content?.["application/json"];
  if (!jsonBody) {
    return undefined;
  }

  const example =
    jsonBody.example ??
    getNamedExampleValue(jsonBody.examples) ??
    buildExampleFromSchema(spec, jsonBody.schema);

  return {
    mode: "raw",
    raw: JSON.stringify(example ?? {}, null, 2),
    options: {
      raw: {
        language: "json",
      },
    },
  };
}

function buildRequestUrl(baseUrl, routePath) {
  return `${baseUrl}${routePath.replace(/\{([^}]+)\}/g, "{{$1}}")}`;
}

function createRequestItem(spec, baseUrl, routePath, method, operation) {
  const request = {
    method: method.toUpperCase(),
    header: getRequestHeaders(operation),
    url: buildRequestUrl(baseUrl, routePath),
    description: operation.description || operation.summary || "",
  };

  const body = getRequestBody(spec, operation);
  if (body) {
    request.body = body;
  }

  return {
    name: operation.summary || `${method.toUpperCase()} ${routePath}`,
    request,
  };
}

function toPostmanCollection(spec) {
  const productionServer =
    spec.servers?.find((server) => server.description === "Production")?.url ||
    spec.servers?.find((server) => typeof server.url === "string" && server.url.startsWith("https"))
      ?.url ||
    "https://api.solana.com";

  const folders = new Map();

  for (const [routePath, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!pathItem || typeof pathItem !== "object") {
      continue;
    }

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== "object" || !isPublicOperation(operation)) {
        continue;
      }

      const tagName = getPrimaryTagName(operation);
      if (!tagName) {
        continue;
      }

      if (!folders.has(tagName)) {
        folders.set(tagName, []);
      }

      folders
        .get(tagName)
        .push(createRequestItem(spec, "{{baseUrl}}", routePath, method, operation));
    }
  }

  const orderedTags = (spec.tags ?? [])
    .map((tag) => tag?.name)
    .filter((tagName) => tagName && folders.has(tagName));

  return {
    info: {
      name: "Solana Developer Platform Public API",
      description:
        "Public Postman collection generated from the SDP OpenAPI contract. Internal-only endpoint families are excluded.",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    auth: {
      type: "bearer",
      bearer: [
        {
          key: "token",
          value: "{{sdpApiKey}}",
          type: "string",
        },
      ],
    },
    variable: [
      {
        key: "baseUrl",
        value: productionServer,
        type: "string",
      },
      {
        key: "sdpApiKey",
        value: "sk_test_your_api_key",
        type: "string",
      },
    ],
    item: orderedTags.map((tagName) => ({
      name: tagName,
      item: folders.get(tagName) ?? [],
    })),
  };
}

async function run() {
  const rawSpec = await fs.readFile(generatedSpecPath, "utf8");
  const spec = JSON.parse(rawSpec);
  const collection = toPostmanCollection(spec);

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(collection, null, 2)}\n`, "utf8");

  console.log(
    `Generated Postman collection with ${collection.item.length} folders at ${outputPath}`
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
