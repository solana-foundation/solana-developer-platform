import { cleanupRetiredProviderCredentialSecrets } from "@/services/jobs/cleanup-provider-credential-secrets";
import { alwaysEnabled, defineCron } from "./define-cron";

/** Retired provider-credential secrets. Behind no flag: retired credentials outlive any feature. */
export const providerCredentialSecretCleanupCron = defineCron({
  name: "cleanup-provider-credential-secrets",
  schedule: "*/5 * * * *",
  scope: "global",
  effect: "observes",
  enabled: alwaysEnabled,
  run: async (env) => {
    await cleanupRetiredProviderCredentialSecrets(env);
  },
});
