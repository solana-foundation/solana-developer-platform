import type { EarnProviderId } from "@sdp/types/provider-access";
import { SdpEarnError, type SdpEarnErrorCode } from "./errors";

export interface ProviderRequestInit<TBody> {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: HeadersInit;
  body?: TBody;
  /**
   * Optional per-call normalizer that lifts fields out of an ERROR response
   * body into `SdpEarnError.details`.
   *
   * Exists because the useful half of some provider errors is structured, not
   * prose: Ground answers an over-withdrawal with `409 insufficient_funds` and
   * the lane's actual balance breakdown, and keeping only the message throws
   * away the one number the caller needs (PRO-1675).
   *
   * The hook is the seam that keeps this file provider-NEUTRAL — every wire
   * shape stays in the provider client that understands it. Return `undefined`
   * for anything unrecognized; it must never be the reason a call fails, so a
   * throw from here is swallowed and the original provider error stands.
   */
  errorDetails?: (parsed: unknown, status: number) => Record<string, unknown> | undefined;
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

export function classifyProviderStatus(status: number): SdpEarnErrorCode {
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "PROVIDER_UNAVAILABLE";
  return "BAD_REQUEST";
}

export function extractProviderErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const record = payload as {
    error?: { message?: unknown };
    message?: unknown;
    reason?: unknown;
  };
  const message = record.error?.message ?? record.message ?? record.reason;
  return typeof message === "string" && message.trim() ? message : fallback;
}

export async function providerFetch<TBody = never>(
  provider: EarnProviderId,
  url: string,
  init: ProviderRequestInit<TBody>
): Promise<ProviderResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...init.headers },
      body: serializeProviderBody(init.body),
    });
  } catch {
    throw new SdpEarnError("PROVIDER_UNAVAILABLE", `Failed to reach the ${provider} API`, {
      provider,
    });
  }

  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }

  return { response, raw, parsed };
}

export async function providerFetchJson<TResponse, TBody = never>(
  provider: EarnProviderId,
  url: string,
  init: ProviderRequestInit<TBody>
): Promise<TResponse> {
  const { response, parsed } = await providerFetch(provider, url, init);

  if (!response.ok) {
    // The normalizer is a nicety on an already-failing path: a provider client
    // that mis-reads an unfamiliar body must not turn a clean 409 into an
    // unhandled crash, so its own failure is discarded.
    let extra: Record<string, unknown> | undefined;
    try {
      extra = init.errorDetails?.(parsed, response.status);
    } catch {
      extra = undefined;
    }
    throw new SdpEarnError(
      classifyProviderStatus(response.status),
      extractProviderErrorMessage(
        parsed,
        `${provider} request failed with status ${response.status}`
      ),
      // Spread FIRST: `provider` and `providerStatus` are this layer's facts and
      // a normalizer may not overwrite them.
      { ...extra, provider, providerStatus: response.status }
    );
  }

  if (parsed === undefined) {
    throw new SdpEarnError("PROVIDER_UNAVAILABLE", `${provider} returned an unparseable response`, {
      provider,
    });
  }

  return parsed as TResponse;
}
