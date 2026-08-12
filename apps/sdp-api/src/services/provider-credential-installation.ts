import type {
  CustodyConnectionStatus,
  InstallationConnectionState,
  ProviderCredentialStatus,
} from "@/services/stores/provider-credential.store";

export const INSTALLATION_COMPLETION_LEASE_MS = 60_000;

export type InstallationConflictReason =
  | "completion_in_progress"
  | "installation_completion_required"
  | "unfinished_installation_exists"
  | "provider_account_already_connected";

type ExecuteDecision<Mode extends string = never> = [Mode] extends [never]
  ? { kind: "execute" }
  : { kind: "execute"; mode: Mode };

export type InstallationDecision<Mode extends string = never> =
  | ExecuteDecision<Mode>
  | { kind: "replay" }
  | { kind: "disabled" }
  | { kind: "conflict"; reason?: InstallationConflictReason };

export interface InstallationFacts {
  connectionStatus: CustodyConnectionStatus;
  credentialStatus: ProviderCredentialStatus;
  credentialSource: "stored" | "runtime";
  isExpectedProjectCredential: boolean;
  hasDefaultWallet: boolean;
  hasOwnedWallet: boolean;
  providerAccountFingerprint: string | null;
  activatedAt: string | null;
  lastCheckStatus: string | null;
  lastCheckAt: string | null;
  lastCheckFailureCode: string | null;
  hasSiblingUnfinished: boolean;
  fullCompletionEnabled: boolean;
  nowMs: number;
}

export interface InstallationDecisions {
  consistent: boolean;
  projectedCompletionStatus: "running" | "success" | "failed" | "retry_unknown" | null;
  complete: InstallationDecision<"full" | "reconcile_only">;
  cancel: InstallationDecision;
  replace: InstallationDecision;
}

export function installationFactsFromConnection(
  connection: InstallationConnectionState,
  nowMs: number,
  fullCompletionEnabled: boolean
): InstallationFacts {
  return {
    connectionStatus: connection.status,
    credentialStatus: connection.credential_status,
    credentialSource: connection.credential_source,
    isExpectedProjectCredential:
      connection.credential_scope === "project" &&
      connection.credential_project_id === connection.project_id &&
      connection.provider_credential_scope_key === connection.project_id,
    hasDefaultWallet: connection.default_custody_wallet_id !== null,
    hasOwnedWallet: connection.has_owned_wallet,
    providerAccountFingerprint: connection.provider_account_fingerprint,
    activatedAt: connection.activated_at,
    lastCheckStatus: connection.last_check_status,
    lastCheckAt: connection.last_check_at,
    lastCheckFailureCode: connection.last_check_failure_code,
    hasSiblingUnfinished: connection.has_sibling_unfinished,
    fullCompletionEnabled,
    nowMs,
  };
}

export function decideInstallation(facts: InstallationFacts): InstallationDecisions {
  const leaseCurrent = isCompletionLeaseCurrent(facts);
  const consistent = hasConsistentLifecycle(facts);
  if (!consistent) {
    return {
      consistent: false,
      projectedCompletionStatus: null,
      complete: { kind: "conflict" },
      cancel: { kind: "conflict" },
      replace: { kind: "conflict" },
    };
  }

  return {
    consistent: true,
    projectedCompletionStatus: projectCompletionStatus(facts, leaseCurrent),
    complete: decideComplete(facts, leaseCurrent),
    cancel: decideCancel(facts, leaseCurrent),
    replace: decideReplace(facts),
  };
}

function decideComplete(
  facts: InstallationFacts,
  leaseCurrent: boolean
): InstallationDecision<"full" | "reconcile_only"> {
  if (facts.connectionStatus === "active" && facts.lastCheckStatus === "success") {
    return { kind: "replay" };
  }
  if (facts.connectionStatus === "failed" && facts.lastCheckStatus === "failed") {
    if (!isRetryableRuntimeFailure(facts) || !facts.fullCompletionEnabled) {
      return { kind: "replay" };
    }
    return facts.hasSiblingUnfinished
      ? { kind: "conflict", reason: "unfinished_installation_exists" }
      : { kind: "execute", mode: "full" };
  }
  if (facts.connectionStatus !== "pending" && facts.connectionStatus !== "checking") {
    return { kind: "conflict" };
  }
  if (leaseCurrent) {
    return { kind: "conflict", reason: "completion_in_progress" };
  }
  if (facts.fullCompletionEnabled) {
    return { kind: "execute", mode: "full" };
  }
  return facts.providerAccountFingerprint
    ? { kind: "execute", mode: "reconcile_only" }
    : { kind: "disabled" };
}

