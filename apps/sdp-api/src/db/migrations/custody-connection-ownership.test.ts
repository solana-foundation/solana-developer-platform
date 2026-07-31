import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { CustodyConfigStore } from "@/services/stores/custody-config.store";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";

const ORGANIZATION_ID = "org_custody_connection_constraints";
const PROJECT_ID = "prj_custody_connection_constraints";
const USER_ID = "usr_custody_connection_constraints";
const CONFIG_ID = "cust_custody_connection_constraints";

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
    db
      .prepare(
        `INSERT INTO projects
           (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Custody connection constraints', ?, 'sandbox', 'active', ?)`
      )
      .bind(PROJECT_ID, ORGANIZATION_ID, "custody-connection-constraints", USER_ID),
    db
      .prepare(
        `INSERT INTO custody_configs (
           id, organization_id, project_id, provider, config_encrypted,
           encryption_version, status
         ) VALUES (?, ?, ?, 'privy', 'legacy', 'test', 'active')`
      )
      .bind(CONFIG_ID, ORGANIZATION_ID, PROJECT_ID),
  ]);
}

async function insertCredential(
  id: string,
  status = "pending",
  ciphertext: string | null = "secret",
  organizationId = ORGANIZATION_ID,
  projectId = PROJECT_ID
) {
  await getDb(env)
    .prepare(
      `INSERT INTO provider_credentials (
         id, organization_id, project_id, provider, label, scope, source,
         storage_backend, encrypted_secret_payload, status, created_by
       ) VALUES (?, ?, ?, 'privy', 'Privy', 'project', 'stored',
                 'encrypted_db', ?, ?, ?)`
    )
    .bind(id, organizationId, projectId, ciphertext, status, USER_ID)
    .run();
}

async function insertConnection(
  id: string,
  credentialId: string,
  organizationId = ORGANIZATION_ID,
  projectId = PROJECT_ID
): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO custody_connections (
         id, organization_id, project_id, provider, scope,
         provider_credential_id, provider_credential_scope_key, status, created_by
       ) VALUES (?, ?, ?, 'privy', 'project', ?, ?, 'pending', ?)`
    )
    .bind(id, organizationId, projectId, credentialId, projectId, USER_ID)
    .run();
}

async function insertConnectionWallet(id: string, connectionId: string): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO custody_wallets (
         id, custody_connection_id, wallet_id, public_key, status
       ) VALUES (?, ?, ?, ?, 'active')`
    )
    .bind(id, connectionId, `provider_${id}`, `public_${id}`)
    .run();
}

