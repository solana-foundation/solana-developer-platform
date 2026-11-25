import type { SafeProxyForwardResult } from "@sdp/types/safe-proxy";

// Sent by the caller and written to the request log.
export const REQUEST_ID_HEADER = "sdp-safe-proxy-request-id";

// Set on every answer: tells the provider's own answer from Safe Proxy's.
export const RESULT_HEADER = "sdp-safe-proxy-result";

// The local entry's stand-in for an identity token: the caller names itself.
export const LOCAL_CALLER_HEADER = "x-safe-proxy-local-caller";

export const SAFE_PROXY_CODES = {
  unknown_route: "refused",
  unauthenticated: "refused",
  caller_check_unavailable: "refused",
  invalid_request: "refused",
  provider_not_allowed: "refused",
  endpoint_not_allowed: "refused",
  body_not_allowed: "refused",
  caller_not_allowed: "refused",
  internal: "refused",
  provider_no_answer: "no_answer",
} as const satisfies Record<string, Exclude<SafeProxyForwardResult, "forwarded">>;

export type SafeProxyCode = keyof typeof SAFE_PROXY_CODES;
