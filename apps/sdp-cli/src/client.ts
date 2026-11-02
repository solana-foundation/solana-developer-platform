import { z } from "zod";
import type { Config } from "./config";
import {
  type Json,
  type JsonObject,
  type Operation,
  type QueryValue,
  validatePayload,
} from "./contract";
import { CliError, usageError } from "./errors";

type ApiPayload = Json | Uint8Array;
export interface ApiResponse {
  body: ApiPayload;
  status: number;
  headers: Record<string, string>;
}

const errorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.json().optional() }),
  meta: z.object({ requestId: z.string().optional() }).optional(),
});

export interface ApiRequest {
  operation: Operation;
  path: Record<string, string>;
  query: Record<string, QueryValue>;
  body: JsonObject | null;
  rawBody?: Uint8Array;
  webhookHeaders?: Record<string, string>;
  idempotencyKey?: string;
  ifNoneMatch?: string;
}

function matchesPath(template: string, path: string): boolean {
  const expected = template.split("/");
  const actual = path.split("/");
  return (
    expected.length === actual.length &&
    expected.every((segment, index) => segment.startsWith("{") || segment === actual[index])
  );
}

function validateHeaders(operation: Operation, headers: Headers): void {
  for (const parameter of operation.parameters.filter((entry) => entry.location === "header")) {
    const value = headers.get(parameter.name);
    if (value === null) {
      if (parameter.required) usageError(`Missing ${parameter.name} header.`);
    } else validatePayload(parameter.schema, value, `Invalid ${parameter.name}`);
  }
}

function requestUrl(config: Config, request: ApiRequest): URL {
  let path = request.operation.path;
  for (const parameter of request.operation.parameters) {
    if (parameter.location === "header") continue;
    const value =
      parameter.location === "path" ? request.path[parameter.name] : request.query[parameter.name];
    if (value === undefined) {
      if (parameter.required) usageError(`Missing ${parameter.name}.`);
      continue;
    }
    validatePayload(parameter.schema, value, `Invalid ${parameter.name}`);
    if (parameter.location === "path") {
      if (value === "." || value === "..") usageError(`Invalid ${parameter.name}.`);
      path = path.replace(`{${parameter.name}}`, encodeURIComponent(String(value)));
    }
  }
  if (path.includes("{")) throw new Error("Unresolved API path parameter");
  if (request.operation.shadowedBy.some((template) => matchesPath(template, path))) {
    usageError("This ID selects a different API route. Use the dedicated command for that route.");
  }
  const url = new URL(path.slice(1), config.apiUrl);
  for (const [name, value] of Object.entries(request.query)) {
    for (const entry of Array.isArray(value) ? value : [value])
      url.searchParams.append(name, String(entry));
  }
  return url;
}

function conditionalRequestHeader(request: ApiRequest, headers: Headers): void {
  if (request.ifNoneMatch === undefined) return;
  const declaresValidator = request.operation.parameters.some(
    (parameter) =>
      parameter.location === "header" && parameter.name.toLowerCase() === "if-none-match"
  );
  if (!declaresValidator || !/^[\x20-\x7e]+$/.test(request.ifNoneMatch))
    usageError("This command requires a nonempty printable ASCII If-None-Match value.");
  headers.set("If-None-Match", request.ifNoneMatch);
}

