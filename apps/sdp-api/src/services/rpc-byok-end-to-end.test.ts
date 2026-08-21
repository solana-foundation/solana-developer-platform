import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolveRpcTarget } from "@sdp/rpc/relay";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import type { KVStoreSet } from "@/runtime/kv";
import { createCredentialSecretStore } from "@/services/credential-secret-store";
import {
  activateRpcConnection,
  deactivateRpcConnection,
  submitRpcConnection,
} from "@/services/rpc-connection.service";
import { createTenantRpcConnectionLookup } from "@/services/rpc-connection-lookup";
import { RpcConnectionStore } from "@/services/stores/rpc-connection.store";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";

/**
 * The whole BYOK chain against real Postgres and real encryption: submit,
 * activate, resolve.
 *
 * Activation and deactivation go through `rpc-connection.service`, not through
 * the store. That distinction is the point of this file. An earlier version
 * seeded the credential row `active` and called `RpcConnectionStore` directly,
 * which meant it passed while `insertCredential` wrote `pending` and nothing
 * promoted it -- the relay's effective lookup never matched in production and
 * the organization's traffic quietly stayed on SDP's keys. A test that seeds
 * the state under test proves nothing about the code that produces it.
 *
 * Unit tests cover each link with stubs; this is the one that answers "will my
 * own credentials work".
 */
/**
 * The stand-in provider below is an ordinary loopback server, and activation
 * probes tenant endpoints through the egress guard, which refuses loopback and
 * plaintext by design. That refusal is the correct production behaviour and is
 * asserted in `guarded-egress.test.ts` and `rpc-egress.test.ts`. This file is
 * about the credential lifecycle, so the guard is delegated to plain fetch here
 * rather than weakened anywhere real.
 */
vi.mock("@/services/guarded-egress", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/guarded-egress")>();
  return {
    ...actual,
    guardedFetch: (url: string, init: { method: string; headers: HeadersInit; body: string }) =>
      fetch(url, { method: init.method, headers: init.headers, body: init.body }),
  };
});

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
let originalSecretBackend: string | undefined;

/**
 * The slice of the Hono context the connection service reads: `getAuth` looks
 * for a `clerk` session, and scope resolution looks for `projectId`. Building
 * the real middleware stack here would test the middleware, not the chain.
 */
function serviceContext() {
  const values: Record<string, unknown> = {
    clerk: {
      userId: USER_ID,
      organizationId: ORG_ID,
      role: "admin",
      permissions: ["org:read", "org:write", "org:admin"],
    },
    projectId: null,
  };
  return {
    env: appEnv,
    get: (key: string) => values[key],
  } as unknown as Parameters<typeof activateRpcConnection>[0];
}

async function credentialStatus(): Promise<string | undefined> {
  const row = await getDb(appEnv)
    .prepare("SELECT status FROM provider_credentials WHERE id = ?")
    .bind(CREDENTIAL_ID)
    .first<{ status: string }>();
  return row?.status;
}

function relayInput() {
  return {
    env: { ...appEnv, SOLANA_NETWORK: "devnet", SOLANA_RPC_URL: "https://platform.example" },
    kv,
    db: getDb(appEnv),
    organizationId: ORG_ID,
    authProjectId: null,
    requestedProjectId: null,
    connections: createTenantRpcConnectionLookup(appEnv, getDb(appEnv)),
  } as Parameters<typeof resolveRpcTarget>[0];
}

beforeAll(async () => {
  await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  // Same approach as the custody migration tests: the suite supplies its own
  // key so the encrypted_db backend is exercised for real.
  originalEncryptionKey = appEnv.CUSTODY_ENCRYPTION_KEY;
  appEnv.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  // The service resolves the backend from env rather than taking one, and the
  // test env has no GCP project. Pinning it keeps submission on the same
  // encrypted_db path the rest of this file writes through.
  originalSecretBackend = appEnv.CREDENTIAL_SECRET_STORE_BACKEND;
  appEnv.CREDENTIAL_SECRET_STORE_BACKEND = "encrypted_db";

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
                 ?, ?, ?, ?, 'pending', ?)`
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
  appEnv.CREDENTIAL_SECRET_STORE_BACKEND =
    originalSecretBackend as typeof appEnv.CREDENTIAL_SECRET_STORE_BACKEND;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
});

describe("BYOK end to end", () => {
  it("writes the credential pending, so nothing is live on submission alone", async () => {
    // The endpoint the real form would take: submission validates it but never
    // fetches it, so a routable vendor host is the honest fixture here.
    const submitted = await submitRpcConnection(serviceContext(), {
      provider: "helius",
      network: "devnet",
      scope: "organization",
      credentialLabel: "Submitted only",
      endpointUrl: "https://devnet.helius-rpc.com",
      apiKey: "submitted-key-9999",
    });

    expect(submitted.status).toBe("pending");
    expect(submitted.providerCredential.status).toBe("pending");
    // The response must never be able to carry the key back out.
    expect(JSON.stringify(submitted)).not.toContain("submitted-key-9999");
  });

  it("takes the platform rail while a connection is only submitted", async () => {
    // A draft is not a promise. Failing closed here would 502 the whole
    // organization over a form somebody opened and walked away from.
    const target = await resolveRpcTarget(relayInput());

    expect(target.selectionMode).toBe("round_robin_default");
    expect(target.endpoint).not.toContain(TENANT_KEY);
  });

  it("promotes the credential and routes through the tenant's own key on activation", async () => {
    expect(await credentialStatus()).toBe("pending");

    const activated = await activateRpcConnection(serviceContext(), CONNECTION_ID, {
      makeDefault: true,
    });

    expect(activated.status).toBe("active");
    // The half that was missing: the connection went active while the
    // credential stayed pending, so the effective lookup never matched.
    expect(await credentialStatus()).toBe("active");
    expect(activated.providerCredential.status).toBe("active");

    const target = await resolveRpcTarget(relayInput());

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

  it("fails closed once a live connection stops passing its check", async () => {
    // Not a draft: this organization's traffic was on its own key, so moving it
    // back onto SDP's without saying so is the thing being prevented.
    await new RpcConnectionStore(getDb(appEnv)).recordCheckFailure({
      organizationId: ORG_ID,
      connectionId: CONNECTION_ID,
      scopeKeys: ["__organization__"],
      failureCode: "provider_rejected",
    });

    await expect(resolveRpcTarget(relayInput())).rejects.toThrow(/not active/i);
  });

  it("recovers on re-activation rather than requiring a new connection", async () => {
    const reactivated = await activateRpcConnection(serviceContext(), CONNECTION_ID, {
      makeDefault: true,
    });

    expect(reactivated.status).toBe("active");
    const target = await resolveRpcTarget(relayInput());
    expect(target.connectionId).toBe(CONNECTION_ID);
  });

  it("stops using the tenant key the moment the connection is deactivated", async () => {
    await deactivateRpcConnection(serviceContext(), CONNECTION_ID);

    const target = await resolveRpcTarget(relayInput());

    // Deactivated is a deliberate withdrawal, so the platform rail is correct
    // here -- unlike a broken connection, which fails closed.
    expect(target.selectionMode).toBe("round_robin_default");
    expect(target.endpoint).not.toContain(TENANT_KEY);
  });
});