describe("custody Connection ownership constraints", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedScope();
  });

  afterEach(async () => {
    await clearTestDatabase(env);
  });

  it("requires every wallet to have exactly one Config or Connection owner", async () => {
    await insertCredential("pcred_wallet_owner");
    await insertConnection("cconn_wallet_owner", "pcred_wallet_owner");
    await insertConnectionWallet("cwlt_connection_owner", "cconn_wallet_owner");
    await getDb(env)
      .prepare(
        `INSERT INTO custody_wallets (
           id, custody_config_id, wallet_id, public_key, status
         ) VALUES ('cwlt_config_owner', ?, 'provider_config_owner', 'public_config_owner', 'active')`
      )
      .bind(CONFIG_ID)
      .run();

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

  it("allows a Connection to default only to one of its own wallets", async () => {
    await insertCredential("pcred_default_one");
    await insertCredential("pcred_default_two");
    await insertConnection("cconn_default_one", "pcred_default_one");
    await insertConnection("cconn_default_two", "pcred_default_two");
    await insertConnectionWallet("cwlt_default_one", "cconn_default_one");
    await insertConnectionWallet("cwlt_default_two", "cconn_default_two");

    await getDb(env)
      .prepare(
        `UPDATE custody_connections
         SET default_custody_wallet_id = 'cwlt_default_one'
         WHERE id = 'cconn_default_one'`
      )
      .run();

    await expect(
      getDb(env)
        .prepare(
          `UPDATE custody_connections
           SET default_custody_wallet_id = 'cwlt_default_two'
           WHERE id = 'cconn_default_one'`
        )
        .run()
    ).rejects.toThrow(/custody_connections_default_wallet_owner_fkey/);

    await getDb(env)
      .prepare("DELETE FROM custody_connections WHERE id = 'cconn_default_one'")
      .run();
    expect(
      await getDb(env)
        .prepare("SELECT id FROM custody_wallets WHERE id = 'cwlt_default_one'")
        .first()
    ).toBeNull();
  });

  it("requires a scope default pointer and keeps Connection pointers project-only", async () => {
    await insertCredential("pcred_scope_default");
    await insertConnection("cconn_scope_default", "pcred_scope_default");

    await getDb(env)
      .prepare(
        `INSERT INTO custody_scope_defaults (
           id, organization_id, project_id, default_custody_connection_id
         ) VALUES ('csd_connection_only', ?, ?, 'cconn_scope_default')`
      )
      .bind(ORGANIZATION_ID, PROJECT_ID)
      .run();

    await expect(
      new CustodyConfigStore(getDb(env), env).getDefaultConfig(ORGANIZATION_ID, PROJECT_ID)
    ).resolves.toBeNull();

    await expect(
      getDb(env)
        .prepare(
          `INSERT INTO custody_scope_defaults (id, organization_id, project_id)
           VALUES ('csd_no_target', ?, ?)`
        )
        .bind(ORGANIZATION_ID, PROJECT_ID)
        .run()
    ).rejects.toThrow(/custody_scope_defaults_has_target/);

    await expect(
      getDb(env)
        .prepare(
          `INSERT INTO custody_scope_defaults (
             id, organization_id, default_custody_connection_id
           ) VALUES ('csd_org_connection', ?, 'cconn_scope_default')`
        )
        .bind(ORGANIZATION_ID)
        .run()
    ).rejects.toThrow(/custody_scope_defaults_connection_project_only/);
  });

  it("requires a selected Connection to belong to the same organization and project", async () => {
    const otherProjectId = "prj_custody_connection_constraints_other";
    const otherOrganizationId = "org_custody_connection_constraints_other";
    const otherOrganizationProjectId = "prj_custody_connection_constraints_other_org";
    const db = getDb(env);

    await db.batch([
      db
        .prepare(
          `INSERT INTO projects (
             id, organization_id, name, slug, environment, status, created_by
           ) VALUES (?, ?, 'Other project', ?, 'sandbox', 'active', ?)`
        )
        .bind(otherProjectId, ORGANIZATION_ID, "custody-connection-constraints-other", USER_ID),
      db
        .prepare(
          `INSERT INTO organizations (id, name, slug, tier, status)
           VALUES (?, 'Other organization', ?, 'individual', 'active')`
        )
        .bind(otherOrganizationId, "custody-connection-constraints-other-org"),
      db
        .prepare(
          `INSERT INTO projects (
             id, organization_id, name, slug, environment, status, created_by
           ) VALUES (?, ?, 'Other organization project', ?, 'sandbox', 'active', ?)`
        )
        .bind(
          otherOrganizationProjectId,
          otherOrganizationId,
          "custody-connection-constraints-other-org",
          USER_ID
        ),
    ]);

    await insertCredential(
      "pcred_other_project",
      "pending",
      "secret",
      ORGANIZATION_ID,
      otherProjectId
    );
    await insertConnection(
      "cconn_other_project",
      "pcred_other_project",
      ORGANIZATION_ID,
      otherProjectId
    );
    await insertCredential(
      "pcred_other_organization",
      "pending",
      "secret",
      otherOrganizationId,
      otherOrganizationProjectId
    );
    await insertConnection(
      "cconn_other_organization",
      "pcred_other_organization",
      otherOrganizationId,
      otherOrganizationProjectId
    );

    for (const [id, connectionId] of [
      ["csd_cross_project", "cconn_other_project"],
      ["csd_cross_organization", "cconn_other_organization"],
    ]) {
      await expect(
        db
          .prepare(
            `INSERT INTO custody_scope_defaults (
               id, organization_id, project_id, default_custody_connection_id
             ) VALUES (?, ?, ?, ?)`
          )
          .bind(id, ORGANIZATION_ID, PROJECT_ID, connectionId)
          .run()
      ).rejects.toThrow(/custody_scope_defaults_default_custody_connection_id_fkey/);
    }
  });

  it("does not cascade a retained Connection target when its Config is deleted", async () => {
    await insertCredential("pcred_retained_target");
    await insertConnection("cconn_retained_target", "pcred_retained_target");
    await getDb(env)
      .prepare(
        `INSERT INTO custody_scope_defaults (
           id, organization_id, project_id,
           default_custody_config_id, default_custody_connection_id
         ) VALUES ('csd_retained_target', ?, ?, ?, 'cconn_retained_target')`
      )
      .bind(ORGANIZATION_ID, PROJECT_ID, CONFIG_ID)
      .run();

    await expect(
      getDb(env).prepare("DELETE FROM custody_configs WHERE id = ?").bind(CONFIG_ID).run()
    ).rejects.toThrow(/custody_scope_defaults_default_custody_config_id_fkey/);

    expect(
      await getDb(env)
        .prepare(
          `SELECT default_custody_config_id, default_custody_connection_id
           FROM custody_scope_defaults
           WHERE id = 'csd_retained_target'`
        )
        .first()
    ).toEqual({
      default_custody_config_id: CONFIG_ID,
      default_custody_connection_id: "cconn_retained_target",
    });
  });

  it("allows failed encrypted credentials to retain metadata without ciphertext", async () => {
    await insertCredential("pcred_failed_without_secret", "failed_validation", null);

    await expect(insertCredential("pcred_pending_without_secret", "pending", null)).rejects.toThrow(
      /provider_credentials_secret_location_check/
    );
  });
});
