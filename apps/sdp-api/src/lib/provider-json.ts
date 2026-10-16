/**
 * The API's reads of third-party JSON APIs outside the ramps, which keep their own client in
 * `@sdp/payments/ramps/fetch` for the call outcome their callers act on; this one shares its body
 * reader and issue summary. Whatever stops a provider answering usably (a network error, the
 * deadline, a body past its cap, a non-2xx status, a body that is not JSON or not the expected
 * shape) throws PROVIDER_UNAVAILABLE, so a caller answers 503 for an upstream failure and never a
 * 500. The provider's own wording and the shape's issue paths go to the log, never to the caller
 * (ADR 0008).
 */
import {
  ProviderResponseTooLargeError,
  providerErrorMessageSchema,
  providerResponseIssues,
  readProviderBody,
} from "@sdp/payments/ramps/fetch";
import type { z } from "zod";
import { providerUnavailable } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";

export interface ProviderJsonRequest {
  method: "GET" | "POST";
  headers: Record<string, string>;
  /** Sent as is; the caller sets its Content-Type. */
  body?: string;
  timeoutMs: number;
  /** The most the answer may hold; a larger one is refused before it fills memory. */
  maxBytes: number;
}

/**
 * Reads a provider's JSON answer and parses it with the caller's schema.
 *
 * @param provider - The provider's name in logs and error details, as its vendor calls name it.
 * @param url - The endpoint.
 * @param schema - The answer's expected shape.
 * @param request - Method, headers, body, deadline and byte cap.
 * @returns The answer, parsed.
 * @throws PROVIDER_UNAVAILABLE when the provider does not answer usably.
 */
export async function fetchProviderJson<Schema extends z.ZodType>(
  provider: string,
  url: URL | string,
  schema: Schema,
  { method, headers, body, timeoutMs, maxBytes }: ProviderJsonRequest
): Promise<z.output<Schema>> {
  const response = await fetch(url, {
    method,
    headers: { accept: "application/json", ...headers },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((cause: unknown) => {
    throw providerUnavailable(`${provider} did not answer`, {
      provider,
      reason: cause instanceof Error ? cause.name : "unknown",
    });
  });
  const raw = await readProviderBody(response, maxBytes).catch((cause: unknown) => {
    throw providerUnavailable(
      cause instanceof ProviderResponseTooLargeError
        ? `${provider} answered with more than ${maxBytes} bytes`
        : `${provider} answered with a body that could not be read`,
      { provider, providerStatus: response.status }
    );
  });

  if (!response.ok) {
    let errorBody: unknown;
    try {
      errorBody = JSON.parse(raw);
    } catch {
      // An error page that is not JSON carries no message to log; the status still reports it.
      errorBody = undefined;
    }
    getLogger().warn(
      {
        event: "sdp_api_provider_error",
        provider,
        provider_status: response.status,
        error_diagnostics: { providerMessage: providerErrorMessageSchema.parse(errorBody) },
      },
      "sdp_api_provider_error"
    );
    throw providerUnavailable(`${provider} answered ${response.status}`, {
      provider,
      providerStatus: response.status,
    });
  }

  let answer: unknown;
  try {
    answer = JSON.parse(raw);
  } catch {
    throw providerUnavailable(`${provider} answered with a body that is not JSON`, {
      provider,
      providerStatus: response.status,
    });
  }
  const parsed = schema.safeParse(answer);
  if (!parsed.success) {
    getLogger().warn(
      {
        event: "sdp_api_provider_response_invalid",
        provider,
        issues: providerResponseIssues(parsed.error),
      },
      "sdp_api_provider_response_invalid"
    );
    throw providerUnavailable(`${provider} answered in an unexpected shape`, {
      provider,
      providerStatus: response.status,
    });
  }
  return parsed.data;
}
