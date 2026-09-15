import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import { cleanupRetiredProviderCredentialSecrets } from "@/services/jobs/cleanup-provider-credential-secrets";
import type { Env } from "@/types/env";

export const PROVIDER_CREDENTIAL_SECRET_CLEANUP_MONITOR =
  "sdp-api-cleanup-provider-credential-secrets";
export const PROVIDER_CREDENTIAL_SECRET_CLEANUP_CRON = "*/5 * * * *";

export interface ProviderCredentialSecretCleanupDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

export function runProviderCredentialSecretCleanup(
  deps: ProviderCredentialSecretCleanupDeps
): void {
  const work = () => cleanupRetiredProviderCredentialSecrets(deps.env);
  const promise = deps.observability
    ? deps.observability.withMonitor(PROVIDER_CREDENTIAL_SECRET_CLEANUP_MONITOR, work, {
        schedule: { type: "crontab", value: PROVIDER_CREDENTIAL_SECRET_CLEANUP_CRON },
      })
    : Promise.resolve().then(work);

  deps.bg.run(promise);
}
