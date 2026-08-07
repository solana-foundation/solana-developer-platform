import { normalizePrivyWalletId } from "@sdp/custody";
import { SigningError } from "@sdp/custody/signing";
import { hashString } from "@sdp/payments/hash";
import type { Context } from "hono";
import { type DatabaseClient, getDb } from "@/db";
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
import { AuditService } from "@/services/audit.service";
import * as credentialSecretStore from "@/services/credential-secret-store";
import {
  type CredentialSecretPayload,
  type CredentialSecretStore,
  CredentialSecretStoreError,
  type StoredCredentialSecret,
} from "@/services/credential-secret-store";
import { type ProvisionPrivyResult, provisionPrivyWallet } from "@/services/custody/provisioning";
import { getProviderAvailability } from "@/services/provider-availability.service";
import {
  mapProviderCredential,
  type SafeProviderCredential,
} from "@/services/provider-credential-submission.service";
import {
  type CustodyConnectionRow,
  getPendingWalletLabel,
  type ProviderCredentialSecretRow,
  ProviderCredentialStore,
} from "@/services/stores/provider-credential.store";
import type { Env } from "@/types/env";

const INSTALL_CHECK_CONFLICT_MESSAGE = "Provider credential is not available for Install Check";
const INSTALL_CHECK_DISABLED_MESSAGE =
  "Stored credential provisioning is disabled for this provider";
const PRIVY_CHECK_TIMEOUT_MS = 10_000;

type InstallCheckStatus = "success" | "failed" | "retry_unknown";
type InstallCheckFailureStage = "credential_validation" | "wallet_provisioning";

interface InstallCheckTarget {
  credential: ProviderCredentialSecretRow;
  connection: CustodyConnectionRow;
}

interface PrivyCredential {
  appId: string;
  appSecret: string;
}

export interface ProviderCredentialCheckResult {
  providerCredential: SafeProviderCredential;
  check: {
    status: InstallCheckStatus;
    checkedAt: string;
  };
}

export async function checkProviderCredential(
  c: Context<{ Bindings: Env }>,
  providerCredentialId: string
): Promise<ProviderCredentialCheckResult> {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  if (auth.authType !== "clerk" || !auth.userId) {
    throw internalError();
  }

  const db = getDb(c.env);
  const store = new ProviderCredentialStore(db);
  const audit = new AuditService(db);
  const target = await loadInstallCheckTarget(
    store,
    auth.organizationId,
    projectId,
    providerCredentialId,
    "preflight"
  );

  const replay = completedInstallCheckResult(target);
  if (replay) {
    return replay;
  }

  await assertInstallCheckEnabled(c.env, db, auth.organizationId);

  const secretStore = createPersistedSecretStore(c.env, target.credential.storage_backend);
  const credential = await readPrivyCredential(secretStore, auth.organizationId, target.credential);
  let outcome = await validatePrivyCredential(c.env, credential);
  let failureMetadata = installCheckFailureMetadata(outcome, "credential_validation");
  let wallet: ProvisionPrivyResult | undefined;
  if (outcome === "success") {
    try {
      const provisioned = await provisionPrivyWallet(
        c.env,
        {
          externalId: `sdp_${target.connection.id}`,
          idempotencyKey: `sdp_install_${target.connection.id}`,
        },
        credential
      );
      wallet = {
        walletId: normalizePrivyWalletId(provisioned.walletId),
        address: provisioned.address,
      };
    } catch (error) {
      if (error instanceof SigningError && error.code === "CONFLICT") {
        await audit.log(c, {
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "check",
          resourceType: "provider_credential",
          resourceId: providerCredentialId,
          status: "failure",
          metadata: {
            provider: "privy",
            checkStatus: "failed",
            failureStage: "wallet_provisioning",
            failureCode: "wallet_conflict",
          },
        });
        throw conflict("Privy wallet cannot be reconciled");
      }
      outcome =
        error instanceof SigningError && error.code === "PROVIDER_CREDENTIAL_INVALID"
          ? "failed"
          : "retry_unknown";
      failureMetadata = installCheckFailureMetadata(outcome, "wallet_provisioning");
    }
  }

  const checkedAt = new Date().toISOString();
  let providerCredential: ProviderCredentialSecretRow;
  try {
    providerCredential = await persistInstallCheckOutcome({
      db,
      organizationId: auth.organizationId,
      projectId,
      providerCredentialId,
      expectedConnectionId: target.connection.id,
      checkedAt,
      outcome,
      wallet,
      providerAccountFingerprint:
        outcome === "success" ? `sha256:${await hashString(credential.appId)}` : undefined,
    });
  } catch (error) {
    const completed = await loadInstallCheckTarget(
      store,
      auth.organizationId,
      projectId,
      providerCredentialId,
      "preflight"
    ).then(completedInstallCheckResult, () => null);
    if (completed) {
      if (completed.check.status === "failed") {
        await destroyRejectedGcpVersionBestEffort(
          c,
          secretStore,
          target.credential,
          providerCredentialId
        );
      }
      return completed;
    }
    throw error;
  }

  if (outcome === "failed") {
    await destroyRejectedGcpVersionBestEffort(
      c,
      secretStore,
      target.credential,
      providerCredentialId
    );
  }

  await audit.log(c, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: "check",
    resourceType: "provider_credential",
    resourceId: providerCredentialId,
    status: outcome === "success" ? "success" : "failure",
    metadata: {
      provider: "privy",
      checkStatus: outcome,
      ...failureMetadata,
    },
  });

  return {
    providerCredential: mapProviderCredential(providerCredential),
    check: { status: outcome, checkedAt },
  };
}

