import type {
  CustodyConnectionCheckStatus,
  CustodyConnectionLifecycle,
  ProviderCredentialStatus,
} from "@sdp/types/custody";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { insertTestCustodyConfigRow, insertTestCustodyWalletRow } from "@/test/helpers/custody";
import {
  insertTestCustodyConnection,
  insertTestStoredProviderCredential,
} from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const ORGANIZATION_ID = "org_custody_connection_constraints";
const PROJECT_ID = "prj_custody_connection_constraints";
const OTHER_PROJECT_ID = "prj_custody_connection_constraints_other";
const USER_ID = "usr_custody_connection_constraints";
const CONFIG_ID = "cust_custody_connection_constraints";
const CHECKED_AT = "2026-08-06T12:00:00.000Z";

interface ConnectionStateRow {
  id: string;
  status: CustodyConnectionLifecycle;
  last_check_status: CustodyConnectionCheckStatus | null;
}

async function seedScope(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, 'Custody connection constraints', ?, 'individual', 'active')`
      )
      .bind(ORGANIZATION_ID, "custody-connection-constraints"),
    db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, 'custody-connection-constraints@example.com', 1, 'active')`
      )
      .bind(USER_ID),
  ]);
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [],
    ids: { sandbox: PROJECT_ID, production: OTHER_PROJECT_ID },
  });
  await insertTestCustodyConfigRow(db, {
    id: CONFIG_ID,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    provider: "privy",
    configEncrypted: "test-config",
    status: "active",
  });
}

async function insertCredential(
  id: string,
  status: ProviderCredentialStatus,
  projectId: string
): Promise<void> {
  await insertTestStoredProviderCredential(getDb(env), {
    id,
    organizationId: ORGANIZATION_ID,
    projectId,
    provider: "privy",
    label: "Privy",
    stored: { storageBackend: "encrypted_db", encryptedSecretPayload: "secret" },
    displayMetadata: {},
    status,
    credentialVersion: 1,
    rotatedFromProviderCredentialId: null,
    lastValidatedAt: null,
    deactivatedAt: status === "deactivated" ? CHECKED_AT : null,
    createdBy: USER_ID,
  });
}

