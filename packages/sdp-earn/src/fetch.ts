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
  /**
   * Abort the call — headers AND body — after this many milliseconds, surfacing
   * as `PROVIDER_UNAVAILABLE` like any other unreachable provider.
   *
   * OPT-IN, because the right bound is a property of the CALLER's deadline, not
   * of HTTP: a request inside a 120s Cloud Run job and a request inside a
   * customer's API call cannot share one number. Undici's default is 300s on
   * headers alone and unbounded on the body, which is another way of saying
   * "however long the caller had".
   *
   * Any call made from a scheduled job should set this. The job awaits its
   * steps in sequence, so an unbounded read there does not merely fail slowly —
   * it consumes the whole execution and the later steps never run at all.
   */
  timeoutMs?: number;
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

/**
 * The provider's own explanation, from whichever field it puts it in.
 *
 * `error` is read BOTH as an object carrying `message` and as a bare string,
 * because providers disagree: Ground answers a rejected write with
 * `{"error":"Invalid query params: unknown parameter(s)","code":"…"}`, and
 * reading only `error.message` there yields `undefined` — every Ground 4xx
 * degraded to the caller's fallback ("ground request failed with status 400"),
 * which names the status and explains nothing. The reason a write was refused is
 * the most useful sentence on this path; do not narrow these shapes again.
 */
export function extractProviderErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const record = payload as {
    error?: { message?: unknown } | string;
    message?: unknown;
    reason?: unknown;
  };
  const error = typeof record.error === "string" ? record.error : record.error?.message;
  // The first NON-BLANK candidate, not merely the first PRESENT one: a body
  // carrying `error: ""` beside a real `message` would otherwise select the
  // blank and degrade to the fallback, discarding the explanation it did send.
  return (
    [error, record.message, record.reason].find(
      (candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== ""
    ) ?? fallback
  );
}

export async function providerFetch<TBody = never>(
  provider: EarnProviderId,
  url: string,
  init: ProviderRequestInit<TBody>
): Promise<ProviderResponse> {
  // One signal for the whole exchange. Reading the body is covered too, and has
  // to be: a provider that answers headers promptly and then stalls mid-stream
  // would otherwise hang exactly as long as no timeout at all.
  const signal = init.timeoutMs === undefined ? undefined : AbortSignal.timeout(init.timeoutMs);

  let response: Response;
  let raw: string;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...init.headers },
      body: serializeProviderBody(init.body),
      signal,
    });
    raw = await response.text();
  } catch {
    // A timeout is a provider we could not reach in the time we had, which is
    // the same fact as a refused connection to every caller of this module.
    throw new SdpEarnError(
      "PROVIDER_UNAVAILABLE",
      signal?.aborted
        ? `Timed out reaching the ${provider} API after ${init.timeoutMs}ms`
        : `Failed to reach the ${provider} API`,
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
