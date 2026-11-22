// active: Safe Proxy forwards requests that match the endpoint.
// retired: the endpoint still matches; only a retired endpoint may be removed.
export const SAFE_PROXY_ENDPOINT_STATUSES = ["active", "retired"] as const;

export type SafeProxyEndpointStatus = (typeof SAFE_PROXY_ENDPOINT_STATUSES)[number];

// starting: the identity keys have not been fetched yet.
// ready: Safe Proxy accepts forward requests.
export const SAFE_PROXY_READINESS_STATES = ["starting", "ready"] as const;

export type SafeProxyReadiness = (typeof SAFE_PROXY_READINESS_STATES)[number];

// not_sent -> in_flight -> answered. A request makes one provider call and never goes back.
export const SAFE_PROXY_PROVIDER_CALL_STATES = ["not_sent", "in_flight", "answered"] as const;

export type SafeProxyProviderCallState = (typeof SAFE_PROXY_PROVIDER_CALL_STATES)[number];

// forwarded: the provider answered, and the status and body are the provider's.
// refused: Safe Proxy sent nothing to the provider.
// no_answer: the request may have reached the provider and no answer came back.
export const SAFE_PROXY_FORWARD_RESULTS = ["forwarded", "refused", "no_answer"] as const;

export type SafeProxyForwardResult = (typeof SAFE_PROXY_FORWARD_RESULTS)[number];
