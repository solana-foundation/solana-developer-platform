import type {
  CustodyConnectionCheckStatus,
  CustodyConnectionLifecycle,
  CustodyProvider,
  ProviderCredentialStatus,
} from "@sdp/types";
import type { DatabaseExecutor } from "@/db";
import {
  createCredentialSecretStore,
  type StoredCredentialSecret,
} from "@/services/credential-secret-store";
import { insertTestCustodyWalletRow, type TestCustodyWalletRow } from "@/test/helpers/custody";
import type { Env } from "@/types/env";

const ORGANIZATION_CREDENTIAL_SCOPE_KEY = "__organization__";

export interface TestStoredProviderCredential {
  id: string;
  organizationId: string;
  /** `null` seeds an organization-scope credential shared by the org's projects. */
  projectId: string | null;
  provider: CustodyProvider;
  label: string;
  stored: StoredCredentialSecret;
  displayMetadata: Record<string, string>;
  status: ProviderCredentialStatus;
  credentialVersion: number;
  rotatedFromProviderCredentialId: string | null;
  lastValidatedAt: string | null;
  deactivatedAt: string | null;
  createdBy: string | null;
}

export interface TestCustodyConnection {
  id: string;
  organizationId: string;
  projectId: string;
  provider: CustodyProvider;
  credential: Pick<TestStoredProviderCredential, "id" | "projectId">;
  status: CustodyConnectionLifecycle;
  setupMetadata: Record<string, string>;
  providerAccountFingerprint: string | null;
  lastCheckStatus: CustodyConnectionCheckStatus | null;
  lastCheckAt: string | null;
  /** Free text in the DB, so a test can seed a code outside `CUSTODY_CONNECTION_FAILURE_CODES`. */
  lastCheckFailureCode: string | null;
  activatedAt: string | null;
  deactivatedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

interface StoredSecretColumns {
  secretRef: string | null;
  secretVersionRef: string | null;
  encryptedSecretPayload: string | null;
}

/**
 * Map a written secret onto the `provider_credentials` secret-location columns,
 * failing loudly when the backend's required column is missing.
 * @param stored - Secret location returned by a credential secret store.
 * @returns The secret-location column values.
 */
function storedSecretColumns(stored: StoredCredentialSecret): StoredSecretColumns {
  switch (stored.storageBackend) {
    case "encrypted_db": {
      if (stored.encryptedSecretPayload === undefined) {
        throw new Error("encrypted_db test credential needs an encryptedSecretPayload");
      }
      return {
        secretRef: null,
        secretVersionRef: null,
        encryptedSecretPayload: stored.encryptedSecretPayload,
      };
    }
    case "gcp_secret_manager": {
      if (stored.secretRef === undefined) {
        throw new Error("gcp_secret_manager test credential needs a secretRef");
      }
      return {
        secretRef: stored.secretRef,
        secretVersionRef: stored.secretVersionRef === undefined ? null : stored.secretVersionRef,
        encryptedSecretPayload: null,
      };
    }
    default: {
      const exhaustive: never = stored.storageBackend;
      throw new Error(`Unknown storage backend: ${String(exhaustive)}`);
    }
  }
}

/**
 * Insert a `source = 'stored'` provider credential; scope follows `projectId`.
 * @param db - Executor the insert runs on.
 * @param credential - Credential row to insert.
 * @returns Resolves once the row is written.
 */
export async function insertTestStoredProviderCredential(
  db: DatabaseExecutor,
  credential: TestStoredProviderCredential
): Promise<void> {
  const secret = storedSecretColumns(credential.stored);
  await db.execute(
    `INSERT INTO provider_credentials (
       id, organization_id, project_id, provider, label, scope, source,
       storage_backend, secret_ref, secret_version_ref, encrypted_secret_payload,
       display_metadata, status, credential_version, rotated_from_provider_credential_id,
       last_validated_at, deactivated_at, created_by
     ) VALUES (?, ?, ?, ?, ?, ?, 'stored', ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?)`,
    [
      credential.id,
      credential.organizationId,
      credential.projectId,
      credential.provider,
      credential.label,
      credential.projectId === null ? "organization" : "project",
      credential.stored.storageBackend,
      secret.secretRef,
      secret.secretVersionRef,
      secret.encryptedSecretPayload,
      JSON.stringify(credential.displayMetadata),
      credential.status,
      credential.credentialVersion,
      credential.rotatedFromProviderCredentialId,
      credential.lastValidatedAt,
      credential.deactivatedAt,
      credential.createdBy,
    ]
  );
}

/**
 * Insert a project-scope custody connection over an existing provider credential.
 * @param db - Executor the insert runs on.
 * @param connection - Connection row to insert.
 * @returns Resolves once the row is written.
 */
export async function insertTestCustodyConnection(
  db: DatabaseExecutor,
  connection: TestCustodyConnection
): Promise<void> {
  await db.execute(
    `INSERT INTO custody_connections (
       id, organization_id, project_id, provider, scope, provider_credential_id,
       provider_credential_scope_key, status, setup_metadata, provider_account_fingerprint,
       last_check_status, last_check_at, last_check_failure_code, activated_at,
       deactivated_at, created_by, created_at
     ) VALUES (?, ?, ?, ?, 'project', ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      connection.id,
      connection.organizationId,
      connection.projectId,
      connection.provider,
      connection.credential.id,
      connection.credential.projectId === null
        ? ORGANIZATION_CREDENTIAL_SCOPE_KEY
        : connection.credential.projectId,
      connection.status,
      JSON.stringify(connection.setupMetadata),
      connection.providerAccountFingerprint,
      connection.lastCheckStatus,
      connection.lastCheckAt,
      connection.lastCheckFailureCode,
      connection.activatedAt,
      connection.deactivatedAt,
      connection.createdBy,
      connection.createdAt,
    ]
  );
}

/**
 * Point a connection's default wallet at one of its own wallets, leaving its
 * lifecycle untouched; use {@link activateTestCustodyConnection} to activate.
 * @param db - Executor the update runs on.
 * @param params - Connection and wallet ids.
 * @param params.connectionId - Connection whose default changes.
 * @param params.custodyWalletId - `custody_wallets.id` owned by the connection.
 * @returns Resolves once the row is updated.
 */
export async function setTestConnectionDefaultWallet(
  db: DatabaseExecutor,
  params: { connectionId: string; custodyWalletId: string }
): Promise<void> {
  const updated = await db.execute(
    "UPDATE custody_connections SET default_custody_wallet_id = ? WHERE id = ?",
    [params.custodyWalletId, params.connectionId]
  );
  if (updated !== 1) {
    throw new Error(`Custody connection ${params.connectionId} not found`);
  }
}

/**
 * Move a connection to `active` on one of its own wallets in a single statement,
 * as `custody_connections_active_lifecycle_check` requires, stamping the check
 * and activation times with the database clock.
 * @param db - Executor the update runs on.
 * @param params - Connection, default wallet and pinned Provider account.
 * @param params.connectionId - Connection to activate.
 * @param params.custodyWalletId - `custody_wallets.id` owned by the connection.
 * @param params.providerAccountFingerprint - Provider account the connection pins.
 * @returns Resolves once the row is updated.
 */
export async function activateTestCustodyConnection(
  db: DatabaseExecutor,
  params: { connectionId: string; custodyWalletId: string; providerAccountFingerprint: string }
): Promise<void> {
  const updated = await db.execute(
    `UPDATE custody_connections
     SET status = 'active', last_check_status = 'success', last_check_at = sdp_iso_now(),
         last_check_failure_code = NULL, provider_account_fingerprint = ?,
         default_custody_wallet_id = ?, activated_at = sdp_iso_now()
     WHERE id = ?`,
    [params.providerAccountFingerprint, params.custodyWalletId, params.connectionId]
  );
  if (updated !== 1) {
    throw new Error(`Custody connection ${params.connectionId} not found`);
  }
}

export interface TestPrivyConnectionSeed {
  organizationId: string;
  projectId: string;
  connectionId: string;
  credentialId: string;
  createdBy: string;
  stored: StoredCredentialSecret;
  providerAccountFingerprint: string;
  lastCheckStatus: Extract<CustodyConnectionCheckStatus, "success" | "retry_unknown">;
  wallets: readonly Omit<TestCustodyWalletRow, "owner">[];
  defaultCustodyWalletId: string;
}

/**
 * Write a Privy app credential through the `encrypted_db` secret store, so the
 * runtime reads it back exactly as a submitted BYOK credential. Needs
 * `CUSTODY_ENCRYPTION_KEY` on `env`.
 * @param env - Test environment bindings.
 * @param params - Credential owner and secret.
 * @param params.organizationId - Organization the secret is encrypted for.
 * @param params.credentialId - Provider credential id.
 * @param params.appId - Privy app id.
 * @param params.appSecret - Privy app secret.
 * @returns The stored secret location for the credential row.
 */
export async function writeTestPrivyCredentialSecret(
  env: Env,
  params: { organizationId: string; credentialId: string; appId: string; appSecret: string }
): Promise<StoredCredentialSecret> {
  return createCredentialSecretStore(env, "encrypted_db").write({
    orgId: params.organizationId,
    provider: "privy",
    providerCredentialId: params.credentialId,
    payload: { appId: params.appId, appSecret: params.appSecret },
  });
}

/**
 * Seed a project BYOK Privy connection over an active stored credential, with its
 * wallets and default wallet. `success` leaves it `active`; `retry_unknown` leaves
 * it `pending` with that last check.
 * @param db - Executor the writes run on; pass a transaction to seed atomically.
 * @param seed - The connection, credential and wallets.
 * @returns Resolves once the connection is in its final lifecycle state.
 */
export async function seedTestPrivyConnection(
  db: DatabaseExecutor,
  seed: TestPrivyConnectionSeed
): Promise<void> {
  const isActive = seed.lastCheckStatus === "success";
  await insertTestStoredProviderCredential(db, {
    id: seed.credentialId,
    organizationId: seed.organizationId,
    projectId: seed.projectId,
    provider: "privy",
    label: "Privy",
    stored: seed.stored,
    displayMetadata: {},
    status: "active",
    credentialVersion: 1,
    rotatedFromProviderCredentialId: null,
    lastValidatedAt: null,
    deactivatedAt: null,
    createdBy: seed.createdBy,
  });
  await insertTestCustodyConnection(db, {
    id: seed.connectionId,
    organizationId: seed.organizationId,
    projectId: seed.projectId,
    provider: "privy",
    credential: { id: seed.credentialId, projectId: seed.projectId },
    status: "pending",
    setupMetadata: {},
    providerAccountFingerprint: seed.providerAccountFingerprint,
    lastCheckStatus: isActive ? null : seed.lastCheckStatus,
    lastCheckAt: isActive ? null : new Date().toISOString(),
    lastCheckFailureCode: null,
    activatedAt: null,
    deactivatedAt: null,
    createdBy: seed.createdBy,
    createdAt: new Date().toISOString(),
  });
  for (const wallet of seed.wallets) {
    await insertTestCustodyWalletRow(db, {
      ...wallet,
      owner: { kind: "connection", custodyConnectionId: seed.connectionId },
    });
  }
  if (isActive) {
    await activateTestCustodyConnection(db, {
      connectionId: seed.connectionId,
      custodyWalletId: seed.defaultCustodyWalletId,
      providerAccountFingerprint: seed.providerAccountFingerprint,
    });
  } else {
    await setTestConnectionDefaultWallet(db, {
      connectionId: seed.connectionId,
      custodyWalletId: seed.defaultCustodyWalletId,
    });
  }
}
