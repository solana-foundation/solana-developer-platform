import { scrubTelemetryString } from "@sdp/redaction";
import type { RampProviderId } from "@sdp/types/provider-access";
import { SdpPaymentsError, type SdpPaymentsErrorCode } from "../errors";

/** Applied when the caller supplies no signal of its own. */
export const PROVIDER_REQUEST_TIMEOUT_MS = 30_000;
/** Ramp provider bodies are small JSON documents; anything larger is refused. */
export const PROVIDER_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

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
 * Ramp providers validate the counterparty fields we submit and echo them back
 * in the failure ("email jane@doe.test is already registered", "phone must be
 * E.164"). That message becomes an `SdpPaymentsError` that is both logged and
 * returned, so it is scrubbed at the one place every provider's error passes
 * through — the wording stays actionable, the identifier does not survive.
 */
export function extractProviderErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const record = payload as {
    error?: { message?: unknown };
    message?: unknown;
    reason?: unknown;
    // Coinbase/CDP shape: { errorMessage, errorType }.
    errorMessage?: unknown;
  };
  const message = record.error?.message ?? record.message ?? record.reason ?? record.errorMessage;
  return typeof message === "string" && message.trim() ? scrubTelemetryString(message) : fallback;
}

class ProviderResponseTooLargeError extends Error {}

/**
 * Reads the body as text, refusing it once it passes the byte cap instead of
 * buffering whatever the provider sends.
 */
async function readProviderBody(response: Response): Promise<string> {
  if (!response.body) {
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
    if (received > PROVIDER_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ProviderResponseTooLargeError();
    }
    text += decoder.decode(value, { stream: true });
  }
}

/**
 * Performs a provider HTTP request and returns the raw response plus its
 * parsed JSON body. The signal covers the request and the body read; without
 * a caller-supplied one, the request is fenced by PROVIDER_REQUEST_TIMEOUT_MS
 * so a stalled provider cannot hold a request handler open. A body larger than
 * PROVIDER_MAX_RESPONSE_BYTES is refused. A non-JSON body yields
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
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...init.headers },
      body: serializeProviderBody(init.body),
      signal: init.signal ?? AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new SdpPaymentsError("PROVIDER_UNAVAILABLE", `Failed to reach the ${provider} API`, {
      provider,
    });
  }

  let raw: string;
  try {
    raw = await readProviderBody(response);
  } catch (error) {
    if (error instanceof ProviderResponseTooLargeError) {
      throw new SdpPaymentsError(
        "PROVIDER_UNAVAILABLE",
        `The ${provider} API response exceeded ${PROVIDER_MAX_RESPONSE_BYTES} bytes`,
        { provider }
      );
    }
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

export async function providerFetchJson<TResponse, TBody = never>(
  provider: RampProviderId,
  url: string,
  init: ProviderRequestInit<TBody>
): Promise<TResponse> {
  const { response, parsed } = await providerFetch(provider, url, init);

  if (!response.ok) {
    throw new SdpPaymentsError(
      classifyProviderStatus(response.status),
      extractProviderErrorMessage(
        parsed,
        `${provider} request failed with status ${response.status}`
      ),
      { provider, providerStatus: response.status }
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

  return parsed as TResponse;
}
