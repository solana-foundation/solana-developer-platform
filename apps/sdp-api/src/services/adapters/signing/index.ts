/** Shared custody adapter types, startup guard, and provider re-exports. */

import type { CustodyProvider } from "@sdp/custody";
import { SigningError } from "@sdp/custody/signing";
import { isSelfHostedDeployment } from "@/lib/runtime-env";
import type { Env } from "@/types/env";

/** Supported signing/custody provider types. */
export type SigningProviderType = CustodyProvider;

/** Database record for a signing/custody configuration. */
export interface SigningConfigRecord {
  id: string;
  organizationId: string;
  projectId: string | null;
  provider: SigningProviderType;
  config: string;
  encryptionVersion: string;
  defaultWalletId: string | null;
  status: "active" | "inactive";
  createdAt: string;
  updatedAt: string;
}

export function assertSigningProviderAllowed(env: Env): void {
  const provider = env.SIGNING_PROVIDER ?? "local";
  if (provider === "local" && !isSelfHostedDeployment(env)) {
    throw new SigningError(
      "Local signing is not available in a managed deployment; configure an external custody provider",
      "PROVIDER_NOT_CONFIGURED"
    );
  }
}

export {
  BaseKeychainAdapter,
  KeychainCoinbaseAdapter,
  type KeychainCoinbaseConfig,
  KeychainDfnsAdapter,
  type KeychainDfnsConfig,
  KeychainFireblocksAdapter,
  type KeychainFireblocksConfig,
  KeychainIbmHavenAdapter,
  KeychainMemoryAdapter,
  KeychainParaAdapter,
  type KeychainParaConfig,
  KeychainPrivyAdapter,
  type KeychainPrivyConfig,
  KeychainTurnkeyAdapter,
  type KeychainTurnkeyConfig,
  KeychainUtilaAdapter,
  type KeychainUtilaConfig,
} from "@sdp/custody/keychain";
