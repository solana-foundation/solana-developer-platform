import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SOLANA_GENESIS_HASHES } from "@sdp/rpc/byok";
import { resolveRpcTarget } from "@sdp/rpc/relay";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import type { KVStoreSet } from "@/runtime/kv";
import { createCredentialSecretStore } from "@/services/credential-secret-store";
import {
  activateRpcConnection,
  deactivateRpcConnection,
  rotateRpcConnection,
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

/**
 * Same reasoning one level up: saving now probes the endpoint (HOO-1228), so
 * the submit path runs the literal endpoint check too, and it refuses the
 * plaintext loopback host this file's stand-in provider listens on. The rule
 * itself is asserted in `rpc-byok-target.test.ts` and the egress suites; here
 * it would only be testing that a test server is not a real vendor.
 */
vi.mock("@sdp/rpc/byok", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sdp/rpc/byok")>();
  return {
    ...actual,
    assertReachableTenantEndpoint: () => undefined,
  };
});

const ORG_ID = "org_rpc_byok_e2e";
const PROJECT_ID = "prj_rpc_byok_e2e";
/**
 * Extra projects. One connection per project (HOO-1227) means each save needs
 * somewhere of its own, so the saving cases cannot share the fixture's.
 */
const PROJECT_ID_2 = "prj_rpc_byok_e2e_2";
const PROJECT_ID_3 = "prj_rpc_byok_e2e_3";
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
let rejectNextProbe = false;
let endpointBase = "";
let originalEncryptionKey: string | undefined;
let originalSecretBackend: string | undefined;

/**
 * The slice of the Hono context the connection service reads: `getAuth` looks
 * for a `clerk` session, and scope resolution looks for `projectId`. Building
 * the real middleware stack here would test the middleware, not the chain.
 */
