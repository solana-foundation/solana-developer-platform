import { scrubTelemetryString } from "@sdp/redaction/scrub";
import type { RampProviderId } from "@sdp/types/provider-access";
import { z } from "zod";
import { SdpPaymentsError, type SdpPaymentsErrorCode } from "#/errors";

export interface ProviderRequestInit<TBody> {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: HeadersInit;
  body?: TBody;
  signal?: AbortSignal;
}

export interface ProviderResponse {
  response: Response;
  raw: string;
  parsed: unknown;
}

/** How long one provider call may take, request and response body together. */
export const PROVIDER_REQUEST_TIMEOUT_MS = 30_000;

/** Ramp provider bodies are small JSON documents; a larger one is refused. */
export const PROVIDER_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** A provider body passed its byte cap; `readProviderBody` stopped reading it. */
export class ProviderResponseTooLargeError extends Error {}

/**
 * Reads a provider body as text, refusing it once it passes the byte cap, so an oversized or
 * endless answer never fills memory.
 *
 * @param response - The provider's response.
 * @param maxBytes - The most the body may hold.
 * @returns The body's text.
 * @throws ProviderResponseTooLargeError once the body passes `maxBytes`.
 */
export async function readProviderBody(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new ProviderResponseTooLargeError();
    }
    text += decoder.decode(value, { stream: true });
  }
}

function isProviderTimeout(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "TimeoutError";
}

function providerReadFailure(provider: RampProviderId, cause: unknown): string {
  if (cause instanceof ProviderResponseTooLargeError) {
    return `${provider} returned a response over ${PROVIDER_MAX_RESPONSE_BYTES} bytes`;
  }
  if (isProviderTimeout(cause)) {
    return `The ${provider} API response did not finish within ${PROVIDER_REQUEST_TIMEOUT_MS} ms`;
  }
  return `Failed to read the ${provider} API response`;
}

/** The body to send and the Content-Type it needs; fetch types a form body itself. */
function serializeProviderBody<TBody>(body: TBody | undefined): {
  body: BodyInit | undefined;
  contentType: string | undefined;
} {
  if (body === undefined) {
    return { body: undefined, contentType: undefined };
  }
  if (body instanceof URLSearchParams) {
    return { body, contentType: undefined };
  }
  return { body: JSON.stringify(body), contentType: "application/json" };
}

/**
 * What a failed provider call proves about its side effect. `rejected`: the
 * provider answered and refused, so nothing was created and only changed input
 * can succeed. `unknown`: the action may have happened (a transport failure, a
 * timeout, 408, 409, 5xx, or a success SDP could not read), so a caller
 * resolves it through a webhook or a status read and never resends blind.
 */
export type ProviderCallOutcome = "rejected" | "unknown";

/**
 * The public code and the outcome a non-2xx provider status proves. 401 and
 * 403 refuse SDP's credentials, never the caller's request. A 408 may have
 * landed after the provider acted, and a 409 typically means an earlier
 * request with the same key went through, so both stay unknown.
 *
 * @param status - HTTP status the provider answered with.
 * @returns The error code for the caller and what the status proves.
 */
export function classifyProviderFailure(status: number): {
  code: SdpPaymentsErrorCode;
  outcome: ProviderCallOutcome;
} {
  if (status === 401 || status === 403) {
    return { code: "PROVIDER_NOT_CONFIGURED", outcome: "rejected" };
  }
  if (status === 408) return { code: "PROVIDER_UNAVAILABLE", outcome: "unknown" };
  if (status === 409) return { code: "CONFLICT", outcome: "unknown" };
  if (status === 429) return { code: "RATE_LIMITED", outcome: "rejected" };
  if (status >= 400 && status < 500) return { code: "BAD_REQUEST", outcome: "rejected" };
  return { code: "PROVIDER_UNAVAILABLE", outcome: "unknown" };
}

/**
 * Whether a provider call failed with an answer that proves the provider
 * refused it, so the requested action was never created. Only the provider
 * HTTP layer records an outcome; an error without one is unknown, so callers
 * never undo a once-only claim on it.
 *
 * @param error - The value thrown by a provider client call.
 * @returns True when the error records a `rejected` outcome.
 */
export function isDefinitiveProviderRejection(error: unknown): boolean {
  return error instanceof SdpPaymentsError && error.details?.outcome === "rejected";
}

/**
 * The structure of a transport failure, for operators: its error name and the
 * system code underneath (ECONNRESET, ENOTFOUND, UND_ERR_*), never its message,
 * which can carry the request URL and MoonPay's signed `apiKey` query.
 */
function transportDiagnostics(cause: unknown): Record<string, unknown> {
  if (!(cause instanceof Error)) {
    return { transportError: typeof cause };
  }
  const inner = cause.cause;
  const code =
    typeof inner === "object" && inner !== null && "code" in inner && typeof inner.code === "string"
      ? inner.code
      : undefined;
  return code === undefined
    ? { transportError: cause.name }
    : { transportError: cause.name, transportCode: code };
}

/** One message field of a provider error body: non-blank text, else absent. */
const providerErrorText = z.string().regex(/\S/).optional().catch(undefined);

/**
 * Parses a provider error body down to its message, scrubbed: a nested
 * `error.message`, then `message`, `reason`, or `errorMessage`.
 * Ramp providers validate the counterparty fields we submit and echo them back
 * in the failure ("email jane@doe.test is already registered", "phone must be
 * E.164"), so the identifier never survives, only the wording. A body that is
 * not an object, or carries none of these as text, parses to undefined.
 */
