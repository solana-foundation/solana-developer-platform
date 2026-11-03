import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ACTIONS, type Action, isApiKeyGrantableAction } from "@sdp/types/actions";
import {
  isReferenceObject,
  type OpenAPIObject,
  type ReferenceObject,
  type ResponseObject,
  type SchemaObject,
  type SecurityRequirementObject,
} from "openapi3-ts/oas30";
import { z } from "zod";
import routeActionsJson from "@/openapi/route-actions.generated.json";
import { createOpenApiDocument, createPublicOpenApiDocument } from "@/openapi/spec";
import { routeActionKey } from "@/routes/route-actions";
import { findShadowingRoutePaths } from "./lib/route-shadowing";

const methods = ["get", "post", "put", "patch", "delete"] as const;

/** Inline local schema references so the CLI needs no API source at runtime. */
function inlineSchema(
  schema: SchemaObject | ReferenceObject,
  document: OpenAPIObject,
  ancestors: readonly string[]
): SchemaObject {
  if (isReferenceObject(schema)) {
    const prefix = "#/components/schemas/";
    if (!schema.$ref.startsWith(prefix) || ancestors.includes(schema.$ref)) {
      throw new Error(`Unsupported CLI schema reference: ${schema.$ref}`);
    }
    const name = schema.$ref.slice(prefix.length).replaceAll("~1", "/").replaceAll("~0", "~");
    const target = document.components?.schemas?.[name];
    if (!target) throw new Error(`Missing CLI schema reference: ${schema.$ref}`);
    return inlineSchema(target, document, [...ancestors, schema.$ref]);
  }
  const result = { ...schema };
  // OpenAPI 3.0 says nullable only modifies an explicit type. With no type,
  // null already passes; omit this redundant annotation for JSON Schema validators.
  if (result.type === undefined) delete result.nullable;
  if (schema.properties) {
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        inlineSchema(value, document, ancestors),
      ])
    );
  }
  if (schema.items) result.items = inlineSchema(schema.items, document, ancestors);
  if (typeof schema.additionalProperties === "object") {
    result.additionalProperties = inlineSchema(schema.additionalProperties, document, ancestors);
  }
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const variants = schema[key];
    if (variants) result[key] = variants.map((value) => inlineSchema(value, document, ancestors));
  }
  return result;
}

/** Close each object variant without rejecting properties defined inside a union. */
function closeRequestVariants(schema: SchemaObject): void {
  if (schema.type === "object") schema.additionalProperties = false;
  for (const keyword of ["oneOf", "anyOf"] as const) {
    const variants = schema[keyword];
    if (variants === undefined) continue;
    for (const variant of variants) {
      if (isReferenceObject(variant)) throw new Error("CLI request schemas must be inline");
      closeRequestVariants(variant);
    }
  }
}

/** API-key secrets use this documented response path on create and rotate. */
function returnsApiKeySecret(schema: SchemaObject | null): boolean {
  if (schema === null) return false;
  let current = schema;
  for (const name of ["data", "apiKey", "key"]) {
    const property = current.properties?.[name];
    if (property === undefined) return false;
    if (isReferenceObject(property))
      throw new Error("CLI secret detection requires inline schemas");
    current = property;
  }
  return true;
}

