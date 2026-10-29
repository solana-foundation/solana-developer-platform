import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  OpenAPIObject,
  OperationObject,
  ParameterObject,
  ReferenceObject,
  SecurityRequirementObject,
} from "openapi3-ts/oas30";

import {
  dereferenceParameter,
  dereferenceRequestBody,
  dereferenceResponse,
  dereferenceSchema,
  type HttpMethod,
  isHttpMethod,
  sampleFromSchema,
  toEndpointId,
} from "@/openapi/document-reader";
import { valueGates } from "@/openapi/release-channel-values";
import routeActionsJson from "@/openapi/route-actions.generated.json";
import { createPublicOpenApiDocument } from "@/openapi/spec";
import { type RouteOwner, routeOwnerOf } from "@/routes/route-modules";

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
  /** The SDP module that owns the route; the dashboard drops it outside its release channel. */
  releaseModule: RouteOwner;
  /**
   * API routes of the same method whose literal segments win, in the API's router, over
   * this operation's parameters (`/v1/counterparties/accounts` over
   * `/v1/counterparties/{counterpartyId}`). A request one of them matches is not this
   * operation, so the execute route refuses it.
   */
  shadowedBy: string[];
  pathFields: PlaygroundField[];
  bodyFields: PlaygroundField[];
  expectedResponse: unknown;
}

const PLAYGROUND_METHODS: Record<HttpMethod, PlaygroundMethod> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
};
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
  const releaseModule = routeOwnerOf(pathname);
  if (releaseModule === undefined) {
    throw new Error(`${pathname} has no owning module in src/routes/route-modules.ts`);
  }
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
      method: PLAYGROUND_METHODS[method],
      path: buildPathWithQuery(pathname, pathAndQuery),
      releaseModule,
      shadowedBy: shadowingRoutes(PLAYGROUND_METHODS[method], pathname),
      pathFields: parameters
        .map((parameter) => fieldFromParameter(parameter, document))
        .filter((field): field is PlaygroundField => field !== null),
      bodyFields: buildBodyFields(operation, document),
      expectedResponse: buildExpectedResponse(operation, document),
    },
  };
}

/**
 * The catalog holds every release channel's operations. The dashboard filters it
 * at runtime by its own `SDP_RELEASE_CHANNEL`, so one committed file serves
 * every deployment.
 */
/** A route's segments, a parameter (`{name}` or `:name`) as null. */
function routeSegments(template: string): (string | null)[] {
  return template
    .split("/")
    .map((segment) => (segment.startsWith("{") || segment.startsWith(":") ? null : segment));
}

/**
 * The API routes that take a request this operation's template also matches: the same
 * method and length, compatible segment by segment, with a literal where the template
 * has a parameter. Taken from every route the app mounts (`route-actions.generated.json`),
 * published or not, since an unpublished one is exactly what must not run.
 */
/** A `route-actions.generated.json` key, `METHOD /path`; any other shape fails the build. */
function parseRouteOperation(operation: string): { method: string; path: string } {
  const match = /^([A-Z]+) (\/\S*)$/.exec(operation);
  if (match === null) {
    throw new Error(`route-actions.generated.json has a malformed operation: ${operation}`);
  }
  const [, method, path] = match;
  if (method === undefined || path === undefined) {
    throw new Error(`route-actions.generated.json has a malformed operation: ${operation}`);
  }
  return { method, path };
}

function shadowingRoutes(method: PlaygroundMethod, template: string): string[] {
  const own = routeSegments(template);
  return Object.keys(routeActionsJson)
    .map(parseRouteOperation)
    .filter((route) => route.method === method)
    .map((route) => route.path)
    .filter((routePath) => {
      const theirs = routeSegments(routePath);
      if (theirs.length !== own.length) return false;
      let literalOverParameter = false;
      for (const [index, segment] of own.entries()) {
        const other = theirs[index];
        if (segment !== null && other !== null && segment !== other) return false;
        if (segment === null && other !== null) literalOverParameter = true;
        if (segment !== null && other === null) return false;
      }
      return literalOverParameter;
    })
    .map((routePath) => routePath.replace(/:[^/]+/g, "{_}"))
    .sort();
}

function generateCatalog(): string {
  const document = createPublicOpenApiDocument({ releaseChannel: "experimental" });
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
      // Also the dashboard playground's allowlist: its proxy route runs only
      // these operations, and a hand-authored form outside them is not offered.
      modules,
      // Which module or ramp provider owns a field value, so the dashboard drops
      // options, defaults and example values its channel does not run.
      valueGates: valueGates(),
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