function serviceContext(projectId: string = PROJECT_ID) {
  const values: Record<string, unknown> = {
    clerk: {
      userId: USER_ID,
      organizationId: ORG_ID,
      role: "admin",
      permissions: ["org:read", "org:write", "org:admin"],
    },
    projectId,
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
    authProjectId: PROJECT_ID,
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
    // One-shot rejection, for the "a bad key never becomes a row" case.
    if (rejectNextProbe) {
      rejectNextProbe = false;
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    // The probe asks `getGenesisHash` so it can tell which cluster answered,
    // and this stub stands in for a devnet endpoint. Answering `getVersion`
    // would pass reachability and prove nothing about the network.
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        result: SOLANA_GENESIS_HASHES.devnet,
      })
    );
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
  // Connections hang off a project since HOO-1226, so the chain needs a real
  // one to attach to rather than the organization fallback.
  await db
    .prepare(
      `INSERT INTO projects (id, organization_id, name, slug, environment, created_by)
       VALUES (?, ?, 'BYOK E2E', 'byok-e2e', 'sandbox', ?)`
    )
    .bind(PROJECT_ID, ORG_ID, USER_ID)
    .run();
  await db
    .prepare(
      `INSERT INTO projects (id, organization_id, name, slug, environment, created_by)
       VALUES (?, ?, 'BYOK E2E Two', 'byok-e2e-2', 'sandbox', ?)`
    )
    .bind(PROJECT_ID_2, ORG_ID, USER_ID)
    .run();
  await db
    .prepare(
      `INSERT INTO projects (id, organization_id, name, slug, environment, created_by)
       VALUES (?, ?, 'BYOK E2E Three', 'byok-e2e-3', 'sandbox', ?)`
    )
    .bind(PROJECT_ID_3, ORG_ID, USER_ID)
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
       ) VALUES (?, ?, ?, 'helius', 'Tenant Helius', 'project', 'stored',
                 ?, ?, ?, ?, 'pending', ?)`
    )
    .bind(
      CREDENTIAL_ID,
      ORG_ID,
      PROJECT_ID,
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
    projectId: PROJECT_ID,
    provider: "helius",
    providerCredentialId: CREDENTIAL_ID,
    providerCredentialScopeKey: PROJECT_ID,
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
  it("checks the key on save and stores a connection that is already live", async () => {
    // Saving probes (HOO-1228), so the endpoint has to be the stand-in server
    // rather than a vendor host nobody can reach from a test.
    seenKeys = [];
    const submitted = await submitRpcConnection(serviceContext(PROJECT_ID_2), {
      provider: "helius",
      // No network: the project is `sandbox`, so the service resolves devnet.
      scope: "project",
      credentialLabel: "Saved and checked",
      endpointUrl: endpointBase,
      apiKey: "submitted-key-9999",
    });

    // No pending step to explain: the probe is the evidence, so both rows go
    // live together.
    expect(submitted.status).toBe("active");
    expect(submitted.isDefault).toBe(true);
    expect(submitted.providerCredential.status).toBe("active");
    // The network came from the project rather than the caller (HOO-1221).
    expect(submitted.network).toBe("devnet");
    // The check really happened, against the key being saved.
    expect(seenKeys).toEqual(["submitted-key-9999"]);
    // The response must never be able to carry the key back out.
    expect(JSON.stringify(submitted)).not.toContain("submitted-key-9999");
  });

  it("refuses a second key for the same provider, because that is a rotation", async () => {
    // Two credentials for one provider on one project have no way to be told
    // apart and no meaning in the relay, which reads the default.
    await expect(
      submitRpcConnection(serviceContext(PROJECT_ID_2), {
        provider: "helius",
        scope: "project",
        credentialLabel: "Second one",
        endpointUrl: endpointBase,
        apiKey: "second-key-0000",
      })
    ).rejects.toThrow(/already has a connection for this provider/i);
  });

  it("stores a second provider alongside, proven but not serving", async () => {
    // The point of the marketplace: keys in several providers, one carrying
    // traffic, switching without throwing a working key away.
    const alongside = await submitRpcConnection(serviceContext(PROJECT_ID_2), {
      provider: "alchemy",
      scope: "project",
      credentialLabel: "Alchemy alongside Helius",
      endpointUrl: endpointBase,
      apiKey: "alongside-key-1111",
    });

    // Proven on save like any other, so it can be switched to immediately.
    expect(alongside.status).toBe("active");
    expect(alongside.providerCredential.status).toBe("active");
    // ...but it must not have taken traffic off the incumbent by appearing.
    expect(alongside.isDefault).toBe(false);

    const state = await new RpcConnectionStore(getDb(env)).findScopeConnectionState({
      organizationId: ORG_ID,
      scopeKey: PROJECT_ID_2,
      network: "devnet",
    });
    expect(state.kind).toBe("active");
  });

  it("stores nothing when the provider rejects the key on save", async () => {
    // The stand-in answers 401 for this one pass, which is what a wrong key
    // looks like. Nothing may be written on the way out.
    rejectNextProbe = true;
    await expect(
      submitRpcConnection(serviceContext(PROJECT_ID_3), {
        provider: "helius",
        scope: "project",
        credentialLabel: "Never stored",
        endpointUrl: endpointBase,
        apiKey: "rejected-key-1111",
      })
    ).rejects.toThrow(/rejected this connection/i);

    const stored = await getDb(appEnv)
      .prepare("SELECT COUNT(*)::int AS count FROM provider_credentials WHERE label = ?")
      .bind("Never stored")
      .first<{ count: number }>();
    expect(stored?.count).toBe(0);
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

    expect(target.selectionMode).toBe("project_connection");
    expect(target.connectionId).toBe(CONNECTION_ID);
    expect(target.endpoint).toContain(encodeURIComponent(TENANT_KEY));
    // The label is what surfaces to callers, and it must not carry the key.
    expect(target.endpointLabel).not.toContain(TENANT_KEY);

    // And the endpoint genuinely works: reach it the way the relay does.
    seenKeys = [];
    const upstream = await fetch(target.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...target.headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "getGenesisHash", params: [] }),
    });

    expect(upstream.ok).toBe(true);
    expect(seenKeys).toEqual([TENANT_KEY]);
  });

  it("fails closed once a live connection stops passing its check", async () => {
    // Not a draft: this organization's traffic was on its own key, so moving it
    // back onto SDP's without saying so is the thing being prevented.
    const failed = await new RpcConnectionStore(getDb(appEnv)).markCheckFailed({
      organizationId: ORG_ID,
      connectionId: CONNECTION_ID,
      providerCredentialId: CREDENTIAL_ID,
      scopeKeys: [PROJECT_ID],
    });

    expect(failed).toBe(1);
    await expect(resolveRpcTarget(relayInput())).rejects.toThrow(/not active/i);
  });

  it("drops a probe verdict that lost a race with a rotation", async () => {
    // A probe is a network call, so a rotation can commit while one is in
    // flight. Writing the old verdict onto the connection anyway marked a
    // freshly rotated, working key failed and cleared it out of the default
    // slot, which fails the project closed over a key that no longer exists.
    // This suite is a narrative on one row, so put it back to serving first.
    await getDb(appEnv)
      .prepare(`UPDATE rpc_connections SET status = 'active', is_default = TRUE WHERE id = ?`)
      .bind(CONNECTION_ID)
      .run();

    const store = new RpcConnectionStore(getDb(appEnv));
    const failed = await store.markCheckFailed({
      organizationId: ORG_ID,
      connectionId: CONNECTION_ID,
      providerCredentialId: "pcred_rotated_away",
      scopeKeys: [PROJECT_ID],
    });

    expect(failed).toBe(0);
    // Still serving, because the verdict was about a credential this
    // connection no longer points at.
    await expect(resolveRpcTarget(relayInput())).resolves.toBeTruthy();
  });

  it("recovers on re-activation rather than requiring a new connection", async () => {
    const reactivated = await activateRpcConnection(serviceContext(), CONNECTION_ID, {
      makeDefault: true,
    });

    expect(reactivated.status).toBe("active");
    const target = await resolveRpcTarget(relayInput());
    expect(target.connectionId).toBe(CONNECTION_ID);
  });

  it("swaps the key on rotation and keeps serving throughout", async () => {
    seenKeys = [];
    const rotated = await rotateRpcConnection(serviceContext(), CONNECTION_ID, {
      endpointUrl: endpointBase,
      apiKey: "rotated-key-2222",
    });

    // The new key was proven before anything was written.
    expect(seenKeys).toEqual(["rotated-key-2222"]);
    expect(rotated.status).toBe("active");
    expect(rotated.providerCredential.id).not.toBe(CREDENTIAL_ID);
    expect(JSON.stringify(rotated)).not.toContain("rotated-key-2222");

    // The connection never stopped resolving, and it resolves on the new key.
    seenKeys = [];
    const target = await resolveRpcTarget(relayInput());
    await fetch(target.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...target.headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "getGenesisHash", params: [] }),
    });
    expect(seenKeys).toEqual(["rotated-key-2222"]);
  });

  it("refuses a rotation whose credential has already been replaced", async () => {
    // Two rotations racing each other read the same previous credential. The
    // compare-and-swap is what stops the loser committing over the winner and
    // leaving a live credential nothing points at.
    const store = new RpcConnectionStore(getDb(appEnv));
    const stale = await store.repointConnectionCredential({
      organizationId: ORG_ID,
      connectionId: CONNECTION_ID,
      scopeKeys: [PROJECT_ID],
      expectedCredentialId: CREDENTIAL_ID,
      nextCredentialId: "pcred_should_never_land",
      nextCredentialScopeKey: PROJECT_ID,
    });

    expect(stale).toBeNull();
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