function requestHeaders(config: Config, request: ApiRequest): Headers {
  const preferredTypes = [
    ...Object.values(request.operation.binaryResponses),
    ...Object.values(request.operation.specialResponses).flatMap((variant) =>
      variant.kind === "text" ? [variant.contentType] : []
    ),
  ];
  const headers = new Headers({
    Accept: [...new Set([...preferredTypes, "application/json"])].join(", "),
  });
  if (config.auth.kind === "api-key" || config.auth.kind === "session")
    headers.set("Authorization", `Bearer ${config.auth.credential}`);
  const projectId = request.path.projectId ?? config.projectId;
  const declaresProject = request.operation.parameters.some(
    (parameter) =>
      parameter.location === "header" && parameter.name.toLowerCase() === "x-project-id"
  );
  if (declaresProject && config.auth.kind === "session" && projectId === undefined) {
    usageError("This command requires --project or SDP_PROJECT_ID for a Clerk session.");
  }
  if (
    request.operation.authorization.kind !== "signup" &&
    config.auth.kind === "session" &&
    projectId !== undefined &&
    (declaresProject || request.path.projectId !== undefined)
  ) {
    headers.set("x-project-id", projectId);
  }
  if (request.body !== null) headers.set("Content-Type", "application/json");
  if (request.operation.rawBody !== null)
    headers.set("Content-Type", request.operation.rawBody.contentType);
  if (request.webhookHeaders !== undefined) {
    const allowed = request.operation.parameters
      .filter((parameter) => parameter.location === "header")
      .map((parameter) => parameter.name.toLowerCase());
    for (const [name, value] of Object.entries(request.webhookHeaders)) {
      if (!allowed.includes(name.toLowerCase()))
        usageError("Only this operation's provider signature headers are accepted.");
      if (!/^[\x20-\x7e]+$/.test(value) || value.trim().length === 0)
        usageError("Invalid webhook signature header value.");
      headers.set(name, value);
    }
  }
  if (
    request.operation.authorization.kind === "webhook" &&
    !request.operation.authorization.signatureHeaders.some((alternative) =>
      alternative.every((name) => headers.has(name))
    )
  )
    usageError(
      "Missing required provider signature headers. See command help and pass --headers @file.json."
    );
  if (request.idempotencyKey !== undefined) {
    if (
      request.operation.method === "GET" ||
      request.operation.returnsApiKeySecret ||
      request.operation.returnsPaymentLinkToken ||
      request.operation.returnsRampClientSecret ||
      request.operation.authorization.kind === "payment-link" ||
      request.operation.authorization.kind === "webhook"
    )
      usageError("This command does not accept --idempotency-key.");
    if (!/^[\x20-\x7E]{1,255}$/.test(request.idempotencyKey))
      usageError("Idempotency key must be 1–255 printable ASCII characters.");
    headers.set("Idempotency-Key", request.idempotencyKey);
  }
  conditionalRequestHeader(request, headers);
  validateHeaders(request.operation, headers);
  return headers;
}

/** Values submitted to custody setup must not be echoed by an upstream error. */
function custodyInputSecrets(request: ApiRequest): string[] {
  if (!request.operation.path.startsWith("/internal/dashboard/custody/") || request.body === null)
    return [];
  const objects = [request.body],
    fields = request.body.fields;
  if (fields !== null && typeof fields === "object" && !Array.isArray(fields)) objects.push(fields);
  return objects.flatMap((object) =>
    ["appSecret", "apiKey", "apiSecretPem"].flatMap((name) => {
      const value = object[name];
      if (typeof value !== "string" || value.length === 0) return [];
      // The API trims Fireblocks identifiers and PEM input, but not Privy secrets.
      return name !== "appSecret" && value.trim().length > 0 ? [value, value.trim()] : [value];
    })
  );
}
/** Stored Rings endpoints can carry credentials in their URL query. */
function ringsInputSecrets(request: ApiRequest): string[] {
  if (
    request.operation.path !== "/internal/dashboard/helius-rings/connections" ||
    request.body === null
  )
    return [];
  const secrets: string[] = [];
  for (const name of ["solanaRpcUrl", "indexerUrl", "proverUrl", "ringRpcUrl"]) {
    const value = request.body[name];
    if (typeof value !== "string" || value.length === 0) continue;
    secrets.push(value, value.trim());
    try {
      const endpoint = new URL(value.trim());
      secrets.push(endpoint.toString());
      for (const queryValue of endpoint.searchParams.values())
        if (queryValue.length > 0) secrets.push(queryValue);
      if (endpoint.username) secrets.push(endpoint.username, decodeURIComponent(endpoint.username));
      if (endpoint.password) secrets.push(endpoint.password, decodeURIComponent(endpoint.password));
    } catch {
      // URI-format validation and WHATWG URL parsing differ for unusual schemes;
      // the full supplied value is still redacted when component parsing fails.
    }
  }
  return secrets;
}
function redactErrorText(text: string, config: Config, request: ApiRequest): string {
  const credentials =
    request.operation.authorization.kind === "payment-link" ? Object.values(request.path) : [];
  if (config.auth.kind === "api-key" || config.auth.kind === "session")
    credentials.push(config.auth.credential);
  credentials.push(...custodyInputSecrets(request), ...ringsInputSecrets(request));
  if (request.webhookHeaders !== undefined)
    for (const value of Object.values(request.webhookHeaders)) {
      credentials.push(value, value.trim());
      // Also protect individual digests in timestamped and multi-signature headers.
      credentials.push(
        ...value
          .split(/[ ,]+/)
          .flatMap((part) => [part, part.slice(part.indexOf("=") + 1)])
          .filter((part) => part.length > 2)
      );
    }
  const representations = [
    ...new Set(
      credentials.flatMap((value) => [
        value,
        encodeURIComponent(value),
        JSON.stringify(value).slice(1, -1),
      ])
    ),
  ].sort((a, b) => b.length - a.length);
  if (representations.length === 0) return text;
  const pattern = representations
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return text.replace(new RegExp(pattern, "g"), "[REDACTED]");
}

