import { scrubTelemetryString } from "@sdp/redaction";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { z } from "zod";
import { SdpPaymentsError, type SdpPaymentsErrorCode } from "../errors";

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

function serializeProviderBody(body: unknown): BodyInit | undefined {
  if (body === undefined) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body;
  }
  return JSON.stringify(body);
}

export function classifyProviderStatus(status: number): SdpPaymentsErrorCode {
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "PROVIDER_UNAVAILABLE";
  return "BAD_REQUEST";
}

/**
 * Whether a provider call failed with a response that proves the provider
 * received the request and refused it, so the requested action was never
 * created. Only a 4xx other than 408 and 409 carries that proof: a transport
 * failure, a client timeout, or a 408 may have landed after the provider
 * processed the request, a 409 typically means an earlier request with the
 * same key already went through, and a 5xx may have committed before failing,
 * so all of those stay ambiguous and callers must not undo a once-only claim
 * on them.
 *
 * @param error - The value thrown by a provider client call.
 * @returns True when the error carries a 4xx `providerStatus` other than 408 and 409.
 */
export function isDefinitiveProviderRejection(error: unknown): boolean {
  if (!(error instanceof SdpPaymentsError) || error.details === undefined) {
    return false;
  }
  const status = error.details.providerStatus;
  return (
    typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 409
  );
}

/**
 * Reads the message a provider put in its error body, scrubbed. Ramp providers
 * validate the counterparty fields we submit and echo them back in the
 * failure ("email jane@doe.test is already registered", "phone must be
 * E.164"), so the identifier never survives, only the wording.
 *
 * @param payload - Parsed provider error body.
 * @returns The scrubbed message, or undefined when the body carries none.
 */
function readProviderErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  // SAFETY: every field is declared unknown and type-checked before use.
  const record = payload as {
    error?: { message?: unknown };
    message?: unknown;
    reason?: unknown;
    // Coinbase/CDP shape: { errorMessage, errorType }.
    errorMessage?: unknown;
  };
  const message = record.error?.message ?? record.message ?? record.reason ?? record.errorMessage;
  return typeof message === "string" && message.trim() ? scrubTelemetryString(message) : undefined;
}

/**
 * The scrubbed message a provider put in its error body, or `fallback`.
 *
 * @param payload - Parsed provider error body.
 * @param fallback - Returned when the body carries no message.
 * @returns The scrubbed provider message or the fallback.
 */
export function extractProviderErrorMessage(payload: unknown, fallback: string): string {
  const message = readProviderErrorMessage(payload);
  return message === undefined ? fallback : message;
}

/**
 * Performs a provider HTTP request and returns the raw response plus its
 * parsed JSON body. The optional `signal` is forwarded to the underlying
 * fetch call; the fetch covers the request and, for the undici/Node runtime,
 * the response body read (a supplied signal is the only fence a hung body
 * read needs). A non-JSON body yields `parsed: undefined` rather than a parse
 * failure.
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
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...init.headers },
      body: serializeProviderBody(init.body),
      signal: init.signal,
    });
  } catch {
    throw new SdpPaymentsError("PROVIDER_UNAVAILABLE", `Failed to reach the ${provider} API`, {
      provider,
    });
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch {
    throw new SdpPaymentsError(
      "PROVIDER_UNAVAILABLE",
      `Failed to read the ${provider} API response`,
      { provider }
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
 * A non-2xx answer becomes the classified error; an unparseable body, or one
 * that does not match the schema, is PROVIDER_UNAVAILABLE. A schema requires
 * exactly the fields the adapter reads, so a mismatch names a field the
 * adapter could not have used, and its issue paths ride in diagnostics.
 *
 * @param provider - Ramp provider id, used in errors and telemetry.
 * @param url - Request URL.
 * @param init - Method, headers, body, and optional abort signal.
 * @param schema - The fields the adapter reads from the response.
 * @returns The validated response body.
 */
export async function providerFetchJson<TSchema extends z.ZodType, TBody = never>(
  provider: RampProviderId,
  url: string,
  init: ProviderRequestInit<TBody>,
  schema: TSchema
): Promise<z.output<TSchema>> {
  const { response, parsed } = await providerFetch(provider, url, init);

  if (!response.ok) {
    // The provider's own wording is for operators, never for the caller: it
    // rides in diagnostics, which are logged and not serialized.
    const providerMessage = readProviderErrorMessage(parsed);
    throw new SdpPaymentsError(
      classifyProviderStatus(response.status),
      `${provider} request failed with status ${response.status}`,
      { provider, providerStatus: response.status },
      providerMessage === undefined ? undefined : { providerMessage }
    );
  }

  if (parsed === undefined) {
    throw new SdpPaymentsError(
      "PROVIDER_UNAVAILABLE",
      `${provider} returned an unparseable response`,
      {
        provider,
      }
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new SdpPaymentsError(
      "PROVIDER_UNAVAILABLE",
      `${provider} returned an unexpected response`,
      { provider },
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          code: issue.code,
        })),
      }
    );
  }
  return result.data;
}
