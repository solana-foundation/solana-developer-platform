// active: Safe Proxy forwards requests that match the endpoint.
// retired: the endpoint still matches; only a retired endpoint may be removed.
export const SAFE_PROXY_ENDPOINT_STATUSES = ["active", "retired"] as const;

export type SafeProxyEndpointStatus = (typeof SAFE_PROXY_ENDPOINT_STATUSES)[number];
