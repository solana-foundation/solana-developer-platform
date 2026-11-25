import type { ProviderDeclaration } from "./endpoint";
import { FIREBLOCKS } from "./fireblocks";
import { PRIVY } from "./privy";

export const SAFE_PROXY_PROVIDERS = {
  fireblocks: FIREBLOCKS,
  privy: PRIVY,
} as const satisfies Record<string, ProviderDeclaration>;

export type SafeProxyProvider = keyof typeof SAFE_PROXY_PROVIDERS;
