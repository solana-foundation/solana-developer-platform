import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { RpcConnectionStore } from "@/services/stores/rpc-connection.store";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

/**
 * Switching a project onto a provider has two possible meanings, and the store
 * has to be able to tell them apart: the project holds a key for it, so that
 * key takes over, or it does not, so nothing tenant-owned may keep serving.
 *
 * Choosing a provider used to write only the organization's setting, which the
 * relay reaches last. A tenant connection kept answering, so "Use this
 * provider" reported success and changed nothing observable.
 */
const ORGANIZATION_ID = "org_rpc_serving";
const PROJECT_ID = "prj_rpc_serving";
const USER_ID = "usr_rpc_serving";

async function seedScope(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, 'RPC serving', ?, 'individual', 'active')`
      )
      .bind(ORGANIZATION_ID, "rpc-serving"),
    db
      .prepare(
        `INSERT INTO users (id, email, name, status)
         VALUES (?, 'rpc-serving@example.com', 'RPC serving', 'active')`
      )
      .bind(USER_ID),
    db
      .prepare(
        `INSERT INTO projects
           (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'RPC serving', ?, 'sandbox', 'active', ?)`
      )
      .bind(PROJECT_ID, ORGANIZATION_ID, "rpc-serving", USER_ID),
  ]);
}

async function seedConnection(options: {
  connectionId: string;
  credentialId: string;
  provider: string;
  status?: string;
  isDefault?: boolean;
}): Promise<void> {
  const db = getDb(env);
  const status = options.status ?? "active";
  await db
    .prepare(
      `INSERT INTO provider_credentials (
         id, organization_id, project_id, provider, label, scope, source,
         storage_backend, encrypted_secret_payload, status, created_by
       ) VALUES (?, ?, ?, ?, ?, 'project', 'stored',
                 'encrypted_db', 'secret', 'active', ?)`
    )
    .bind(
      options.credentialId,
      ORGANIZATION_ID,
      PROJECT_ID,
      options.provider,
      `Tenant ${options.provider}`,
      USER_ID
    )
    .run();

  await db
    .prepare(
      `INSERT INTO rpc_connections (
         id, organization_id, project_id, provider, scope,
         provider_credential_id, provider_credential_scope_key,
         network, status, is_default, activated_at, deactivated_at, created_by
       ) VALUES (?, ?, ?, ?, 'project', ?, ?,
                 'devnet', ?, ?, ?, ?, ?)`
    )
    .bind(
      options.connectionId,
      ORGANIZATION_ID,
      PROJECT_ID,
      options.provider,
      options.credentialId,
      PROJECT_ID,
      status,
      options.isDefault ?? false,
      status === "deactivated" ? "2026-08-16T12:00:00.000Z" : "2026-08-16T12:00:00.000Z",
      status === "deactivated" ? "2026-08-16T12:30:00.000Z" : null,
      USER_ID
    )
    .run();
}

async function servingProvider(): Promise<string | null> {
  const row = await getDb(env)
    .prepare(
      `SELECT provider FROM rpc_connections
        WHERE organization_id = ? AND scope_key = ? AND network = 'devnet'
          AND is_default = TRUE AND status = 'active'`
    )
    .bind(ORGANIZATION_ID, PROJECT_ID)
    .first<{ provider: string }>();
  return row?.provider ?? null;
}

describe("switching which provider serves a project", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedScope();
  });

  it("finds the project's own key for the provider being switched to", async () => {
    await seedConnection({
      connectionId: "rconn_serving_alchemy",
      credentialId: "pcred_serving_alchemy",
      provider: "alchemy",
      isDefault: true,
    });
    await seedConnection({
      connectionId: "rconn_serving_triton",
      credentialId: "pcred_serving_triton",
      provider: "triton",
    });

    const store = new RpcConnectionStore(getDb(env));
    const found = await store.findLiveConnectionForProvider({
      organizationId: ORGANIZATION_ID,
      scopeKey: PROJECT_ID,
      network: "devnet",
      provider: "triton",
    });

    // Narrowed to the provider asked about. A lookup that answered with any
    // connection the project held is what let one page name two providers.
    expect(found?.id).toBe("rconn_serving_triton");
  });

  it("does not offer a withdrawn key as something to switch onto", async () => {
    // Deactivation destroys the secret, so promoting one would report success
    // and route nothing.
    await seedConnection({
      connectionId: "rconn_serving_gone",
      credentialId: "pcred_serving_gone",
      provider: "quicknode",
      status: "deactivated",
    });

    const store = new RpcConnectionStore(getDb(env));
    const found = await store.findLiveConnectionForProvider({
      organizationId: ORGANIZATION_ID,
      scopeKey: PROJECT_ID,
      network: "devnet",
      provider: "quicknode",
    });

    expect(found).toBeNull();
  });

  it("answers for a provider the project holds nothing for", async () => {
    await seedConnection({
      connectionId: "rconn_serving_only",
      credentialId: "pcred_serving_only",
      provider: "alchemy",
      isDefault: true,
    });

    const store = new RpcConnectionStore(getDb(env));
    const found = await store.findLiveConnectionForProvider({
      organizationId: ORGANIZATION_ID,
      scopeKey: PROJECT_ID,
      network: "devnet",
      provider: "helius",
    });

    expect(found).toBeNull();
  });

  it("stands the tenant credential down so SDP's account can answer", async () => {
    // The half that had no route at all. Without it, choosing a provider the
    // project holds no key for left the old key serving and the switch was
    // invisible -- and deactivating instead would have destroyed a working
    // secret to change a routing decision.
    await seedConnection({
      connectionId: "rconn_serving_incumbent",
      credentialId: "pcred_serving_incumbent",
      provider: "alchemy",
      isDefault: true,
    });
    expect(await servingProvider()).toBe("alchemy");

    const store = new RpcConnectionStore(getDb(env));
    await store.clearDefault({
      organizationId: ORGANIZATION_ID,
      scopeKey: PROJECT_ID,
      network: "devnet",
    });

    expect(await servingProvider()).toBeNull();
    // Stood down, not withdrawn: the key survives and can serve again.
    const kept = await store.findLiveConnectionForProvider({
      organizationId: ORGANIZATION_ID,
      scopeKey: PROJECT_ID,
      network: "devnet",
      provider: "alchemy",
    });
    expect(kept?.id).toBe("rconn_serving_incumbent");
  });
});
