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

function getNamedExampleValue(examples, preferredName) {
  if (!examples || typeof examples !== "object") {
    return undefined;
  }

  const preferredExample = preferredName ? examples[preferredName] : undefined;
  if (
    preferredExample &&
    typeof preferredExample === "object" &&
    "value" in preferredExample &&
    preferredExample.value !== undefined
  ) {
    return preferredExample.value;
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

function getRequestHeaders(operation, routePath, method) {
  const headers = [];

  if (operation.requestBody?.content?.["application/json"]) {
    headers.push({
      key: "Content-Type",
      value: "application/json",
      type: "text",
    });
  }

  // A route that requires Idempotency-Key 400s without one. The key is a saved
  // collection variable per operation, not {{$guid}}: a retry after a timeout
  // must resend the same key or it pays twice, and one operation's response
  // must never retire another's key. IDEMPOTENCY_KEY_EVENTS mints and retires it.
  const requiresIdempotencyKey = (operation.parameters ?? []).some(
    (parameter) =>
      parameter?.in === "header" &&
      parameter.required === true &&
      typeof parameter.name === "string" &&
      parameter.name.toLowerCase() === "idempotency-key"
  );
  if (requiresIdempotencyKey) {
    headers.push({
      key: "Idempotency-Key",
      value: `{{${idempotencyKeyVariable(operation, routePath, method)}}}`,
      type: "text",
    });
  }

  return headers;
}

/** The collection variable holding one operation's saved Idempotency-Key. */
function idempotencyKeyVariable(operation, routePath, method) {
  const name = operation.operationId ?? `${method}_${routePath}`.replace(/[^A-Za-z0-9]+/g, "_");
  return `idempotencyKey.${name}`;
}

/**
 * Collection-level scripts for the saved Idempotency-Key. Each operation keeps
 * its own `idempotencyKey.<operationId>` variable, minted only when none is saved. The key is retired once
 * the operation has a final answer: a replay, or any status below 500 other
 * than 409 and 429 (the rule the dashboard uses). A dry run never retires it.
 * A timeout runs no test script and a 5xx keeps the key, so pressing Send again retries the same
 * operation instead of starting a second one.
 */
const SAVED_KEY_VARIABLE = [
  'const header = pm.request.headers.find((h) => h.key.toLowerCase() === "idempotency-key");',
  "const saved = header && /^\\{\\{(idempotencyKey\\.[^}]+)\\}\\}$/.exec(header.value);",
  "const variable = saved && saved[1];",
];
const IDEMPOTENCY_KEY_EVENTS = [
  {
    listen: "prerequest",
    script: {
      type: "text/javascript",
      exec: [
        ...SAVED_KEY_VARIABLE,
        "if (variable && !pm.collectionVariables.get(variable)) {",
        '  pm.collectionVariables.set(variable, pm.variables.replaceIn("{{$guid}}"));',
        "}",
      ],
    },
  },
  {
    listen: "test",
    script: {
      type: "text/javascript",
      exec: [
        ...SAVED_KEY_VARIABLE,
        'const dryRun = pm.request.headers.find((h) => h.key.toLowerCase() === "dry-run" && !h.disabled);',
        '// A dry run answers without running the operation, so it never retires its key.',
        'if (variable && !(dryRun && String(pm.variables.replaceIn(dryRun.value)).toLowerCase() === "true")) {',
        "  const status = pm.response.code;",
        '  const replayed = pm.response.headers.get("Idempotent-Replayed") === "true";',
        "  if (replayed || (status < 500 && status !== 409 && status !== 429)) {",
        "    pm.collectionVariables.unset(variable);",
        "  }",
        "}",
      ],
    },
  },
];

function getRequestBody(spec, operation, preferredExampleName) {
  const jsonBody = operation.requestBody?.content?.["application/json"];
  if (!jsonBody) {
    return undefined;
  }

  const example =
    jsonBody.example ??
    getNamedExampleValue(jsonBody.examples, preferredExampleName) ??
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

function allowsAnonymousAccess(security) {
  return (
    Array.isArray(security) &&
    security.some(
      (requirement) =>
        requirement &&
        typeof requirement === "object" &&
        !Array.isArray(requirement) &&
        Object.keys(requirement).length === 0
    )
  );
}

function createRequestItem(spec, baseUrl, routePath, method, operation) {
  const allowsAnonymous = allowsAnonymousAccess(operation.security);
  const request = {
    method: method.toUpperCase(),
    header: getRequestHeaders(operation, routePath, method),
    url: buildRequestUrl(baseUrl, routePath),
    description: operation.description || operation.summary || "",
  };

  // Collection auth is inherited by default. Optional-auth operations must
  // override it so the placeholder API key does not turn a valid anonymous
  // request into an INVALID_API_KEY response.
  if (allowsAnonymous) {
    request.auth = { type: "noauth" };
  }

  const body = getRequestBody(spec, operation, allowsAnonymous ? "anonymous" : undefined);
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
    event: IDEMPOTENCY_KEY_EVENTS,
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
