import { normalizePrivyWalletId } from "@sdp/custody";
import { SigningError } from "@sdp/custody/signing";
import type { Context } from "hono";
import { type DatabaseClient, getDb } from "@/db";
import { isPostgresUniqueViolation, parsePostgresJsonOr } from "@/db/postgres-utils";
import { getAuth, requireProjectId } from "@/lib/auth";
import {
  AppError,
  conflict,
  forbidden,
  internalError,
  notFound,
  providerUnavailable,
} from "@/lib/errors";
import { isCustodyConnectionRuntimeEnabled } from "@/lib/feature-flags";
import { getLogger } from "@/runtime/logger";
import { type AuditIntent, AuditService } from "@/services/audit.service";
import * as credentialSecretStore from "@/services/credential-secret-store";
import {
  type CredentialSecretPayload,
  type CredentialSecretStore,
  CredentialSecretStoreError,
  type StoredCredentialSecret,
} from "@/services/credential-secret-store";
import {
  getPrivyProviderAccountFingerprint,
  PRIVY_RUNTIME_ENV_FIELDS,
} from "@/services/custody/privy-credential";
import {
  findPrivyWalletByExternalId,
  type PrivyCredentialAuthentication,
  type ProvisionPrivyResult,
  provisionPrivyWallet,
} from "@/services/custody/provisioning";
import { isPersistedCustodyCompletionEnabled } from "@/services/provider-availability.service";
import {
  decideInstallation,
  type InstallationConflictReason,
  type InstallationDecisions,
  installationFactsFromConnection,
} from "@/services/provider-credential-installation";
import type { SafeProviderCredential } from "@/services/provider-credential-submission.service";
import {
  getPendingWalletLabel,
  type InstallationConnectionState,
  ProviderCredentialStore,
} from "@/services/stores/provider-credential.store";
import type { Env } from "@/types/env";

const INSTALLATION_UNAVAILABLE_MESSAGE = "Provider credential installation is unavailable";
const PRIVY_CHECK_TIMEOUT_MS = 10_000;

type CompletionStatus = "running" | "success" | "failed" | "retry_unknown";
type CompletionFailureCode =
  | "invalid_credentials"
  | "provider_response_unknown"
  | "provider_account_already_connected"
  | "wallet_conflict";

interface SafeCompletion {
  status: CompletionStatus;
  attemptedAt: string;
  code?: CompletionFailureCode;
}

export interface SafeInstallationConnection {
  id: string;
  provider: "privy";
  label: string;
  status: InstallationConnectionState["status"];
  completion: SafeCompletion | null;
  walletLabel?: string;
  isDefault: boolean;
  canComplete: boolean;
  canReplaceCredentials: boolean;
  canCancel: boolean;
}

export interface ProviderCredentialCompletionResult {
  providerCredential: SafeProviderCredential;
  connectionId: string;
  completion: SafeCompletion;
}

interface InstallationContext {
  c: Context<{ Bindings: Env }>;
  db: DatabaseClient;
  store: ProviderCredentialStore;
  audit: AuditService;
  organizationId: string;
  projectId: string;
  userId: string;
}

interface LoadedInstallation {
  target: InstallationConnectionState;
  decisions: InstallationDecisions;
}

type ProviderOutcome =
  | { kind: "success"; wallet: ProvisionPrivyResult }
  | {
      kind: "failed";
      code: "invalid_credentials" | "provider_account_already_connected" | "wallet_conflict";
    }
  | { kind: "retry_unknown" }
  | { kind: "replay"; installation: LoadedInstallation };

export async function getProviderCredentialInstallation(
  c: Context<{ Bindings: Env }>,
  connectionId: string
): Promise<{ connection: SafeInstallationConnection }> {
  const context = createInstallationContext(c);
  const loaded = await loadInstallation(context, connectionId);
  return { connection: projectConnection(c.env, loaded) };
}

