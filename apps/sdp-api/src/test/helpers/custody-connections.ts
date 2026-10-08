import type {
  CustodyConnectionCheckStatus,
  CustodyConnectionLifecycle,
  CustodyProvider,
  ProviderCredentialStatus,
} from "@sdp/types";
import type { DatabaseExecutor } from "@/db";
import type { StoredCredentialSecret } from "@/services/credential-secret-store";

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

export interface TestConnectionWallet {
  id: string;
  connectionId: string;
  walletId: string;
  publicKey: string;
  status: "active" | "inactive";
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
 * Insert a connection-owned custody wallet.
 * @param db - Executor the insert runs on.
 * @param wallet - Wallet row to insert.
 * @returns Resolves once the row is written.
 */
export async function insertTestConnectionWallet(
  db: DatabaseExecutor,
  wallet: TestConnectionWallet
): Promise<void> {
  await db.execute(
    `INSERT INTO custody_wallets (id, custody_connection_id, wallet_id, public_key, status)
     VALUES (?, ?, ?, ?, ?)`,
    [wallet.id, wallet.connectionId, wallet.walletId, wallet.publicKey, wallet.status]
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

/**
 * Make a connection its project's default custody target.
 * @param db - Executor the insert runs on.
 * @param selection - Scope default row to insert.
 * @param selection.id - `custody_scope_defaults.id`.
 * @param selection.organizationId - Organization owning the project.
 * @param selection.projectId - Project whose default is set.
 * @param selection.connectionId - Connection the project defaults to.
 * @returns Resolves once the row is written.
 */
export async function selectTestCustodyConnection(
  db: DatabaseExecutor,
  selection: { id: string; organizationId: string; projectId: string; connectionId: string }
): Promise<void> {
  await db.execute(
    `INSERT INTO custody_scope_defaults
       (id, organization_id, project_id, default_custody_connection_id)
     VALUES (?, ?, ?, ?)`,
    [selection.id, selection.organizationId, selection.projectId, selection.connectionId]
  );
}
