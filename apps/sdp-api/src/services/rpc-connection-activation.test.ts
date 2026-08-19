import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { RpcConnectionStore } from "@/services/stores/rpc-connection.store";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

/**
 * Activation has to move two rows, not one.
 *
 * `insertCredential` writes the credential `pending`, and the relay's
 * effective-connection lookup requires `provider_credentials.status = 'active'`
 * as well as a live connection. While activation promoted only the connection,
 * the two never agreed: the dashboard read the connection as active and the
 * relay quietly kept using SDP's own keys. These cover the promotion and the
 * scope qualification on it.
 */
const ORGANIZATION_ID = "org_rpc_activation";
const OTHER_ORGANIZATION_ID = "org_rpc_activation_other";
const PROJECT_ID = "prj_rpc_activation";
const OTHER_PROJECT_ID = "prj_rpc_activation_other";
const USER_ID = "usr_rpc_activation";
const ORGANIZATION_SCOPE_KEY = "__organization__";

/**
 * What `actingScopeKeys` hands the store when a project is selected. The routes
 * gate on `org:admin`, which is an organization-wide role, and
 * `projectContextMiddleware` requires `x-project-id` on every request, so this
 * is the only key set the lifecycle operations are ever called with in the
 * dashboard. Dropping the organization key from it would leave every
 * organization-scoped connection permanently unactivatable.
 */
const PROJECT_CONTEXT_SCOPE_KEYS = [ORGANIZATION_SCOPE_KEY, PROJECT_ID];