export async function completeProviderCredentialInstallation(
  c: Context<{ Bindings: Env }>,
  connectionId: string
): Promise<ProviderCredentialCompletionResult> {
  const context = createInstallationContext(c);
  const loaded = await loadInstallation(context, connectionId);
  if (loaded.decisions.complete.kind === "replay") {
    return completionResult(loaded);
  }
  if (loaded.decisions.complete.kind === "disabled") {
    throw forbidden(INSTALLATION_UNAVAILABLE_MESSAGE);
  }
  if (loaded.decisions.complete.kind === "conflict") {
    throw installationConflict(loaded.decisions.complete.reason);
  }

  const secretStore = createPersistedSecretStore(
    context.c.env,
    loaded.target.credential_storage_backend
  );
  const credential = await readPrivyCredential(secretStore, context.organizationId, loaded.target);
  if (
    loaded.target.credential_source === "runtime" &&
    loaded.target.provider_account_fingerprint &&
    (await getPrivyProviderAccountFingerprint(credential.appId)) !==
      loaded.target.provider_account_fingerprint
  ) {
    throw conflict("Custody runtime credential does not match the connected Provider account");
  }
  const auditIntent = await context.audit.beginCritical(context.c, {
    organizationId: context.organizationId,
    userId: context.userId,
    action: "check",
    resourceType: "custody_connection",
    resourceId: connectionId,
    metadata: {
      event: "provider_credential_installation_completion_started",
      provider: "privy",
      providerCredentialId: loaded.target.provider_credential_id,
    },
  });
  let canRecordFailureOutcome = true;

  try {
    const leaseToken = await acquireCompletionLease(context, loaded.target);
    if (!leaseToken) {
      canRecordFailureOutcome = false;
      await completeInstallationCriticalNoop(
        context,
        auditIntent,
        "provider_credential_installation_completion_not_admitted"
      );
      return resolveCompletionRace(context, connectionId);
    }
    const outcome = await executeCompletionMode(
      context,
      loaded.target,
      credential,
      leaseToken,
      loaded.decisions.complete.mode
    );
    if (outcome.kind === "replay") {
      canRecordFailureOutcome = false;
      await completeInstallationCriticalNoop(
        context,
        auditIntent,
        "provider_credential_installation_completion_replayed"
      );
      return completionResult(outcome.installation);
    }
    if (outcome.kind === "success" || outcome.kind === "retry_unknown") {
      canRecordFailureOutcome = false;
    }
    const replay =
      outcome.kind === "success"
        ? await persistSuccess(context, loaded.target, leaseToken, outcome.wallet)
        : outcome.kind === "retry_unknown"
          ? await persistRetryUnknown(context, loaded.target, leaseToken)
          : await persistFailure(context, loaded.target, leaseToken, outcome.code, secretStore);
    if (replay) {
      canRecordFailureOutcome = false;
      if (replay.target.last_check_at === leaseToken) {
        await completeInstallationAudit(context, auditIntent, replay);
      } else {
        await completeInstallationCriticalNoop(
          context,
          auditIntent,
          "provider_credential_installation_completion_replayed"
        );
      }
      return completionResult(replay);
    }

    const completed = await loadInstallation(context, connectionId);
    canRecordFailureOutcome = false;
    await completeInstallationAudit(context, auditIntent, completed);

    if (outcome.kind === "failed") {
      if (outcome.code === "provider_account_already_connected") {
        throw installationConflict("provider_account_already_connected");
      }
      if (outcome.code === "wallet_conflict") {
        throw conflict("Privy wallet cannot be reconciled");
      }
    }
    return completionResult(completed);
  } catch (error) {
    if (canRecordFailureOutcome) {
      await context.audit.completeCritical(context.c, auditIntent, {
        status: "failure",
        metadata: { event: "provider_credential_installation_completion_failed" },
      });
    }
    throw error;
  }
}