function authorizationForOperation(
  operationId: string,
  action: Action | undefined,
  security: SecurityRequirementObject[]
) {
  if (
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation IDs, not credentials.
    ["receiveClerkWebhook", "receiveSandboxRampWebhook", "receiveProductionRampWebhook"].includes(
      operationId
    )
  ) {
    if (action !== undefined)
      throw new Error("Signed webhook unexpectedly declares a tenant action");
    const signatureHeaders = security.map((requirement) =>
      Object.keys(requirement).map((name) => {
        const scheme = internal.components?.securitySchemes?.[name];
        if (
          scheme === undefined ||
          isReferenceObject(scheme) ||
          scheme.type !== "apiKey" ||
          scheme.in !== "header" ||
          scheme.name === undefined
        )
          throw new Error(`Unsupported webhook signature scheme: ${name}`);
        return scheme.name.toLowerCase();
      })
    );
    if (signatureHeaders.length === 0 || signatureHeaders.some((headers) => headers.length === 0))
      throw new Error("Webhook ingress must require signature headers");
    return { kind: "webhook", signatureHeaders } as const;
  }
  // Creation is authorized by clerkSignupSessionMiddleware before a tenant
  // exists. Its publicRoute declaration intentionally has no tenant action.
  if (operationId === "createOrganization") {
    if (action !== undefined)
      throw new Error("Organization signup unexpectedly declares an action");
    return { kind: "signup" } as const;
  }
  // Health, discovery and published token metadata declare publicRoute without account credentials.
  if (
    [
      "getTokenMetadataJson",
      "healthCheck",
      "healthReadiness",
      "getApiOpenApiDocument",
      // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
      "getApiDocsPage",
      "getApiAiDiscovery",
      "getApiRoot",
    ].includes(operationId)
  ) {
    if (action !== undefined)
      throw new Error(`Public operation unexpectedly declares an action: ${operationId}`);
    return { kind: "public" } as const;
  }
  // The chain-wide dashboard snapshot declares publicRoute but still runs
  // unified authentication and requireHumanSession; it has no tenant action.
  // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
  if (operationId === "getDashboardNetworkSnapshot") {
    if (action !== undefined) throw new Error("Network snapshot unexpectedly declares an action");
    return { kind: "session" } as const;
  }
  // Onboarding verifies a Clerk session's active organization before its SDP
  // organization mapping exists. It requires no tenant action or project.
  if (operationId === "getOnboardingStatus") {
    if (action !== undefined) throw new Error("Onboarding status unexpectedly declares an action");
    return { kind: "session" } as const;
  }
  // Leaving uses publicRoute because every signed-in member may end their
  // own membership; it requires a tenant session, not members.manage.
  if (operationId === "leaveOrganization") {
    if (action !== undefined) throw new Error("Leaving unexpectedly declares an action");
    return { kind: "membership" } as const;
  }
  if (
    ["getPaymentLink", "getPaymentLinkMetadata", "preparePaymentLinkTransaction"].includes(
      operationId
    )
  ) {
    if (action !== undefined)
      throw new Error("Payment links unexpectedly declare an account action");
    return { kind: "payment-link" } as const;
  }
  if (action === undefined) throw new Error(`Missing CLI route action: ${operationId}`);
  return { kind: "action", action } as const;
}

