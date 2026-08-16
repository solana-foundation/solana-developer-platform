import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolveRpcTarget } from "@sdp/rpc/relay";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import type { KVStoreSet } from "@/runtime/kv";
import { createCredentialSecretStore } from "@/services/credential-secret-store";
import { createTenantRpcConnectionLookup } from "@/services/rpc-connection-lookup";
import { RpcConnectionStore } from "@/services/stores/rpc-connection.store";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";

/**
 * The whole BYOK chain against real Postgres and real encryption: a tenant key
 * is written through CredentialSecretStore, bound to a connection, activated,
 * and then actually used by the relay to reach the tenant's own endpoint.
 *
 * Unit tests cover each link with stubs; this is the one that answers "will my
 * own credentials work".
 */
const ORG_ID = "org_rpc_byok_e2e";
const USER_ID = "usr_rpc_byok_e2e";
const CREDENTIAL_ID = "pcred_rpc_byok_e2e";
const CONNECTION_ID = "rconn_rpc_byok_e2e";
const TENANT_KEY = "tenant-secret-abcd1234";
const appEnv = env as unknown as Env;

const kv = {
  cache: {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [] }),
  },
} as unknown as KVStoreSet;

let server: Server;
let seenKeys: string[] = [];
let endpointBase = "";
let originalEncryptionKey: string | undefined;

beforeAll(async () => {
  await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  // Same approach as the custody migration tests: the suite supplies its own
  // key so the encrypted_db backend is exercised for real.
  originalEncryptionKey = appEnv.CUSTODY_ENCRYPTION_KEY;
  appEnv.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  // Stands in for the vendor: records the key it was reached with.
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    seenKeys.push(url.searchParams.get("api-key") ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { "solana-core": "2.0.0" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpointBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const db = getDb(appEnv);
  await db
    .prepare(
      `INSERT INTO organizations (id, name, slug, tier, status)
       VALUES (?, 'BYOK E2E', 'byok-e2e', 'enterprise', 'active')`
    )
    .bind(ORG_ID)
    .run();
  await db
    .prepare(
      `INSERT INTO users (id, email, email_verified, status)
       VALUES (?, 'byok-e2e@example.com', 1, 'active')`
    )
    .bind(USER_ID)
    .run();

  // The real secret path: encrypted through the configured backend.
  // The test env has no GCP config; encrypted_db is the backend local dev
  // and self-hosted use, and is what the credential row records either way.
  const secretStore = createCredentialSecretStore(appEnv, "encrypted_db");
  const stored = await secretStore.write({
    orgId: ORG_ID,
    provider: "helius",
    providerCredentialId: CREDENTIAL_ID,
    payload: { endpointUrl: endpointBase, apiKey: TENANT_KEY },
  });

  await db
    .prepare(
      `INSERT INTO provider_credentials (
         id, organization_id, project_id, provider, label, scope, source,
         storage_backend, secret_ref, secret_version_ref, encrypted_secret_payload,
         status, created_by
       ) VALUES (?, ?, NULL, 'helius', 'Tenant Helius', 'organization', 'stored',
                 ?, ?, ?, ?, 'active', ?)`
    )
    .bind(
      CREDENTIAL_ID,
      ORG_ID,
      stored.storageBackend,
      stored.secretRef ?? null,
      stored.secretVersionRef ?? null,
      stored.encryptedSecretPayload ?? null,
      USER_ID
    )
    .run();

  const connections = new RpcConnectionStore(getDb(appEnv));
  await connections.insertConnection({
    id: CONNECTION_ID,
    organizationId: ORG_ID,
    projectId: null,
    provider: "helius",
    providerCredentialId: CREDENTIAL_ID,
    providerCredentialScopeKey: "__organization__",
    network: "devnet",
    displayMetadata: { endpointHost: "127.0.0.1", apiKeySuffix: "1234" },
    createdBy: USER_ID,
  });
});

afterAll(async () => {
  appEnv.CUSTODY_ENCRYPTION_KEY = originalEncryptionKey;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
});

describe("BYOK end to end", () => {
  it("does not serve a connection that has not been activated", async () => {
    // Pending, so it is "configured but not live" -- fail closed, not fallback.
    await expect(
      resolveRpcTarget({
        env: { ...appEnv, SOLANA_NETWORK: "devnet", SOLANA_RPC_URL: "https://platform.example" },
        kv,
        db: getDb(appEnv),
        organizationId: ORG_ID,
        authProjectId: null,
        requestedProjectId: null,
        connections: createTenantRpcConnectionLookup(appEnv, getDb(appEnv)),
      })
    ).rejects.toThrow(/not active/i);
  });

  it("routes through the tenant's own endpoint and key once activated", async () => {
    const connections = new RpcConnectionStore(getDb(appEnv));
    await connections.activateConnection({
      organizationId: ORG_ID,
      connectionId: CONNECTION_ID,
      scopeKeys: ["__organization__"],
      makeDefault: true,
    });

    const target = await resolveRpcTarget({
      env: { ...appEnv, SOLANA_NETWORK: "devnet", SOLANA_RPC_URL: "https://platform.example" },
      kv,
      db: getDb(appEnv),
      organizationId: ORG_ID,
      authProjectId: null,
      requestedProjectId: null,
      connections: createTenantRpcConnectionLookup(appEnv, getDb(appEnv)),
    });

    expect(target.selectionMode).toBe("organization_connection");
    expect(target.connectionId).toBe(CONNECTION_ID);
    expect(target.endpoint).toContain(encodeURIComponent(TENANT_KEY));
    // The label is what surfaces to callers, and it must not carry the key.
    expect(target.endpointLabel).not.toContain(TENANT_KEY);

    // And the endpoint genuinely works: reach it the way the relay does.
    seenKeys = [];
    const upstream = await fetch(target.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...target.headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "getVersion", params: [] }),
    });

    expect(upstream.ok).toBe(true);
    expect(seenKeys).toEqual([TENANT_KEY]);
  });

  it("stops using the tenant key the moment the connection is deactivated", async () => {
    const connections = new RpcConnectionStore(getDb(appEnv));
    await connections.deactivateConnection({
      organizationId: ORG_ID,
      connectionId: CONNECTION_ID,
      scopeKeys: ["__organization__"],
    });

    const target = await resolveRpcTarget({
      env: { ...appEnv, SOLANA_NETWORK: "devnet", SOLANA_RPC_URL: "https://platform.example" },
      kv,
      db: getDb(appEnv),
      organizationId: ORG_ID,
      authProjectId: null,
      requestedProjectId: null,
      connections: createTenantRpcConnectionLookup(appEnv, getDb(appEnv)),
    });

    // Deactivated is a deliberate withdrawal, so the platform rail is correct
    // here -- unlike a broken connection, which fails closed.
    expect(target.selectionMode).toBe("round_robin_default");
    expect(target.endpoint).not.toContain(TENANT_KEY);
  });
});
