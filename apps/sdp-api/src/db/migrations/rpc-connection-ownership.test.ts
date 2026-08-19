import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

/**
 * The database, not the service layer, is the boundary that has to hold: these
 * assert the constraints in 0060_rpc_connections.sql directly, so a future
 * service refactor cannot quietly become the only thing preventing a
 * cross-tenant credential reference or a second live default.
 */
const ORGANIZATION_ID = "org_rpc_connection_constraints";
const OTHER_ORGANIZATION_ID = "org_rpc_connection_constraints_other";
const PROJECT_ID = "prj_rpc_connection_constraints";
const OTHER_PROJECT_ID = "prj_rpc_connection_constraints_other";
const USER_ID = "usr_rpc_connection_constraints";
const CHECKED_AT = "2026-08-16T12:00:00.000Z";

async function seedScope(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, 'RPC connection constraints', ?, 'individual', 'active')`
      )
      .bind(ORGANIZATION_ID, "rpc-connection-constraints"),
    db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, 'RPC connection constraints other', ?, 'individual', 'active')`
      )
      .bind(OTHER_ORGANIZATION_ID, "rpc-connection-constraints-other"),
    db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, 'rpc-connection-constraints@example.com', 1, 'active')`
      )
      .bind(USER_ID),
    db
      .prepare(
        `INSERT INTO projects
           (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'RPC connection constraints', ?, 'sandbox', 'active', ?)`
      )
      .bind(PROJECT_ID, ORGANIZATION_ID, "rpc-connection-constraints", USER_ID),
    db
      .prepare(
        `INSERT INTO projects
           (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'RPC constraints other', ?, 'sandbox', 'active', ?)`
      )
      .bind(OTHER_PROJECT_ID, ORGANIZATION_ID, "rpc-constraints-other", USER_ID),
  ]);
}

async function insertCredential(
  id: string,
  options: { organizationId?: string; projectId?: string | null; provider?: string } = {}
): Promise<void> {
  const organizationId = options.organizationId ?? ORGANIZATION_ID;
  const projectId = options.projectId === undefined ? null : options.projectId;
  await getDb(env)
    .prepare(
      `INSERT INTO provider_credentials (
         id, organization_id, project_id, provider, label, scope, source,
         storage_backend, encrypted_secret_payload, status, created_by
       ) VALUES (?, ?, ?, ?, 'Tenant RPC', ?, 'stored', 'encrypted_db', 'secret', 'active', ?)`
    )
    .bind(
      id,
      organizationId,
      projectId,
      options.provider ?? "helius",
      projectId ? "project" : "organization",
      USER_ID
    )
    .run();
}

async function insertConnection(
  id: string,
  credentialId: string,
  options: {
    organizationId?: string;
    projectId?: string | null;
    credentialScopeKey?: string;
    provider?: string;
    network?: string;
    status?: string;
    isDefault?: boolean;
  } = {}
): Promise<void> {
  const organizationId = options.organizationId ?? ORGANIZATION_ID;
  const projectId = options.projectId === undefined ? null : options.projectId;
  const status = options.status ?? "active";
  await getDb(env)
    .prepare(
      `INSERT INTO rpc_connections (
         id, organization_id, project_id, provider, scope,
         provider_credential_id, provider_credential_scope_key,
         network, status, is_default, activated_at, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      organizationId,
      projectId,
      options.provider ?? "helius",
      projectId ? "project" : "organization",
      credentialId,
      options.credentialScopeKey ?? projectId ?? "__organization__",
      options.network ?? "devnet",
      status,
      options.isDefault ?? false,
      status === "active" ? CHECKED_AT : null,
      USER_ID
    )
    .run();
}

