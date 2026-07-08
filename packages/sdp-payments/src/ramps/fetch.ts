import type { RampProviderId } from "@sdp/types/provider-access";
import { SdpPaymentsError, type SdpPaymentsErrorCode } from "../errors";

export interface ProviderRequestInit<TBody> {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: HeadersInit;
  body?: TBody;
}

export interface ProviderResponse {
  response: Response;
  raw: string;
  parsed: unknown;
}

export function classifyProviderStatus(status: number): SdpPaymentsErrorCode {
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
    // Coinbase/CDP shape: { errorMessage, errorType }.
    errorMessage?: unknown;
  };
  const message = record.error?.message ?? record.message ?? record.reason ?? record.errorMessage;
  return typeof message === "string" && message.trim() ? message : fallback;
}

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
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new SdpPaymentsError("PROVIDER_UNAVAILABLE", `Failed to reach the ${provider} API`, {
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