function redactErrorDetails(value: Json, config: Config, request: ApiRequest): Json {
  if (typeof value === "string") return redactErrorText(value, config, request);
  if (Array.isArray(value)) return value.map((entry) => redactErrorDetails(entry, config, request));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        redactErrorText(key, config, request),
        redactErrorDetails(entry, config, request),
      ])
    );
  return value;
}

function responseRequestId(response: Response, config: Config, request: ApiRequest): string | null {
  const id = response.headers.get("x-request-id");
  return id === null ? null : redactErrorText(id, config, request);
}

function timeoutError(config: Config): CliError {
  return new CliError(`Request timed out after ${config.timeoutMs}ms.`, "TIMEOUT", 1);
}

async function readJson(
  response: Response,
  config: Config,
  request: ApiRequest,
  signal: AbortSignal
): Promise<Json> {
  try {
    return z.json().parse(await response.json());
  } catch {
    if (signal.aborted) throw timeoutError(config);
    throw new CliError(
      `API returned a non-JSON response (HTTP ${response.status}).`,
      "INVALID_RESPONSE",
      1,
      response.status,
      responseRequestId(response, config, request)
    );
  }
}

async function readPng(
  response: Response,
  request: ApiRequest,
  config: Config,
  signal: AbortSignal
): Promise<Uint8Array> {
  const invalid = () =>
    new CliError(
      "API returned an invalid PNG response.",
      "INVALID_RESPONSE",
      1,
      response.status,
      responseRequestId(response, config, request)
    );
  if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "image/png")
    throw invalid();
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    if (signal.aborted) throw timeoutError(config);
    throw invalid();
  }
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < signature.length || !signature.every((byte, index) => bytes[index] === byte))
    throw invalid();
  return bytes;
}

function validateResponse(
  schema: JsonObject,
  payload: Json,
  response: Response,
  config: Config,
  request: ApiRequest
): void {
  try {
    validatePayload(schema, payload, "Invalid API response");
  } catch {
    throw new CliError(
      "API response does not match the OpenAPI contract.",
      "INVALID_RESPONSE",
      1,
      response.status,
      responseRequestId(response, config, request)
    );
  }
}

async function readSpecialResponse(
  response: Response,
  request: ApiRequest,
  config: Config,
  signal: AbortSignal,
  special: Operation["specialResponses"][string]
): Promise<Json> {
  const invalid = () =>
    new CliError(
      "API response does not match the OpenAPI contract.",
      "INVALID_RESPONSE",
      1,
      response.status,
      responseRequestId(response, config, request)
    );
  switch (special.kind) {
    case "not-modified":
      return {
        status: response.status,
        notModified: true,
        etag: response.headers.get("etag"),
        cacheControl: response.headers.get("cache-control"),
      };
    case "redirect": {
      const location = response.headers.get("location");
      if (location === null) throw invalid();
      validateResponse(special.locationSchema, location, response, config, request);
      return { status: response.status, location };
    }
    case "diagnostic": {
      const payload = await readJson(response, config, request, signal);
      validateResponse(special.schema, payload, response, config, request);
      throw new CliError(
        `API request failed (HTTP ${response.status}).`,
        "HTTP_ERROR",
        1,
        response.status,
        responseRequestId(response, config, request),
        payload
      );
    }
    case "text": {
      if (
        response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
        special.contentType
      )
        throw invalid();
      let payload: string;
      try {
        payload = await response.text();
      } catch {
        if (signal.aborted) throw timeoutError(config);
        throw invalid();
      }
      validateResponse(special.schema, payload, response, config, request);
      return payload;
    }
    default: {
      const exhaustive: never = special;
      throw new Error(`Unsupported response: ${exhaustive}`);
    }
  }
}