describe("rpc_connections constraints", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedScope();
  });

  it("refuses a credential belonging to another organization", async () => {
    await insertCredential("pcred_rpc_foreign", { organizationId: OTHER_ORGANIZATION_ID });

    // The composite foreign key has no parent row for (id, this org, ...), so
    // the reference cannot resolve regardless of what the service believed.
    // Asserting the constraint by name: a bare toThrow() would also pass on a
    // typo in the insert.
    await expect(insertConnection("rconn_foreign", "pcred_rpc_foreign")).rejects.toThrow(
      /foreign key constraint/i
    );
  });

  it("refuses a credential belonging to a different provider", async () => {
    await insertCredential("pcred_rpc_alchemy", { provider: "alchemy" });

    await expect(
      insertConnection("rconn_provider_mismatch", "pcred_rpc_alchemy", { provider: "helius" })
    ).rejects.toThrow();
  });

  it("refuses an organization connection reaching into a project credential", async () => {
    await insertCredential("pcred_rpc_project", { projectId: PROJECT_ID });

    await expect(
      insertConnection("rconn_org_borrowing_project", "pcred_rpc_project", {
        projectId: null,
        credentialScopeKey: PROJECT_ID,
      })
    ).rejects.toThrow(/rpc_connections_credential_scope_check|foreign key constraint/i);
  });

  it("lets a project connection borrow an organization credential", async () => {
    await insertCredential("pcred_rpc_org_shared");

    await insertConnection("rconn_project_borrowing_org", "pcred_rpc_org_shared", {
      projectId: PROJECT_ID,
      credentialScopeKey: "__organization__",
    });

    const row = await getDb(env)
      .prepare(`SELECT scope, scope_key FROM rpc_connections WHERE id = ?`)
      .bind("rconn_project_borrowing_org")
      .first<{ scope: string; scope_key: string }>();
    expect(row).toEqual({ scope: "project", scope_key: PROJECT_ID });
  });

  it("permits only one active default per scope and network", async () => {
    await insertCredential("pcred_rpc_default_one");
    await insertCredential("pcred_rpc_default_two");

    await insertConnection("rconn_default_one", "pcred_rpc_default_one", { isDefault: true });

    await expect(
      insertConnection("rconn_default_two", "pcred_rpc_default_two", { isDefault: true })
    ).rejects.toThrow(/rpc_connections_one_default_per_scope_network/);
  });

  it("keeps defaults independent across networks", async () => {
    await insertCredential("pcred_rpc_devnet");
    await insertCredential("pcred_rpc_mainnet");

    await insertConnection("rconn_devnet_default", "pcred_rpc_devnet", {
      isDefault: true,
      network: "devnet",
    });
    await insertConnection("rconn_mainnet_default", "pcred_rpc_mainnet", {
      isDefault: true,
      network: "mainnet-beta",
    });

    const rows = await getDb(env)
      .prepare(`SELECT COUNT(*) AS total FROM rpc_connections WHERE is_default = TRUE`)
      .bind()
      .first<{ total: number | string }>();
    expect(Number(rows?.total)).toBe(2);
  });

  it("keeps defaults independent across scopes", async () => {
    await insertCredential("pcred_rpc_scope_org");
    await insertCredential("pcred_rpc_scope_project", { projectId: PROJECT_ID });

    await insertConnection("rconn_org_default", "pcred_rpc_scope_org", { isDefault: true });
    await insertConnection("rconn_project_default", "pcred_rpc_scope_project", {
      projectId: PROJECT_ID,
      credentialScopeKey: PROJECT_ID,
      isDefault: true,
    });

    const rows = await getDb(env)
      .prepare(`SELECT COUNT(*) AS total FROM rpc_connections WHERE is_default = TRUE`)
      .bind()
      .first<{ total: number | string }>();
    expect(Number(rows?.total)).toBe(2);
  });

  it("refuses a default that is not live", async () => {
    await insertCredential("pcred_rpc_pending_default");

    // A pending connection the relay would never pick must not be able to
    // occupy the default slot and block the one that should hold it.
    await expect(
      insertConnection("rconn_pending_default", "pcred_rpc_pending_default", {
        status: "pending",
        isDefault: true,
      })
    ).rejects.toThrow(/rpc_connections_default_requires_active/);
  });

  it("lets a connection that was live record a later failed check", async () => {
    await insertCredential("pcred_rpc_failed_after_active");
    await insertConnection("rconn_failed_after_active", "pcred_rpc_failed_after_active", {
      status: "active",
      isDefault: true,
    });

    // Re-checking a live connection whose provider has started rejecting the
    // key is the ordinary case, and it must be recordable. While the lifecycle
    // check excluded 'failed', this update raised a constraint violation, the
    // 409 turned into a 500, and the row kept reading active with a stale
    // success — the relay would go on trusting a connection that was down.
    await expect(
      getDb(env)
        .prepare(
          `UPDATE rpc_connections
              SET status = 'failed',
                  is_default = FALSE,
                  last_check_status = 'failed',
                  last_check_failure_code = 'provider_rejected'
            WHERE id = ?`
        )
        .bind("rconn_failed_after_active")
        .run()
    ).resolves.toBeDefined();

    const row = await getDb(env)
      .prepare("SELECT status, activated_at FROM rpc_connections WHERE id = ?")
      .bind("rconn_failed_after_active")
      .first<{ status: string; activated_at: string | null }>();

    // activated_at survives: it is history, not a claim about current health.
    expect(row?.status).toBe("failed");
    expect(row?.activated_at).toBe(CHECKED_AT);
  });

  it("refuses an unknown network", async () => {
    await insertCredential("pcred_rpc_bad_network");

    await expect(
      insertConnection("rconn_bad_network", "pcred_rpc_bad_network", { network: "testnet" })
    ).rejects.toThrow(/rpc_connections_network_check/);
  });
});