async function insertCredentialWithoutCiphertext(
  id: string,
  status: ProviderCredentialStatus
): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO provider_credentials (
         id, organization_id, project_id, provider, label, scope, source,
         storage_backend, encrypted_secret_payload, status, deactivated_at, created_by
       ) VALUES (?, ?, ?, 'privy', 'Privy', 'project', 'stored',
                 'encrypted_db', NULL, ?, ?, ?)`
    )
    .bind(
      id,
      ORGANIZATION_ID,
      PROJECT_ID,
      status,
      status === "deactivated" ? CHECKED_AT : null,
      USER_ID
    )
    .run();
}

function lastCheckStatusOf(
  lifecycle: CustodyConnectionLifecycle
): CustodyConnectionCheckStatus | null {
  switch (lifecycle) {
    case "pending":
    case "deactivated":
      return null;
    case "checking":
      return "running";
    case "active":
      return "success";
    case "failed":
      return "failed";
    default: {
      const exhaustive: never = lifecycle;
      throw new Error(`Unknown connection lifecycle: ${String(exhaustive)}`);
    }
  }
}

async function insertConnection(
  id: string,
  credential: { id: string; projectId: string },
  options: {
    projectId: string;
    status: CustodyConnectionLifecycle;
    providerAccountFingerprint: string | null;
  }
): Promise<void> {
  const lastCheckStatus = lastCheckStatusOf(options.status);
  await insertTestCustodyConnection(getDb(env), {
    id,
    organizationId: ORGANIZATION_ID,
    projectId: options.projectId,
    provider: "privy",
    credential,
    status: options.status,
    setupMetadata: {},
    providerAccountFingerprint: options.providerAccountFingerprint,
    lastCheckStatus,
    lastCheckAt: lastCheckStatus === null ? null : CHECKED_AT,
    lastCheckFailureCode: null,
    activatedAt: options.status === "active" ? CHECKED_AT : null,
    deactivatedAt: options.status === "deactivated" ? CHECKED_AT : null,
    createdBy: USER_ID,
    createdAt: CHECKED_AT,
  });
}

async function insertProjectConnection(
  id: string,
  credentialId: string,
  status: CustodyConnectionLifecycle
): Promise<void> {
  await insertConnection(
    id,
    { id: credentialId, projectId: PROJECT_ID },
    { projectId: PROJECT_ID, status, providerAccountFingerprint: null }
  );
}

async function insertConnectionWallet(id: string, connectionId: string): Promise<void> {
  await insertTestCustodyWalletRow(getDb(env), {
    id,
    owner: { kind: "connection", custodyConnectionId: connectionId },
    walletId: `provider_${id}`,
    publicKey: `public_${id}`,
    label: null,
    purpose: null,
    status: "active",
  });
}

async function activateConnection(id: string, walletId: string): Promise<void> {
  await insertConnectionWallet(walletId, id);
  await getDb(env)
    .prepare(
      `UPDATE custody_connections
       SET status = 'active',
           last_check_status = 'success',
           last_check_at = ?,
           activated_at = ?
       WHERE id = ?`
    )
    .bind(CHECKED_AT, CHECKED_AT, id)
    .run();
}

async function connectionStates(): Promise<ConnectionStateRow[]> {
  return getDb(env).queryMany<ConnectionStateRow>(
    `SELECT id, status, last_check_status FROM custody_connections
     WHERE organization_id = ? ORDER BY id`,
    [ORGANIZATION_ID]
  );
}

describe("custody Connection constraints", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedScope();
  });

  it("requires every wallet to have exactly one Config or Connection owner", async () => {
    await insertCredential("pcred_wallet_owner", "pending", PROJECT_ID);
    await insertProjectConnection("cconn_wallet_owner", "pcred_wallet_owner", "pending");
    await insertConnectionWallet("cwlt_connection_owner", "cconn_wallet_owner");
    await insertTestCustodyWalletRow(getDb(env), {
      id: "cwlt_config_owner",
      owner: { kind: "config", custodyConfigId: CONFIG_ID },
      walletId: "provider_config_owner",
      publicKey: "public_config_owner",
      label: null,
      purpose: null,
      status: "active",
    });

    await expect(
      getDb(env)
        .prepare(
          `INSERT INTO custody_wallets (
             id, custody_config_id, custody_connection_id, wallet_id, public_key
           ) VALUES (
             'cwlt_two_owners', ?, 'cconn_wallet_owner', 'provider_two_owners', 'public_two_owners'
           )`
        )
        .bind(CONFIG_ID)
        .run()
    ).rejects.toThrow(/custody_wallets_exactly_one_owner/);

    await expect(
      getDb(env)
        .prepare(
          `INSERT INTO custody_wallets (id, wallet_id, public_key)
           VALUES ('cwlt_no_owner', 'provider_no_owner', 'public_no_owner')`
        )
        .run()
    ).rejects.toThrow(/custody_wallets_exactly_one_owner/);
  });

  it("refuses to delete a Connection that still owns wallets", async () => {
    await insertCredential("pcred_wallet_holder", "active", PROJECT_ID);
    await insertProjectConnection("cconn_wallet_holder", "pcred_wallet_holder", "failed");
    await activateConnection("cconn_wallet_holder", "cwlt_wallet_holder");

    await expect(
      getDb(env).prepare("DELETE FROM custody_connections WHERE id = 'cconn_wallet_holder'").run()
    ).rejects.toThrow(/custody_wallets_connection_fkey/);
    expect(
      await getDb(env)
        .prepare("SELECT id, custody_connection_id FROM custody_wallets WHERE id = ?")
        .bind("cwlt_wallet_holder")
        .first()
    ).toEqual({ id: "cwlt_wallet_holder", custody_connection_id: "cconn_wallet_holder" });
  });

  it("rejects a project connection bound to another project's credential", async () => {
    await insertCredential("pcred_other_project", "pending", OTHER_PROJECT_ID);

    await expect(
      insertConnection(
        "cconn_other_project_credential",
        { id: "pcred_other_project", projectId: OTHER_PROJECT_ID },
        { projectId: PROJECT_ID, status: "pending", providerAccountFingerprint: null }
      )
    ).rejects.toThrow(/custody_connections_credential_scope_check/);
    expect(await connectionStates()).toEqual([]);
  });

  it("allows failed and deactivated encrypted credentials without ciphertext", async () => {
    await insertCredentialWithoutCiphertext("pcred_failed_without_secret", "failed_validation");
    await insertCredentialWithoutCiphertext("pcred_deactivated_without_secret", "deactivated");

    await expect(
      insertCredentialWithoutCiphertext("pcred_pending_without_secret", "pending")
    ).rejects.toThrow(/provider_credentials_secret_location_check/);
    await expect(
      insertCredentialWithoutCiphertext("pcred_active_without_secret", "active")
    ).rejects.toThrow(/provider_credentials_secret_location_check/);
  });

  it("allows only one unfinished Privy installation per Project", async () => {
    await insertCredential("pcred_unfinished_one", "pending", PROJECT_ID);
    await insertCredential("pcred_unfinished_two", "pending", PROJECT_ID);
    await insertCredential("pcred_active_sibling", "active", PROJECT_ID);
    await insertProjectConnection("cconn_unfinished_one", "pcred_unfinished_one", "pending");

    await expect(
      insertProjectConnection("cconn_unfinished_two", "pcred_unfinished_two", "checking")
    ).rejects.toThrow(/idx_custody_connections_privy_unfinished/);

    await getDb(env)
      .prepare(
        `UPDATE custody_connections
         SET status = 'failed',
             last_check_status = 'failed',
             last_check_at = ?
         WHERE id = 'cconn_unfinished_one'`
      )
      .bind(CHECKED_AT)
      .run();

    await insertProjectConnection("cconn_unfinished_two", "pcred_unfinished_two", "checking");
    await insertProjectConnection("cconn_active_sibling", "pcred_active_sibling", "failed");
    await activateConnection("cconn_active_sibling", "cwlt_active_sibling");

    expect(await connectionStates()).toEqual([
      { id: "cconn_active_sibling", status: "active", last_check_status: "success" },
      { id: "cconn_unfinished_one", status: "failed", last_check_status: "failed" },
      { id: "cconn_unfinished_two", status: "checking", last_check_status: "running" },
    ]);
  });

  it("enforces local installation lifecycle combinations", async () => {
    await insertCredential("pcred_lifecycle", "active", PROJECT_ID);
    await insertProjectConnection("cconn_lifecycle", "pcred_lifecycle", "pending");

    await expect(
      getDb(env)
        .prepare(
          `UPDATE custody_connections
           SET status = 'checking', last_check_status = NULL, last_check_at = ?
           WHERE id = 'cconn_lifecycle'`
        )
        .bind(CHECKED_AT)
        .run()
    ).rejects.toThrow(/custody_connections_checking_lifecycle_check/);

    await expect(
      getDb(env)
        .prepare(
          `UPDATE custody_connections
           SET status = 'failed', last_check_status = NULL, last_check_at = ?
           WHERE id = 'cconn_lifecycle'`
        )
        .bind(CHECKED_AT)
        .run()
    ).rejects.toThrow(/custody_connections_failed_lifecycle_check/);

    await getDb(env)
      .prepare(
        `UPDATE custody_connections
         SET status = 'failed', last_check_status = 'failed', last_check_at = ?
         WHERE id = 'cconn_lifecycle'`
      )
      .bind(CHECKED_AT)
      .run();

    await expect(
      getDb(env)
        .prepare(
          `UPDATE custody_connections
           SET status = 'active', last_check_status = NULL, last_check_at = ?,
               activated_at = ?
           WHERE id = 'cconn_lifecycle'`
        )
        .bind(CHECKED_AT, CHECKED_AT)
        .run()
    ).rejects.toThrow(/custody_connections_active_lifecycle_check/);

    await expect(
      getDb(env)
        .prepare(
          `UPDATE custody_connections
           SET status = 'active', last_check_status = 'success', last_check_at = NULL,
               activated_at = ?
           WHERE id = 'cconn_lifecycle'`
        )
        .bind(CHECKED_AT)
        .run()
    ).rejects.toThrow(/custody_connections_active_lifecycle_check/);

    await getDb(env)
      .prepare(
        `UPDATE custody_connections
         SET status = 'active', last_check_status = 'success', last_check_at = ?,
             activated_at = ?
         WHERE id = 'cconn_lifecycle'`
      )
      .bind(CHECKED_AT, CHECKED_AT)
      .run();

    expect(await connectionStates()).toEqual([
      { id: "cconn_lifecycle", status: "active", last_check_status: "success" },
    ]);
  });

  it("keeps live Provider Account claims unique within a Project", async () => {
    const fingerprint = "sha256:provider-account";
    await insertCredential("pcred_fingerprint_live", "active", PROJECT_ID);
    await insertCredential("pcred_fingerprint_terminal", "failed_validation", PROJECT_ID);
    await insertCredential("pcred_fingerprint_other_project", "active", OTHER_PROJECT_ID);
    await insertConnection(
      "cconn_fingerprint_live",
      { id: "pcred_fingerprint_live", projectId: PROJECT_ID },
      { projectId: PROJECT_ID, status: "failed", providerAccountFingerprint: fingerprint }
    );
    await activateConnection("cconn_fingerprint_live", "cwlt_fingerprint_live");
    await insertConnection(
      "cconn_fingerprint_terminal",
      { id: "pcred_fingerprint_terminal", projectId: PROJECT_ID },
      { projectId: PROJECT_ID, status: "failed", providerAccountFingerprint: fingerprint }
    );
    await insertConnection(
      "cconn_fingerprint_other_project",
      { id: "pcred_fingerprint_other_project", projectId: OTHER_PROJECT_ID },
      { projectId: OTHER_PROJECT_ID, status: "failed", providerAccountFingerprint: fingerprint }
    );
    await activateConnection("cconn_fingerprint_other_project", "cwlt_fingerprint_other_project");

    await expect(
      getDb(env)
        .prepare(
          `UPDATE custody_connections
           SET status = 'pending',
               last_check_status = NULL,
               last_check_at = NULL
           WHERE id = 'cconn_fingerprint_terminal'`
        )
        .run()
    ).rejects.toThrow(/idx_custody_connections_live_provider_account/);
  });
});
