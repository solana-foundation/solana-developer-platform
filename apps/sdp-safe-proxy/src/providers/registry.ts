import type { AuthScheme } from "@sdp/safe-proxy-endpoints/providers";
import { fireblocksAuthHeaders } from "./fireblocks";
import type { AuthInjection } from "./injection";
import { privyAuthHeaders } from "./privy";

export const AUTH_INJECTIONS = {
  fireblocks_jwt: fireblocksAuthHeaders,
  privy_basic: privyAuthHeaders,
} as const satisfies Record<AuthScheme, AuthInjection<never>>;
