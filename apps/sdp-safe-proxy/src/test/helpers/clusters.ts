import assert from "node:assert/strict";
import { SOLANA_CLUSTERS } from "@sdp/types/well-known-tokens";
import { SAFE_PROXY_PROVIDERS, type SafeProxyProvider } from "@/endpoints/providers";

// A cluster every provider is served on, read from the declarations so opening or closing one moves it.
const served = SOLANA_CLUSTERS.find((cluster) =>
  Object.values(SAFE_PROXY_PROVIDERS).every(({ hosts }) => hosts[cluster] !== null)
);
assert.ok(served, "no cluster serves every provider");
export const SERVED_CLUSTER = served;

export function servedHost(provider: SafeProxyProvider): string {
  const host = SAFE_PROXY_PROVIDERS[provider].hosts[SERVED_CLUSTER];
  assert.ok(host !== null, `${provider} declares no host for ${SERVED_CLUSTER}`);
  return host;
}
