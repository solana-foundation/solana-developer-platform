export const FORWARD_HEADERS = {
  requestId: "sdp-safe-proxy-request-id",
  budgetMs: "sdp-safe-proxy-budget-ms",
  credential: "sdp-safe-proxy-credential",
  result: "sdp-safe-proxy-result",
} as const;

// forwarded: the provider answered, and the status and body are the provider's.
// refused: Safe Proxy sent nothing to the provider.
// no_answer: the request may have reached the provider and no answer came back.
export const FORWARD_RESULTS = ["forwarded", "refused", "no_answer"] as const;

export type ForwardResult = (typeof FORWARD_RESULTS)[number];

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
  credential_store_unavailable: "refused",
  deadline_exceeded: "refused",
  internal: "refused",
  provider_no_answer: "no_answer",
} as const satisfies Record<string, Exclude<ForwardResult, "forwarded">>;

export type SafeProxyCode = keyof typeof SAFE_PROXY_CODES;