function decideCancel(facts: InstallationFacts, leaseCurrent: boolean): InstallationDecision {
  if (facts.connectionStatus === "deactivated") {
    return { kind: "replay" };
  }
  if (leaseCurrent) {
    return { kind: "conflict", reason: "completion_in_progress" };
  }
  if (
    facts.providerAccountFingerprint ||
    facts.hasOwnedWallet ||
    facts.hasDefaultWallet ||
    facts.activatedAt
  ) {
    return { kind: "conflict", reason: "installation_completion_required" };
  }
  return facts.connectionStatus === "pending" || facts.connectionStatus === "checking"
    ? { kind: "execute" }
    : { kind: "conflict" };
}

function decideReplace(facts: InstallationFacts): InstallationDecision {
  if (facts.credentialSource !== "stored") {
    return { kind: "conflict" };
  }
  if (!facts.fullCompletionEnabled) {
    return { kind: "disabled" };
  }
  if (facts.hasSiblingUnfinished) {
    return { kind: "conflict", reason: "unfinished_installation_exists" };
  }
  return facts.connectionStatus === "failed" &&
    facts.credentialStatus === "failed_validation" &&
    !facts.providerAccountFingerprint &&
    !facts.hasOwnedWallet &&
    !facts.hasDefaultWallet &&
    !facts.activatedAt
    ? { kind: "execute" }
    : { kind: "conflict" };
}

function isRetryableRuntimeFailure(facts: InstallationFacts): boolean {
  return (
    facts.credentialSource === "runtime" &&
    facts.credentialStatus === "failed_validation" &&
    (facts.lastCheckFailureCode === "invalid_credentials" ||
      facts.lastCheckFailureCode === "provider_account_already_connected") &&
    facts.providerAccountFingerprint === null &&
    !facts.hasOwnedWallet &&
    !facts.hasDefaultWallet &&
    facts.activatedAt === null
  );
}

function isCompletionLeaseCurrent(facts: InstallationFacts): boolean {
  if (
    facts.connectionStatus !== "checking" ||
    facts.lastCheckStatus !== "running" ||
    !facts.lastCheckAt
  ) {
    return false;
  }
  const startedAt = Date.parse(facts.lastCheckAt);
  return Number.isFinite(startedAt) && facts.nowMs - startedAt < INSTALLATION_COMPLETION_LEASE_MS;
}

function hasConsistentLifecycle(facts: InstallationFacts): boolean {
  if (!facts.isExpectedProjectCredential) {
    return false;
  }

  switch (facts.connectionStatus) {
    case "pending":
      return (
        facts.credentialStatus === "pending" &&
        ((facts.lastCheckStatus === null && facts.lastCheckAt === null) ||
          (facts.lastCheckStatus === "retry_unknown" && isValidTimestamp(facts.lastCheckAt))) &&
        !facts.hasDefaultWallet &&
        !facts.hasOwnedWallet &&
        facts.activatedAt === null
      );
    case "checking":
      return (
        facts.credentialStatus === "pending" &&
        facts.lastCheckStatus === "running" &&
        isValidTimestamp(facts.lastCheckAt) &&
        !facts.hasDefaultWallet &&
        !facts.hasOwnedWallet &&
        facts.activatedAt === null
      );
    case "active":
      return (
        facts.credentialStatus === "active" &&
        facts.lastCheckStatus === "success" &&
        isValidTimestamp(facts.lastCheckAt) &&
        facts.hasDefaultWallet &&
        facts.hasOwnedWallet &&
        facts.providerAccountFingerprint !== null &&
        facts.activatedAt !== null
      );
    case "failed":
      return (
        facts.credentialStatus === "failed_validation" &&
        facts.lastCheckStatus === "failed" &&
        isValidTimestamp(facts.lastCheckAt) &&
        !facts.hasDefaultWallet &&
        !facts.hasOwnedWallet &&
        facts.activatedAt === null
      );
    case "deactivated":
      return (
        facts.credentialStatus === "deactivated" &&
        !facts.hasDefaultWallet &&
        !facts.hasOwnedWallet &&
        facts.providerAccountFingerprint === null &&
        facts.activatedAt === null &&
        ((facts.lastCheckStatus === null && facts.lastCheckAt === null) ||
          (facts.lastCheckStatus === "retry_unknown" && isValidTimestamp(facts.lastCheckAt)))
      );
  }
}

function isValidTimestamp(value: string | null): value is string {
  return value !== null && Number.isFinite(Date.parse(value));
}

function projectCompletionStatus(
  facts: InstallationFacts,
  leaseCurrent: boolean
): InstallationDecisions["projectedCompletionStatus"] {
  if (facts.connectionStatus === "checking" && !leaseCurrent) {
    return "retry_unknown";
  }
  if (
    facts.lastCheckStatus === "running" ||
    facts.lastCheckStatus === "success" ||
    facts.lastCheckStatus === "failed" ||
    facts.lastCheckStatus === "retry_unknown"
  ) {
    return facts.lastCheckStatus;
  }
  return null;
}
