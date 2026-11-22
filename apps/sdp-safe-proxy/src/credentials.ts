import type { CredentialReference } from "@sdp/safe-proxy-endpoints/credential-reference";
import type { SafeProxyProvider } from "@sdp/safe-proxy-endpoints/providers";
import type { ProviderCredentials } from "./providers/auth-services";
import { Refusal } from "./refusal";

// An opened credential is for the one request that asked for it: a loader keeps no copy.
export type CredentialLoader = <Provider extends SafeProxyProvider>(
  provider: Provider,
  reference: CredentialReference
) => Promise<ProviderCredentials[Provider]>;

export function createPlatformCredentialLoader(platform: ProviderCredentials): CredentialLoader {
  return async (provider, reference) => {
    switch (reference.kind) {
      case "platform":
        return platform[provider];
      case "secret_manager_version":
        throw new Refusal("credential_store_unavailable");
      default: {
        const unreachable: never = reference;
        return unreachable;
      }
    }
  };
}