function installCheckFailureMetadata(
  status: InstallCheckStatus,
  failureStage: InstallCheckFailureStage
): {
  failureStage?: InstallCheckFailureStage;
  failureCode?: "invalid_credentials" | "provider_response_unknown";
} {
  if (status === "success") return {};
  return {
    failureStage,
    failureCode: status === "failed" ? "invalid_credentials" : "provider_response_unknown",
  };
}

function completedInstallCheckResult(
  target: InstallCheckTarget
): ProviderCredentialCheckResult | null {
  const checkedAt = target.connection.last_check_at;
  if (!checkedAt) {
    return null;
  }

  if (
    target.credential.status === "active" &&
    target.connection.status === "active" &&
    target.connection.last_check_status === "success" &&
    target.connection.default_custody_wallet_id
  ) {
    return {
      providerCredential: mapProviderCredential(target.credential),
      check: { status: "success", checkedAt },
    };
  }

  if (
    target.credential.status === "failed_validation" &&
    target.connection.status === "failed" &&
    target.connection.last_check_status === "failed"
  ) {
    return {
      providerCredential: mapProviderCredential(target.credential),
      check: { status: "failed", checkedAt },
    };
  }

  return null;
}

async function loadInstallCheckTarget(
  store: ProviderCredentialStore,
  organizationId: string,
  projectId: string,
  providerCredentialId: string,
  phase: "preflight" | "completion",
  options: { lock?: boolean } = {}
): Promise<InstallCheckTarget> {
  try {
    const connections = await store.listInstallCheckConnections(
      organizationId,
      projectId,
      providerCredentialId,
      options
    );
    if (connections.length === 0) {
      throw phase === "preflight"
        ? notFound("Provider credential")
        : conflict(INSTALL_CHECK_CONFLICT_MESSAGE);
    }
    if (connections.length !== 1) {
      throw conflict(INSTALL_CHECK_CONFLICT_MESSAGE);
    }

    const credential = await store.findCredentialForInstallCheck(
      organizationId,
      providerCredentialId,
      options
    );
    const connection = connections[0] as CustodyConnectionRow;
    if (
      credential?.source !== "stored" ||
      credential.storage_backend === "runtime_env" ||
      connection.provider_credential_id !== providerCredentialId
    ) {
      throw conflict(INSTALL_CHECK_CONFLICT_MESSAGE);
    }

    const target = { credential, connection };
    if (phase === "preflight" && completedInstallCheckResult(target)) {
      return target;
    }

    if (
      credential.status !== "pending" ||
      connection.status !== "pending" ||
      connection.default_custody_wallet_id !== null
    ) {
      throw conflict(INSTALL_CHECK_CONFLICT_MESSAGE);
    }
    return target;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw internalError();
  }
}