export async function cancelProviderCredentialInstallation(
  c: Context<{ Bindings: Env }>,
  connectionId: string
): Promise<{ connection: SafeInstallationConnection }> {
  const context = createInstallationContext(c);
  const loaded = await loadInstallation(context, connectionId);
  if (loaded.decisions.cancel.kind === "replay") {
    await destroyGcpVersionBestEffort(c, loaded.target);
    return { connection: projectConnection(c.env, loaded) };
  }
  if (loaded.decisions.cancel.kind !== "execute") {
    throw installationConflict(
      loaded.decisions.cancel.kind === "conflict" ? loaded.decisions.cancel.reason : undefined
    );
  }
  const auditIntent = await context.audit.beginCritical(c, {
    organizationId: context.organizationId,
    userId: context.userId,
    action: "deactivate",
    resourceType: "custody_connection",
    resourceId: connectionId,
    metadata: {
      provider: "privy",
      event: "provider_credential_installation_cancellation_started",
      providerCredentialId: loaded.target.provider_credential_id,
    },
  });
  let canRecordFailureOutcome = true;

  try {
    let canceled: boolean;
    try {
      canRecordFailureOutcome = false;
      canceled = await context.db.transaction(async (tx) => {
        return new ProviderCredentialStore(tx).cancelInstallation({
          connectionId,
          providerCredentialId: loaded.target.provider_credential_id,
          credentialSource: loaded.target.credential_source,
          expectedStatus: loaded.target.status as "pending" | "checking",
          expectedLastCheckStatus: loaded.target.last_check_status,
          expectedLastCheckAt: loaded.target.last_check_at,
        });
      });
      canRecordFailureOutcome = !canceled;
    } catch (transactionError) {
      let current: LoadedInstallation;
      try {
        current = await loadInstallation(context, connectionId);
      } catch {
        throw transactionError;
      }
      if (current.decisions.cancel.kind !== "replay") {
        canRecordFailureOutcome = true;
        throw transactionError;
      }

      await destroyGcpVersionBestEffort(c, current.target);
      // The row proves cancellation, but not which concurrent request committed it.
      // Keep this intent unresolved instead of emitting a duplicate domain outcome.
      return { connection: projectConnection(c.env, current) };
    }
    if (!canceled) {
      const current = await loadInstallation(context, connectionId);
      if (current.decisions.cancel.kind === "replay") {
        canRecordFailureOutcome = false;
        await completeInstallationCriticalNoop(
          context,
          auditIntent,
          "provider_credential_installation_cancellation_replayed"
        );
        await destroyGcpVersionBestEffort(c, current.target);
        return { connection: projectConnection(c.env, current) };
      }
      if (current.target.provider_account_fingerprint) {
        throw installationConflict("installation_completion_required");
      }
      if (
        current.target.status === "checking" &&
        current.decisions.cancel.kind === "conflict" &&
        current.decisions.cancel.reason === "completion_in_progress"
      ) {
        throw installationConflict("completion_in_progress");
      }
      throw conflict(INSTALLATION_UNAVAILABLE_MESSAGE);
    }

    await destroyGcpVersionBestEffort(c, loaded.target);
    const result = await loadInstallation(context, connectionId);
    canRecordFailureOutcome = false;
    await context.audit.completeCritical(c, auditIntent, {
      metadata: { event: "provider_credential_installation_canceled" },
    });
    return { connection: projectConnection(c.env, result) };
  } catch (error) {
    if (canRecordFailureOutcome) {
      await context.audit.completeCritical(c, auditIntent, {
        status: "failure",
        metadata: { event: "provider_credential_installation_cancellation_failed" },
      });
    }
    throw error;
  }
}

function createInstallationContext(c: Context<{ Bindings: Env }>): InstallationContext {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  if (auth.authType === "api_key" || !auth.userId) {
    throw internalError();
  }
  const db = getDb(c.env);
  return {
    c,
    db,
    store: new ProviderCredentialStore(db),
    audit: new AuditService(db),
    organizationId: auth.organizationId,
    projectId,
    userId: auth.userId,
  };
}