async function seedScope(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, 'RPC activation', ?, 'individual', 'active')`
      )
      .bind(ORGANIZATION_ID, "rpc-activation"),
    db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, 'RPC activation other', ?, 'individual', 'active')`
      )
      .bind(OTHER_ORGANIZATION_ID, "rpc-activation-other"),
    db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, 'rpc-activation@example.com', 1, 'active')`
      )
      .bind(USER_ID),
    db
      .prepare(
        `INSERT INTO projects
           (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'RPC activation', ?, 'sandbox', 'active', ?)`
      )
      .bind(PROJECT_ID, ORGANIZATION_ID, "rpc-activation", USER_ID),
    db
      .prepare(
        `INSERT INTO projects
           (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'RPC activation other', ?, 'sandbox', 'active', ?)`
      )
      .bind(OTHER_PROJECT_ID, ORGANIZATION_ID, "rpc-activation-other", USER_ID),
  ]);
}

async function seedPendingConnection(
  connectionId: string,
  credentialId: string,
  options: {
    credentialStatus?: string;
    connectionStatus?: string;
    isDefault?: boolean;
    projectId?: string;
  } = {}
): Promise<void> {
  const db = getDb(env);
  const connectionStatus = options.connectionStatus ?? "pending";
  await db
    .prepare(
      `INSERT INTO provider_credentials (
         id, organization_id, project_id, provider, label, scope, source,
         storage_backend, encrypted_secret_payload, status, deactivated_at, created_by
       ) VALUES (?, ?, NULL, 'helius', 'Tenant Helius', 'organization', 'stored',
                 'encrypted_db', 'secret', ?, ?, ?)`
    )
    .bind(
      credentialId,
      ORGANIZATION_ID,
      options.credentialStatus ?? "pending",
      options.credentialStatus === "deactivated" ? "2026-08-16T12:00:00.000Z" : null,
      USER_ID
    )
    .run();

  // A project connection is allowed to borrow the organization credential, so
  // only the connection row changes scope here.
  await db
    .prepare(
      `INSERT INTO rpc_connections (
         id, organization_id, project_id, provider, scope,
         provider_credential_id, provider_credential_scope_key,
         network, status, is_default, activated_at, deactivated_at, created_by
       ) VALUES (?, ?, ?, 'helius', ?, ?, '__organization__',
                 'devnet', ?, ?, ?, ?, ?)`
    )
    .bind(
      connectionId,
      ORGANIZATION_ID,
      options.projectId ?? null,
      options.projectId ? "project" : "organization",
      credentialId,
      connectionStatus,
      options.isDefault ?? false,
      connectionStatus === "pending" || connectionStatus === "checking"
        ? null
        : "2026-08-16T12:00:00.000Z",
      connectionStatus === "deactivated" ? "2026-08-16T12:30:00.000Z" : null,
      USER_ID
    )
    .run();
}

async function credentialStatus(credentialId: string): Promise<string | undefined> {
  const row = await getDb(env)
    .prepare("SELECT status FROM provider_credentials WHERE id = ?")
    .bind(credentialId)
    .first<{ status: string }>();
  return row?.status;
}

describe("RpcConnectionStore.activateConnectionCredential", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedScope();
  });

  it("promotes a pending credential so the relay lookup can match it", async () => {
    await seedPendingConnection("rconn_activation_ok", "pcred_activation_ok");
    const store = new RpcConnectionStore(getDb(env));

    expect(await credentialStatus("pcred_activation_ok")).toBe("pending");

    const promoted = await store.activateConnectionCredential({
      organizationId: ORGANIZATION_ID,
      connectionId: "rconn_activation_ok",
      scopeKeys: ["__organization__"],
    });

    expect(promoted).toBe(1);
    expect(await credentialStatus("pcred_activation_ok")).toBe("active");
  });

  it("promotes a credential that previously failed validation", async () => {
    await seedPendingConnection("rconn_activation_retry", "pcred_activation_retry", {
      credentialStatus: "failed_validation",
    });
    const store = new RpcConnectionStore(getDb(env));

    // Retrying after a corrected key is the ordinary recovery path, so a
    // failed validation must not be terminal.
    const promoted = await store.activateConnectionCredential({
      organizationId: ORGANIZATION_ID,
      connectionId: "rconn_activation_retry",
      scopeKeys: ["__organization__"],
    });

    expect(promoted).toBe(1);
    expect(await credentialStatus("pcred_activation_retry")).toBe("active");
  });

  it("refuses to resurrect a deactivated credential", async () => {
    await seedPendingConnection("rconn_activation_dead", "pcred_activation_dead", {
      credentialStatus: "deactivated",
    });
    const store = new RpcConnectionStore(getDb(env));

    const promoted = await store.activateConnectionCredential({
      organizationId: ORGANIZATION_ID,
      connectionId: "rconn_activation_dead",
      scopeKeys: ["__organization__"],
    });

    // Zero is what the service turns into a 409: activating the connection
    // anyway would leave the healthy-looking row that never resolves.
    expect(promoted).toBe(0);
    expect(await credentialStatus("pcred_activation_dead")).toBe("deactivated");
  });

  it("does not promote for another organization", async () => {
    await seedPendingConnection("rconn_activation_scoped", "pcred_activation_scoped");
    const store = new RpcConnectionStore(getDb(env));

    const promoted = await store.activateConnectionCredential({
      organizationId: OTHER_ORGANIZATION_ID,
      connectionId: "rconn_activation_scoped",
      scopeKeys: ["__organization__"],
    });

    expect(promoted).toBe(0);
    expect(await credentialStatus("pcred_activation_scoped")).toBe("pending");
  });

  it("promotes an organization connection for an administrator acting in a project", async () => {
    await seedPendingConnection("rconn_activation_ctx", "pcred_activation_ctx");
    const store = new RpcConnectionStore(getDb(env));

    // Deliberate, and the reason `actingScopeKeys` keeps the organization key
    // alongside the selected project: the caller holds the organization-wide
    // `org:admin`, and a project header is mandatory on these routes, so an
    // organization connection would otherwise be impossible to activate at all.
    const promoted = await store.activateConnectionCredential({
      organizationId: ORGANIZATION_ID,
      connectionId: "rconn_activation_ctx",
      scopeKeys: PROJECT_CONTEXT_SCOPE_KEYS,
    });

    expect(promoted).toBe(1);
    expect(await credentialStatus("pcred_activation_ctx")).toBe("active");
  });

  it("does not promote another project's connection", async () => {
    await seedPendingConnection("rconn_activation_other_project", "pcred_activation_other", {
      projectId: OTHER_PROJECT_ID,
    });
    const store = new RpcConnectionStore(getDb(env));

    // The boundary that is actually crossable: same organization, same
    // administrator, a connection belonging to a project they have not
    // selected. Only the selected project's key reaches the store.
    const promoted = await store.activateConnectionCredential({
      organizationId: ORGANIZATION_ID,
      connectionId: "rconn_activation_other_project",
      scopeKeys: PROJECT_CONTEXT_SCOPE_KEYS,
    });

    expect(promoted).toBe(0);
    expect(await credentialStatus("pcred_activation_other")).toBe("pending");
  });

  it("matches only the scope keys it is handed", async () => {
    await seedPendingConnection("rconn_activation_project", "pcred_activation_project");
    const store = new RpcConnectionStore(getDb(env));

    // The store's half of the contract: it filters on exactly the key set the
    // caller supplies and infers nothing from the organization id.
    const promoted = await store.activateConnectionCredential({
      organizationId: ORGANIZATION_ID,
      connectionId: "rconn_activation_project",
      scopeKeys: [PROJECT_ID],
    });

    expect(promoted).toBe(0);
    expect(await credentialStatus("pcred_activation_project")).toBe("pending");
  });
});

/**
 * The fail-closed boundary.
 *
 * An organization that put its own key on a live connection must never have
 * its traffic moved back onto SDP's credentials without saying so. But a row
 * that has never carried traffic is not that promise, and treating it as one
 * turned an abandoned create form into an org-wide outage — including the
 * surfaces an administrator would use to fix it.
 */
describe("RpcConnectionStore.findScopeConnectionState", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedScope();
  });

  const scope = {
    organizationId: ORGANIZATION_ID,
    scopeKey: "__organization__",
    network: "devnet" as const,
  };

  it("reports an activated default as live", async () => {
    await seedPendingConnection("rconn_state_live", "pcred_state_live", {
      connectionStatus: "active",
      credentialStatus: "active",
      isDefault: true,
    });

    const state = await new RpcConnectionStore(getDb(env)).findScopeConnectionState(scope);
    expect(state).toEqual({ kind: "active", connectionId: "rconn_state_live" });
  });

  it("treats a submitted-but-never-activated connection as nothing configured", async () => {
    await seedPendingConnection("rconn_state_pending", "pcred_state_pending");

    // The draft the reviewer called out: this used to answer "unusable", and
    // the relay turned that into a 502 on every RPC call in the organization.
    const state = await new RpcConnectionStore(getDb(env)).findScopeConnectionState(scope);
    expect(state).toEqual({ kind: "none" });
  });

  it("treats an in-flight check as nothing configured", async () => {
    await seedPendingConnection("rconn_state_checking", "pcred_state_checking", {
      connectionStatus: "checking",
    });

    const state = await new RpcConnectionStore(getDb(env)).findScopeConnectionState(scope);
    expect(state).toEqual({ kind: "none" });
  });

  it("fails closed on a connection that was live and then failed its check", async () => {
    await seedPendingConnection("rconn_state_failed", "pcred_state_failed", {
      connectionStatus: "failed",
      credentialStatus: "active",
    });

    const state = await new RpcConnectionStore(getDb(env)).findScopeConnectionState(scope);
    expect(state).toEqual({ kind: "unusable" });
  });

  it("falls back once the connection is deactivated", async () => {
    await seedPendingConnection("rconn_state_off", "pcred_state_off", {
      connectionStatus: "deactivated",
      credentialStatus: "active",
    });

    const state = await new RpcConnectionStore(getDb(env)).findScopeConnectionState(scope);
    expect(state).toEqual({ kind: "none" });
  });

  it("does not call a scope live that the effective lookup would not resolve", async () => {
    await seedPendingConnection("rconn_state_split", "pcred_state_split", {
      connectionStatus: "active",
      credentialStatus: "pending",
      isDefault: true,
    });

    // Without the credential predicate this answered "active" while
    // findEffectiveConnection returned null, and the relay silently spent SDP's
    // keys on an organization that had asked for its own.
    const store = new RpcConnectionStore(getDb(env));
    expect(await store.findScopeConnectionState(scope)).toEqual({ kind: "unusable" });
    expect(await store.findEffectiveConnection(scope)).toBeNull();
  });
});
