import type { SafeProxyProvider } from "@sdp/safe-proxy-endpoints/providers";
import type { AuthService } from "./auth-service";
import { FireblocksAuthService, type FireblocksCredential } from "./fireblocks";
import { PrivyAuthService, type PrivyCredential } from "./privy";

export interface ProviderCredentials {
  fireblocks: FireblocksCredential;
  privy: PrivyCredential;
}

export const AUTH_SERVICES: {
  [Provider in SafeProxyProvider]: AuthService<ProviderCredentials[Provider]>;
} = {
  fireblocks: new FireblocksAuthService(),
  privy: new PrivyAuthService(),
};