async function assertInstallCheckEnabled(
  env: Env,
  db: DatabaseClient,
  organizationId: string
): Promise<void> {
  if (!isCustodyConnectionRuntimeEnabled(env, "privy")) {
    throw forbidden(INSTALL_CHECK_DISABLED_MESSAGE);
  }

  try {
    const availability = await getProviderAvailability(env, db, organizationId);
    if (!availability.providers.custody.privy.entitled) {
      throw forbidden(INSTALL_CHECK_DISABLED_MESSAGE);
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw internalError();
  }
}

function createPersistedSecretStore(
  env: Env,
  backend: ProviderCredentialSecretRow["storage_backend"]
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
  row: ProviderCredentialSecretRow
): Promise<PrivyCredential> {
  let payload: CredentialSecretPayload;
  try {
    payload = await store.read({
      orgId: organizationId,
      stored: toStoredCredentialSecret(row),
    });
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

function toStoredCredentialSecret(row: ProviderCredentialSecretRow): StoredCredentialSecret {
  return {
    storageBackend: row.storage_backend,
    secretRef: row.secret_ref ?? undefined,
    secretVersionRef: row.secret_version_ref ?? undefined,
    encryptedSecretPayload: row.encrypted_secret_payload ?? undefined,
  };
}

async function validatePrivyCredential(
  env: Env,
  credential: PrivyCredential
): Promise<InstallCheckStatus> {
  const baseUrl = (env.PRIVY_API_BASE_URL ?? "https://api.privy.io/v1").replace(/\/+$/, "");
  try {
    const response = await fetch(`${baseUrl}/wallets?limit=1&chain_type=solana`, {
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(`${credential.appId}:${credential.appSecret}`).toString(
          "base64"
        )}`,
        "privy-app-id": credential.appId,
      },
      signal: AbortSignal.timeout(PRIVY_CHECK_TIMEOUT_MS),
    });
    if (response.status === 401) {
      return "failed";
    }
    if (response.status !== 200) {
      return "retry_unknown";
    }

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

async function persistInstallCheckOutcome(params: {
  db: DatabaseClient;
  organizationId: string;
  projectId: string;
  providerCredentialId: string;
  expectedConnectionId: string;
  checkedAt: string;
  outcome: InstallCheckStatus;
  wallet?: ProvisionPrivyResult;
  providerAccountFingerprint?: string;
}): Promise<ProviderCredentialSecretRow> {
  try {
    return await params.db.transaction(async (tx) => {
      const store = new ProviderCredentialStore(tx);
      if (!(await store.lockProject(params.organizationId, params.projectId))) {
        throw conflict(INSTALL_CHECK_CONFLICT_MESSAGE);
      }

      const target = await loadInstallCheckTarget(
        store,
        params.organizationId,
        params.projectId,
        params.providerCredentialId,
        "completion",
        { lock: true }
      );
      if (target.connection.id !== params.expectedConnectionId) {
        throw conflict(INSTALL_CHECK_CONFLICT_MESSAGE);
      }

      if (params.outcome === "success") {
        if (!params.providerAccountFingerprint || !params.wallet) {
          throw internalError();
        }
        const updated = await store.recordInstallCheckSuccess({
          providerCredentialId: params.providerCredentialId,
          connectionId: target.connection.id,
          checkedAt: params.checkedAt,
          providerAccountFingerprint: params.providerAccountFingerprint,
          providerWalletId: params.wallet.walletId,
          publicKey: params.wallet.address,
          label: getPendingWalletLabel(target.connection.setup_metadata),
        });
        if (!updated) {
          throw conflict(INSTALL_CHECK_CONFLICT_MESSAGE);
        }
        return { ...target.credential, ...updated };
      }

      if (params.outcome === "failed") {
        const updated = await store.recordInstallCheckFailure({
          providerCredentialId: params.providerCredentialId,
          connectionId: target.connection.id,
          checkedAt: params.checkedAt,
        });
        if (!updated) {
          throw conflict(INSTALL_CHECK_CONFLICT_MESSAGE);
        }
        return {
          ...target.credential,
          ...updated,
          encrypted_secret_payload:
            target.credential.storage_backend === "encrypted_db"
              ? null
              : target.credential.encrypted_secret_payload,
        };
      }

      if (
        !(await store.recordInstallCheckRetryUnknown({
          providerCredentialId: params.providerCredentialId,
          connectionId: target.connection.id,
          checkedAt: params.checkedAt,
        }))
      ) {
        throw conflict(INSTALL_CHECK_CONFLICT_MESSAGE);
      }
      return target.credential;
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw internalError();
  }
}

async function destroyRejectedGcpVersionBestEffort(
  c: Context<{ Bindings: Env }>,
  store: CredentialSecretStore,
  credential: ProviderCredentialSecretRow,
  providerCredentialId: string
): Promise<void> {
  if (credential.storage_backend !== "gcp_secret_manager" || !credential.secret_version_ref) {
    return;
  }

  try {
    await store.destroyVersion({ secretVersionRef: credential.secret_version_ref });
  } catch {
    const version = credential.secret_version_ref.split("/").at(-1);
    getLogger().error(
      {
        providerCredentialId,
        provider: "privy",
        storageBackend: "gcp_secret_manager",
        ...(version && /^[1-9][0-9]*$/.test(version)
          ? { providerResourceVersion: Number(version) }
          : {}),
        requestId: c.get("requestId"),
        reason: "secret_cleanup_failed",
      },
      "provider_credential_orphan_risk"
    );
  }
}
