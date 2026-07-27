// Result of running a workflow action. `retryable=false` means a permanent failure
// (capability gap, missing data) the engine must not retry.
export interface ActionExecutionResult {
  status: "succeeded" | "failed";
  retryable: boolean;
  result: Record<string, unknown>;
  error?: string;
}