const internal = createOpenApiDocument();
const published = createPublicOpenApiDocument({ releaseChannel: "experimental" });
const routeActions = z.record(z.string(), z.enum(ACTIONS)).parse(routeActionsJson);
// Include documented publicRoute operations as well as action-gated routes:
// DELETE /members/me must shadow DELETE /members/{memberId}.
const routeOperations = [
  ...Object.keys(routeActions),
  ...Object.entries(internal.paths).flatMap(([path, item]) =>
    methods
      .filter((method) => item[method] !== undefined)
      .map((method) => `${method.toUpperCase()} ${path}`)
  ),
];
const operations = [];
for (const [path, item] of Object.entries(internal.paths)) {
  if (
    ![
      "/v1/projects",
      "/v1/organizations",
      "/v1/members",
      "/v1/api-keys",
      "/v1/wallets",
      "/v1/counterparties",
      "/v1/payments/wallets",
      "/v1/onboarding",
      "/v1/payments/transfers",
      "/v1/payments/transfer-batches",
      "/v1/payments/requests",
      "/v1/payments/recurring-payments",
      "/v1/payments/subscription-plans",
      "/v1/payments/subscriptions",
      "/v1/payments/ramps",
      "/v1/transactions",
      "/v1/earn",
      "/v1/dvp",
      "/v1/issuance",
      "/v1/private-channels",
      "/v1/compliance",
      "/v1/places",
      "/v1/helius-rings",
      "/internal/dashboard/helius-rings",
      "/internal/dashboard/custody",
      "/internal/dashboard/wallets",
      "/internal/dashboard/fireblocks",
      "/internal/dashboard/network",
      "/pay",
      "/webhooks",
      "/health",
      "/openapi.json",
      "/docs",
      "/llms.txt",
      "/",
    ].some((family) => path === family || path.startsWith(`${family}/`))
  )
    continue;
  for (const method of methods) {
    // Public schemas reflect publication holds (including provider availability).
    // Authenticated history can also return publication-held modules at runtime;
    // retain its internal request and response variants without publishing them.
    const operation =
      path === "/v1/transactions"
        ? item[method]
        : (published.paths[path]?.[method] ?? item[method]);
    if (!operation) continue;
    if (
      !operation.operationId ||
      !operation.summary ||
      !operation.description ||
      !operation.security
    ) {
      throw new Error(`Incomplete CLI operation: ${method} ${path}`);
    }
    const authorization = authorizationForOperation(
      operation.operationId,
      routeActions[routeActionKey(method, path)],
      operation.security
    );
    if (authorization.kind === "public" && operation.security.length !== 0)
      throw new Error(
        `Public CLI operation unexpectedly requires credentials: ${operation.operationId}`
      );
    if (
      authorization.kind === "session" &&
      (operation.security.length !== 1 || !("clerkBearerAuth" in operation.security[0]))
    )
      throw new Error(
        `Session-only CLI operation has unexpected security: ${operation.operationId}`
      );
    const sessionOnly =
      authorization.kind !== "payment-link" &&
      authorization.kind !== "public" &&
      authorization.kind !== "webhook" &&
      (authorization.kind !== "action" ||
        !isApiKeyGrantableAction(authorization.action) ||
        operation.security.every((entry) => "clerkBearerAuth" in entry));
    const parameters = [];
    for (const parameter of operation.parameters ?? []) {
      if (
        isReferenceObject(parameter) ||
        !parameter.schema ||
        (parameter.in !== "path" && parameter.in !== "query" && parameter.in !== "header")
      ) {
        throw new Error(`Unsupported CLI parameter: ${operation.operationId}`);
      }
      if (
        parameter.in === "header" &&
        !["x-project-id", "idempotency-key", "if-none-match"].includes(
          parameter.name.toLowerCase()
        ) &&
        !(
          authorization.kind === "webhook" &&
          authorization.signatureHeaders.flat().includes(parameter.name.toLowerCase())
        )
      ) {
        throw new Error(`Unsupported CLI header: ${parameter.name}`);
      }
      parameters.push({
        name: parameter.name,
        location: parameter.in,
        required: parameter.required === true,
        schema: inlineSchema(parameter.schema, internal, []),
      });
    }
    let body: SchemaObject | null = null;
    let rawBody: { contentType: "application/json"; maxBytes: number } | null = null;
    if (operation.requestBody) {
      if (isReferenceObject(operation.requestBody)) throw new Error("Referenced request body");
      const schema = operation.requestBody.content["application/json"]?.schema;
      if (!schema) throw new Error(`Missing JSON request body: ${operation.operationId}`);
      const inline = inlineSchema(schema, internal, []);
      if (inline.type === "string" && inline.format === "binary") {
        if (
          authorization.kind !== "webhook" ||
          !operation.requestBody.required ||
          !inline.maxLength ||
          inline.maxLength <= 0
        )
          throw new Error(`Invalid signed raw-body contract: ${operation.operationId}`);
        rawBody = { contentType: "application/json", maxBytes: inline.maxLength };
      } else {
        body = inline;
        // Reject typos instead of silently dropping fields from PATCH payloads.
        closeRequestVariants(body);
      }
    }
    if (authorization.kind === "webhook" && rawBody === null)
      throw new Error(`Webhook ingress must preserve raw bytes: ${operation.operationId}`);
    const responses: Record<string, SchemaObject | null> = {};
    const binaryResponses: Record<string, "image/png"> = {};
    type SpecialResponse =
      | { kind: "text"; contentType: "text/plain" | "text/html"; schema: SchemaObject }
      | { kind: "redirect"; locationSchema: SchemaObject }
      | { kind: "not-modified" }
      | { kind: "diagnostic"; schema: SchemaObject };
    const specialResponses: Record<string, SpecialResponse> = {};
    const documentedResponses: Record<string, ResponseObject | ReferenceObject> =
      operation.responses;
    for (const [status, response] of Object.entries(documentedResponses)) {
      if (isReferenceObject(response)) throw new Error("Referenced response");
      if (status === "304") {
        if (response.content !== undefined) throw new Error("304 must not declare a response body");
        specialResponses[status] = { kind: "not-modified" };
        continue;
      }
      if (status.startsWith("3")) {
        const location = Object.entries(response.headers ?? {}).find(
          ([name]) => name.toLowerCase() === "location"
        )?.[1];
        if (location === undefined || isReferenceObject(location) || location.schema === undefined)
          throw new Error(`Redirect must declare its Location schema: ${operation.operationId}`);
        specialResponses[status] = {
          kind: "redirect",
          locationSchema: inlineSchema(location.schema, internal, []),
        };
        continue;
      }
      const json = response.content?.["application/json"]?.schema;
      if (!status.startsWith("2")) {
        if (json !== undefined) {
          const schema = inlineSchema(json, internal, []);
          // Preserve documented diagnostic reports such as readiness's 503,
          // while standard API errors keep the shared error-envelope path.
          if (schema.properties !== undefined && schema.properties.error === undefined)
            specialResponses[status] = { kind: "diagnostic", schema };
        }
        continue;
      }
      if (response.content === undefined) {
        responses[status] = null;
        continue;
      }
      const png = response.content["image/png"]?.schema;
      if (png !== undefined) {
        if (isReferenceObject(png) || png.type !== "string" || png.format !== "binary")
          throw new Error(`Unsupported PNG response: ${operation.operationId}`);
        binaryResponses[status] = "image/png";
        continue;
      }
      const textType = (["text/plain", "text/html"] as const).find(
        (type) => response.content?.[type] !== undefined
      );
      if (textType !== undefined) {
        const textSchema = response.content[textType]?.schema;
        if (textSchema === undefined)
          throw new Error(`Unsupported text response: ${operation.operationId}`);
        specialResponses[status] = {
          kind: "text",
          contentType: textType,
          schema: inlineSchema(textSchema, internal, []),
        };
        continue;
      }
      if (!json) throw new Error(`Missing JSON response: ${operation.operationId}`);
      responses[status] = inlineSchema(json, internal, []);
    }
    operations.push({
      operationId: operation.operationId,
      summary: operation.summary,
      description: operation.description,
      shadowedBy: findShadowingRoutePaths(method.toUpperCase(), path, routeOperations),
      authorization,
      method: method.toUpperCase(),
      path,
      sessionOnly,
      parameters,
      body,
      rawBody,
      responses,
      binaryResponses,
      specialResponses,
      returnsApiKeySecret: Object.values(responses).some(returnsApiKeySecret),
      returnsRampClientSecret: Object.values(responses).some((schema) => {
        if (schema === null) return false;
        const data = schema.properties?.data;
        if (data === undefined) return false;
        if (isReferenceObject(data))
          throw new Error("CLI secret detection requires inline schemas");
        const quote = data.properties?.quote;
        if (quote === undefined) return false;
        if (isReferenceObject(quote))
          throw new Error("CLI secret detection requires inline quotes");
        return quote.properties?.clientSecret !== undefined;
      }),
      returnsPaymentLinkToken: Object.values(responses).some((schema) => {
        if (schema === null) return false;
        const data = schema.properties?.data;
        if (data === undefined) return false;
        if (isReferenceObject(data)) throw new Error("CLI token detection requires inline schemas");
        return data.properties?.publicToken !== undefined;
      }),
    });
  }
}
operations.sort((left, right) => left.operationId.localeCompare(right.operationId));
const serialized = `${JSON.stringify(
  {
    generatedBy: "pnpm generate:cli (do not edit by hand)",
    operations,
  },
  null,
  2
)}\n`;
const destination = fileURLToPath(
  new URL("../../sdp-cli/src/contract.generated.json", import.meta.url)
);
// Invoke the installed formatter directly: package-manager stdin forwarding can
// stall on large contracts, and its executable is a .cmd shim on Windows.
const biomeCli = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");
const output = execFileSync(
  process.execPath,
  [biomeCli, "format", "--stdin-file-path", destination],
  {
    input: serialized,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
    encoding: "utf8",
  }
);
const args = process.argv.slice(2);
if (args.length === 0) {
  await writeFile(destination, output);
  console.log(`CLI contract generated at ${destination}`);
} else if (args.length === 1 && args[0] === "--check") {
  if ((await readFile(destination, "utf8")) !== output) {
    throw new Error("CLI contract is stale. Run pnpm generate:cli.");
  }
  console.log("CLI contract is current.");
} else {
  throw new Error("Usage: generate-cli-contract.ts [--check]");
}
