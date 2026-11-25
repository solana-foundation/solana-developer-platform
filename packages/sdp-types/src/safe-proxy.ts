// active: Safe Proxy forwards requests that match the endpoint.
// retired: the endpoint still matches; only a retired endpoint may be removed.
export const SAFE_PROXY_ENDPOINT_STATUSES = ["active", "retired"] as const;

export type SafeProxyEndpointStatus = (typeof SAFE_PROXY_ENDPOINT_STATUSES)[number];

// forwarded: the provider answered, and the status and body are the provider's.
// refused: Safe Proxy sent nothing to the provider.
// no_answer: the request may have reached the provider and no answer came back.
export const SAFE_PROXY_FORWARD_RESULTS = ["forwarded", "refused", "no_answer"] as const;

export type SafeProxyForwardResult = (typeof SAFE_PROXY_FORWARD_RESULTS)[number];