async function loadInstallation(
  context: InstallationContext,
  connectionId: string
): Promise<LoadedInstallation> {
  try {
    const [target, nowMs] = await Promise.all([
      context.store.findInstallationConnection(
        context.organizationId,
        context.projectId,
        connectionId
      ),
      context.store.getDatabaseNowMs(),
    ]);
    if (!target) {
      throw notFound("Custody Connection");
    }
    const fullCompletionEnabled = await isPersistedCustodyCompletionEnabled(
      context.c.env,
      context.db,
      context.organizationId,
      target.provider,
      target.credential_source
    );
    return {
      target,
      decisions: decideInstallation(
        installationFactsFromConnection(target, nowMs, fullCompletionEnabled)
      ),
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw internalError();
  }
}

function projectConnection(env: Env, loaded: LoadedInstallation): SafeInstallationConnection {
  const walletLabel = getPendingWalletLabel(loaded.target.setup_metadata);
  return {
    id: loaded.target.id,
    provider: loaded.target.provider,
    label: loaded.target.credential_label,
    status: loaded.target.status,
    completion: projectCompletion(loaded),
    ...(walletLabel ? { walletLabel } : {}),
    isDefault:
      isCustodyConnectionRuntimeEnabled(env, loaded.target.provider) && loaded.target.is_selected,
    canComplete: loaded.decisions.complete.kind === "execute",
    canReplaceCredentials: loaded.decisions.replace.kind === "execute",
    canCancel: loaded.decisions.cancel.kind === "execute",
  };
}

function projectCompletion(loaded: LoadedInstallation): SafeCompletion | null {
  const status = loaded.decisions.projectedCompletionStatus;
  const attemptedAt = loaded.target.last_check_at;
  if (!status || !attemptedAt) {
    return null;
  }
  const code = safeFailureCode(loaded.target.last_check_failure_code);
  return { status, attemptedAt, ...(code ? { code } : {}) };
}

function safeFailureCode(value: string | null): CompletionFailureCode | undefined {
  return value === "invalid_credentials" ||
    value === "provider_response_unknown" ||
    value === "provider_account_already_connected" ||
    value === "wallet_conflict"
    ? value
    : undefined;
}

function completionResult(loaded: LoadedInstallation): ProviderCredentialCompletionResult {
  const completion = projectCompletion(loaded);
  if (
    !completion ||
    (completion.status !== "success" &&
      completion.status !== "failed" &&
      completion.status !== "retry_unknown")
  ) {
    throw conflict(INSTALLATION_UNAVAILABLE_MESSAGE);
  }
  return {
    providerCredential: mapSafeCredential(loaded.target),
    connectionId: loaded.target.id,
    completion,
  };
}

function mapSafeCredential(target: InstallationConnectionState): SafeProviderCredential {
  const metadata = parsePostgresJsonOr<Record<string, unknown>>(
    target.credential_display_metadata,
    {}
  );
  const appIdSuffix = typeof metadata.appIdSuffix === "string" ? metadata.appIdSuffix : undefined;
  return {
    id: target.provider_credential_id,
    provider: target.provider,
    label: target.credential_label,
    scope: target.credential_scope,
    projectId: target.credential_project_id,
    status: target.credential_status,
    createdAt: target.credential_created_at,
    displayMetadata: appIdSuffix ? { appIdSuffix } : {},
  };
}

function installationConflict(reason?: InstallationConflictReason): AppError {
  return conflict(INSTALLATION_UNAVAILABLE_MESSAGE, reason ? { reason } : undefined);
}

function createPersistedSecretStore(
  env: Env,
  backend: InstallationConnectionState["credential_storage_backend"]
): CredentialSecretStore {
  try {
    return credentialSecretStore.createCredentialSecretStore(env, backend);
  } catch {
    throw internalError();
  }
}

async function readPrivyCredential(
  store: CredentialSecretStore,
  organizationId: string,
  row: InstallationConnectionState
): Promise<PrivyCredentialAuthentication> {
  let payload: CredentialSecretPayload;
  try {
    payload = await store.read({ orgId: organizationId, stored: toStoredCredentialSecret(row) });
  } catch (error) {
    if (error instanceof CredentialSecretStoreError && error.code === "UPSTREAM_ERROR") {
      throw providerUnavailable("Credential storage is temporarily unavailable");
    }
    throw internalError();
  }

  const appId = typeof payload.appId === "string" ? payload.appId.trim() : "";
  const appSecret = typeof payload.appSecret === "string" ? payload.appSecret : "";
  if (!appId || !appSecret) {
    throw internalError();
  }
  return { appId, appSecret };
}

function toStoredCredentialSecret(row: InstallationConnectionState): StoredCredentialSecret {
  return {
    storageBackend: row.credential_storage_backend,
    secretRef: row.credential_secret_ref ?? undefined,
    secretVersionRef: row.credential_secret_version_ref ?? undefined,
    encryptedSecretPayload: row.credential_encrypted_secret_payload ?? undefined,
    ...(row.credential_storage_backend === "runtime_env"
      ? { runtimeEnvFields: PRIVY_RUNTIME_ENV_FIELDS }
      : {}),
  };
}

async function executeCompletionMode(
  context: InstallationContext,
  target: InstallationConnectionState,
  credential: PrivyCredentialAuthentication,
  leaseToken: string,
  mode: "full" | "reconcile_only"
): Promise<ProviderOutcome> {
  const externalId = `sdp_${target.id}`;
  const fingerprint = await getPrivyProviderAccountFingerprint(credential.appId);
  if (target.provider_account_fingerprint && target.provider_account_fingerprint !== fingerprint) {
    return { kind: "failed", code: "wallet_conflict" };
  }
  if (mode === "reconcile_only") {
    return lookupProviderWallet(context.c.env, externalId, credential);
  }

  const validation = await validatePrivyCredential(context.c.env, credential);
  if (validation !== "success") {
    return validation === "failed"
      ? { kind: "failed", code: "invalid_credentials" }
      : { kind: "retry_unknown" };
  }

  if (!target.provider_account_fingerprint) {
    try {
      const reserved = await context.store.reserveProviderAccountFingerprint({
        connectionId: target.id,
        providerCredentialId: target.provider_credential_id,
        leaseToken,
        fingerprint,
      });
      if (!reserved) {
        const current = await loadInstallation(context, target.id);
        if (current.decisions.complete.kind === "replay") {
          return { kind: "replay", installation: current };
        }
        throw conflict(INSTALLATION_UNAVAILABLE_MESSAGE);
      }
    } catch (error) {
      if (!isPostgresUniqueViolation(error)) {
        throw error;
      }
      return { kind: "failed", code: "provider_account_already_connected" };
    }
  }

  try {
    const wallet = await provisionPrivyWallet(
      context.c.env,
      { externalId, idempotencyKey: `sdp_install_${target.id}` },
      credential
    );
    return {
      kind: "success",
      wallet: { walletId: normalizePrivyWalletId(wallet.walletId), address: wallet.address },
    };
  } catch (error) {
    return providerErrorOutcome(error);
  }
}

async function lookupProviderWallet(
  env: Env,
  externalId: string,
  credential: PrivyCredentialAuthentication
): Promise<ProviderOutcome> {
  try {
    const wallet = await findPrivyWalletByExternalId(env, externalId, credential);
    return wallet
      ? {
          kind: "success",
          wallet: { walletId: normalizePrivyWalletId(wallet.walletId), address: wallet.address },
        }
      : { kind: "retry_unknown" };
  } catch (error) {
    return providerErrorOutcome(error);
  }
}

function providerErrorOutcome(error: unknown): ProviderOutcome {
  if (error instanceof SigningError && error.code === "PROVIDER_CREDENTIAL_INVALID") {
    return { kind: "failed", code: "invalid_credentials" };
  }
  if (error instanceof SigningError && error.code === "CONFLICT") {
    return { kind: "failed", code: "wallet_conflict" };
  }
  return { kind: "retry_unknown" };
}

async function acquireCompletionLease(
  context: InstallationContext,
  target: InstallationConnectionState
): Promise<string | null> {
  if (target.status === "failed") {
    const failureCode = target.last_check_failure_code;
    const expectedLastCheckAt = target.last_check_at;
    if (
      target.credential_source !== "runtime" ||
      !expectedLastCheckAt ||
      (failureCode !== "invalid_credentials" &&
        failureCode !== "provider_account_already_connected")
    ) {
      return null;
    }
    return context.db.transaction(async (tx) => {
      const store = new ProviderCredentialStore(tx);
      if (!(await store.lockProject(context.organizationId, context.projectId))) {
        return null;
      }
      return store.acquireRuntimeFailureRetryLease({
        connectionId: target.id,
        providerCredentialId: target.provider_credential_id,
        expectedLastCheckAt,
        expectedFailureCode: failureCode,
      });
    });
  }

  return context.store.acquireInstallationLease({
    connectionId: target.id,
    providerCredentialId: target.provider_credential_id,
    credentialSource: target.credential_source,
    expectedStatus: target.status as "pending" | "checking",
    expectedLastCheckStatus: target.last_check_status,
    expectedLastCheckAt: target.last_check_at,
  });
}

async function validatePrivyCredential(
  env: Env,
  credential: PrivyCredentialAuthentication
): Promise<"success" | "failed" | "retry_unknown"> {
  const baseUrl = (env.PRIVY_API_BASE_URL ?? "https://api.privy.io/v1").replace(/\/+$/, "");
  try {
    const response = await fetch(`${baseUrl}/wallets?limit=1&chain_type=solana`, {
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(`${credential.appId}:${credential.appSecret}`).toString("base64")}`,
        "privy-app-id": credential.appId,
      },
      signal: AbortSignal.timeout(PRIVY_CHECK_TIMEOUT_MS),
    });
    if (response.status === 401) return "failed";
    if (response.status !== 200) return "retry_unknown";
    const body = await response.json().catch(() => null);
    return isWalletListResponse(body) ? "success" : "retry_unknown";
  } catch {
    return "retry_unknown";
  }
}

function isWalletListResponse(value: unknown): value is { data: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    Array.isArray((value as { data?: unknown }).data)
  );
}

async function persistSuccess(
  context: InstallationContext,
  target: InstallationConnectionState,
  leaseToken: string,
  wallet: ProvisionPrivyResult
): Promise<LoadedInstallation | null> {
  try {
    await context.db.transaction(async (tx) => {
      const store = new ProviderCredentialStore(tx);
      if (!(await store.lockProject(context.organizationId, context.projectId))) {
        throw new Error("Project disappeared during installation success persistence");
      }
      const updated = await store.recordInstallationSuccess({
        providerCredentialId: target.provider_credential_id,
        connectionId: target.id,
        leaseToken,
        providerWalletId: wallet.walletId,
        publicKey: wallet.address,
        label: getPendingWalletLabel(target.setup_metadata),
      });
      if (!updated) throw new Error("Installation Credential changed during success persistence");
    });
    return null;
  } catch {
    const current = await loadInstallation(context, target.id);
    if (current.decisions.complete.kind === "replay") return current;
    throw conflict(INSTALLATION_UNAVAILABLE_MESSAGE);
  }
}

async function persistRetryUnknown(
  context: InstallationContext,
  target: InstallationConnectionState,
  leaseToken: string
): Promise<LoadedInstallation | null> {
  if (
    await context.store.recordInstallationRetryUnknown({
      providerCredentialId: target.provider_credential_id,
      connectionId: target.id,
      leaseToken,
    })
  ) {
    return null;
  }
  const current = await loadInstallation(context, target.id);
  if (current.decisions.complete.kind === "replay") return current;
  throw conflict(INSTALLATION_UNAVAILABLE_MESSAGE);
}

async function persistFailure(
  context: InstallationContext,
  target: InstallationConnectionState,
  leaseToken: string,
  failureCode: "invalid_credentials" | "provider_account_already_connected" | "wallet_conflict",
  secretStore: CredentialSecretStore
): Promise<LoadedInstallation | null> {
  const updated = await context.db.transaction(async (tx) =>
    new ProviderCredentialStore(tx).recordInstallationFailure({
      providerCredentialId: target.provider_credential_id,
      connectionId: target.id,
      leaseToken,
      failureCode,
    })
  );
  if (!updated) {
    const current = await loadInstallation(context, target.id);
    if (current.decisions.complete.kind === "replay") return current;
    throw conflict(INSTALLATION_UNAVAILABLE_MESSAGE);
  }
  await destroyRejectedGcpVersionBestEffort(context.c, secretStore, target);
  return null;
}

async function resolveCompletionRace(
  context: InstallationContext,
  connectionId: string
): Promise<ProviderCredentialCompletionResult> {
  const current = await loadInstallation(context, connectionId);
  if (current.decisions.complete.kind === "replay") {
    return completionResult(current);
  }
  if (current.decisions.complete.kind === "conflict") {
    throw installationConflict(current.decisions.complete.reason);
  }
  if (current.decisions.complete.kind === "disabled") {
    throw forbidden(INSTALLATION_UNAVAILABLE_MESSAGE);
  }
  throw conflict(INSTALLATION_UNAVAILABLE_MESSAGE);
}

async function completeInstallationAudit(
  context: InstallationContext,
  intent: AuditIntent,
  loaded: LoadedInstallation
): Promise<void> {
  const completion = projectCompletion(loaded);
  await context.audit.completeCritical(context.c, intent, {
    status: completion?.status === "success" ? "success" : "failure",
    metadata: {
      event: "provider_credential_installation_completed",
      completionStatus: completion?.status,
      ...(completion?.code ? { failureCode: completion.code } : {}),
    },
  });
}

async function completeInstallationCriticalNoop(
  context: InstallationContext,
  intent: AuditIntent,
  event: string
): Promise<void> {
  await context.audit.completeCritical(context.c, intent, {
    action: "maintenance",
    resourceType: "audit_ledger",
    resourceId: intent.id,
    metadata: { event },
  });
}

async function destroyGcpVersionBestEffort(
  c: Context<{ Bindings: Env }>,
  credential: InstallationConnectionState
): Promise<void> {
  if (
    credential.credential_storage_backend !== "gcp_secret_manager" ||
    !credential.credential_secret_version_ref
  ) {
    return;
  }
  let store: CredentialSecretStore;
  try {
    store = createPersistedSecretStore(c.env, credential.credential_storage_backend);
  } catch {
    logSecretCleanupFailure(c, credential);
    return;
  }
  await destroyRejectedGcpVersionBestEffort(c, store, credential);
}

async function destroyRejectedGcpVersionBestEffort(
  c: Context<{ Bindings: Env }>,
  store: CredentialSecretStore,
  credential: InstallationConnectionState
): Promise<void> {
  if (
    credential.credential_storage_backend !== "gcp_secret_manager" ||
    !credential.credential_secret_version_ref
  ) {
    return;
  }
  try {
    await store.destroyVersion({ secretVersionRef: credential.credential_secret_version_ref });
  } catch {
    logSecretCleanupFailure(c, credential);
  }
}

function logSecretCleanupFailure(
  c: Context<{ Bindings: Env }>,
  credential: InstallationConnectionState
): void {
  const version = credential.credential_secret_version_ref?.split("/").at(-1);
  getLogger().error(
    {
      providerCredentialId: credential.provider_credential_id,
      provider: "privy",
      storageBackend: credential.credential_storage_backend,
      ...(version && /^[1-9][0-9]*$/.test(version)
        ? { providerResourceVersion: Number(version) }
        : {}),
      requestId: c.get("requestId"),
      reason: "secret_cleanup_failed",
    },
    "provider_credential_orphan_risk"
  );
}
