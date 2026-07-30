import type { StoredCredentialSecret } from "@/services/credential-secret-store";

// Result of running a workflow action. `retryable=false` means a permanent failure
// (capability gap, missing data) the engine must not retry.
export interface ActionExecutionResult {
  status: "succeeded" | "failed";
  retryable: boolean;
  result: Record<string, unknown>;
  error?: string;
}

// Execution-time context threaded into each action handler. `params` is the rule's
// static `definition.action.params` (amount, destination, target wallet, webhook url,
// notify audience, …), loaded by the cron engine from the asset_workflows row.
export interface ActionContext {
  params: Record<string, string | number>;
  // Reference to the rule's credential param (the outbound webhook HMAC key), resolved
  // from the credential secret store at send time. Never the value itself — it must not
  // sit in a plaintext column or in a list response.
  actionSecret?: StoredCredentialSecret | null;
}