async function readResponse(
  response: Response,
  request: ApiRequest,
  config: Config,
  signal: AbortSignal
): Promise<ApiPayload> {
  const operation = request.operation;
  const requestId = responseRequestId(response, config, request);
  const special = operation.specialResponses[String(response.status)];
  if (special !== undefined) return readSpecialResponse(response, request, config, signal, special);
  if (!response.ok) {
    const parsed = errorEnvelope.safeParse(await readJson(response, config, request, signal));
    if (!parsed.success)
      throw new CliError(
        `API request failed (HTTP ${response.status}).`,
        "HTTP_ERROR",
        1,
        response.status,
        requestId
      );
    throw new CliError(
      redactErrorText(parsed.data.error.message, config, request),
      redactErrorText(parsed.data.error.code, config, request),
      1,
      response.status,
      parsed.data.meta?.requestId === undefined
        ? requestId
        : redactErrorText(parsed.data.meta.requestId, config, request),
      parsed.data.error.details === undefined
        ? undefined
        : redactErrorDetails(parsed.data.error.details, config, request)
    );
  }
  if (operation.binaryResponses[String(response.status)] === "image/png")
    return readPng(response, request, config, signal);
  const schema = operation.responses[String(response.status)];
  if (schema === undefined)
    throw new CliError(
      `Unexpected API response status: ${response.status}.`,
      "INVALID_RESPONSE",
      1,
      response.status,
      requestId
    );
  if (schema === null) return null;
  const payload = await readJson(response, config, request, signal);
  validateResponse(schema, payload, response, config, request);
  return payload;
}

/** One request, no automatic retry: secret-returning writes cannot be replayed. */
export async function requestApi(
  config: Config,
  request: ApiRequest,
  fetcher: typeof fetch
): Promise<ApiResponse> {
  const { operation } = request;
  if (operation.sessionOnly && config.auth.kind !== "session")
    usageError(
      operation.authorization.kind === "signup"
        ? `${operation.summary} requires --token / SDP_TOKEN with a signed-in Clerk session with no active organization.`
        : `${operation.summary} requires --token / SDP_TOKEN with a Clerk session for the active organization.`
    );
  if (operation.rawBody !== null) {
    if (
      request.rawBody === undefined ||
      request.body !== null ||
      request.rawBody.byteLength === 0 ||
      request.rawBody.byteLength > operation.rawBody.maxBytes
    )
      usageError(`Webhook delivery requires 1–${operation.rawBody.maxBytes} unchanged body bytes.`);
  } else if (request.rawBody !== undefined || request.webhookHeaders !== undefined)
    usageError("This command does not accept raw webhook input.");
  if (operation.body !== null) {
    if (request.body === null) usageError("This command requires a JSON body.");
    validatePayload(operation.body, request.body, "Invalid request body");
  } else if (request.body !== null) usageError("This command does not accept a request body.");
  const url = requestUrl(config, request);
  const headers = requestHeaders(config, request);
  const signal = AbortSignal.timeout(config.timeoutMs);
  const jsonBody = request.body === null ? undefined : JSON.stringify(request.body);
  const body = request.rawBody === undefined ? jsonBody : new Uint8Array(request.rawBody);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: operation.method,
      headers,
      body,
      signal,
      redirect: Object.values(operation.specialResponses).some(
        (variant) => variant.kind === "redirect"
      )
        ? "manual"
        : "error",
    });
  } catch (cause) {
    if (
      signal.aborted ||
      (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError"))
    )
      throw timeoutError(config);
    throw new CliError(
      "Request failed. Check the API URL and network connection.",
      "NETWORK_ERROR",
      1
    );
  }
  return {
    body: await readResponse(response, request, config, signal),
    status: response.status,
    headers: Object.fromEntries(response.headers),
  };
}
