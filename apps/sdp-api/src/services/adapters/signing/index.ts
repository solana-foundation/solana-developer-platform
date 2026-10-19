/** Shared custody adapter types, startup guard, and provider re-exports. */

import { SigningError } from "@sdp/custody/signing";
import type { CustodyConfigStatus, CustodyProvider } from "@sdp/types/custody";
import { isSelfHostedDeployment } from "@/lib/runtime-env";
import type { Env } from "@/types/env";

/** Supported signing/custody provider types. */
export type SigningProviderType = CustodyProvider;

/** Database record for a signing/custody configuration. */
export interface SigningConfigRecord {
  id: string;
  organizationId: string;
  projectId: string;
  provider: SigningProviderType;
  config: string;
  encryptionVersion: string;
  status: CustodyConfigStatus;
  createdAt: string;
  updatedAt: string;
}

export function assertSigningProviderAllowed(env: Env): void {
  if ((env.SIGNING_PROVIDER ?? "local") === "local") {
    assertLocalSigningAllowed(env);
  }
}

/** Platform-held signing keys exist only in self-hosted deployments. */
export function assertLocalSigningAllowed(env: Pick<Env, "SDP_DEPLOYMENT_MODE">): void {
  if (!isSelfHostedDeployment(env)) {
    throw new SigningError(
      "Local signing is not available in a managed deployment; configure an external custody provider",
      "PROVIDER_NOT_CONFIGURED"
    );
  }
}