export const providerErrorMessageSchema = z
  .object({
    error: z.object({ message: providerErrorText }).optional().catch(undefined),
    message: providerErrorText,
    reason: providerErrorText,
    errorMessage: providerErrorText,
  })
  .transform((body) => {
    const message = body.error?.message ?? body.message ?? body.reason ?? body.errorMessage;
    return message === undefined ? undefined : scrubTelemetryString(message);
  })
  .catch(undefined);

/**
 * Performs a provider HTTP request and returns the raw response plus its
 * parsed JSON body. Every call is fenced by PROVIDER_REQUEST_TIMEOUT_MS,
 * which covers the request and the body read, so a stalled provider cannot
 * hold a request open; a caller's own `signal` can only cut it shorter. A
 * body over PROVIDER_MAX_RESPONSE_BYTES is refused. A non-JSON body yields
 * `parsed: undefined` rather than a parse failure.
 *
 * @param provider - Ramp provider id, used in errors and telemetry.
 * @param url - Request URL.
 * @param init - Method, headers, body, and optional abort signal.
 * @returns The response, its raw text, and its parsed JSON body.
 */
export async function providerFetch<TBody = never>(
  provider: RampProviderId,
  url: string,
  init: ProviderRequestInit<TBody>
): Promise<ProviderResponse> {
  const signals = [AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS)];
  if (init.signal !== undefined) {
    signals.push(init.signal);
  }
  const { body, contentType } = serializeProviderBody(init.body);
  const headers = new Headers({ Accept: "application/json" });
  if (contentType !== undefined) {
    headers.set("Content-Type", contentType);
  }
  new Headers(init.headers).forEach((value, name) => {
    headers.set(name, value);
  });
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers,
      body,
      signal: AbortSignal.any(signals),
    });
  } catch (cause) {
    throw new SdpPaymentsError(
      "PROVIDER_UNAVAILABLE",
      isProviderTimeout(cause)
        ? `The ${provider} API did not answer within ${PROVIDER_REQUEST_TIMEOUT_MS} ms`
        : `Failed to reach the ${provider} API`,
      { provider, outcome: "unknown" },
      transportDiagnostics(cause)
    );
  }

  let raw: string;
  try {
    raw = await readProviderBody(response, PROVIDER_MAX_RESPONSE_BYTES);
  } catch (cause) {
    // The status line already arrived: a success may have acted, and a refusal
    // still proves what its status proves, readable body or not.
    const failure: { code: SdpPaymentsErrorCode; outcome: ProviderCallOutcome } = response.ok
      ? { code: "PROVIDER_RESPONSE_INVALID", outcome: "unknown" }
      : classifyProviderFailure(response.status);
    throw new SdpPaymentsError(
      failure.code,
      providerReadFailure(provider, cause),
      { provider, providerStatus: response.status, outcome: failure.outcome },
      transportDiagnostics(cause)
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }

  return { response, raw, parsed };
}

/**
 * Performs a provider request and validates its JSON body against `schema`.
 * A non-2xx answer becomes the classified error. A success that is not JSON,
 * or does not match the schema, is PROVIDER_RESPONSE_INVALID with an unknown
 * outcome: the provider acted, SDP just cannot read what it did. A schema
 * requires exactly the fields the adapter reads, so a mismatch names a field
 * the adapter could not have used, and its issue paths ride in diagnostics.
 *
 * @param provider - Ramp provider id, used in errors and telemetry.
 * @param url - Request URL.
 * @param init - Method, headers, body, and optional abort signal.
 * @param schema - The fields the adapter reads from the response.
 * @returns The validated response body.
 */
/**
 * Where a provider answer missed its schema, for operators: each issue's path and code, never
 * the values, which can carry the provider's data.
 *
 * @param error - The schema's parse failure.
 * @returns One path and code per issue.
 */
export function providerResponseIssues(error: z.ZodError): { path: string; code: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
  }));
}

export async function providerFetchJson<TSchema extends z.ZodType, TBody = never>(
  provider: RampProviderId,
  url: string,
  init: ProviderRequestInit<TBody>,
  schema: TSchema
): Promise<z.output<TSchema>> {
  return readProviderJson(provider, await providerFetch(provider, url, init), schema);
}

/**
 * Reads an answer `providerFetch` returned, as `providerFetchJson` does, for an
 * adapter that first checks a refusal it can read more precisely.
 *
 * @param provider - Ramp provider id, used in errors and telemetry.
 * @param answer - The provider's response and its parsed JSON body.
 * @param schema - The fields the adapter reads from the response.
 * @returns The validated response body.
 */
export function readProviderJson<TSchema extends z.ZodType>(
  provider: RampProviderId,
  { response, parsed }: Pick<ProviderResponse, "response" | "parsed">,
  schema: TSchema
): z.output<TSchema> {
  if (!response.ok) {
    // The provider's own wording is for operators, never for the caller: it
    // rides in diagnostics, which are logged and not serialized.
    const providerMessage = providerErrorMessageSchema.parse(parsed);
    const { code, outcome } = classifyProviderFailure(response.status);
    throw new SdpPaymentsError(
      code,
      `${provider} request failed with status ${response.status}`,
      { provider, providerStatus: response.status, outcome },
      providerMessage === undefined ? undefined : { providerMessage }
    );
  }

  if (parsed === undefined) {
    throw new SdpPaymentsError(
      "PROVIDER_RESPONSE_INVALID",
      `${provider} returned an unparseable response`,
      { provider, outcome: "unknown" }
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new SdpPaymentsError(
      "PROVIDER_RESPONSE_INVALID",
      `${provider} returned an unexpected response`,
      { provider, outcome: "unknown" },
      { issues: providerResponseIssues(result.error) }
    );
  }
  return result.data;
}
