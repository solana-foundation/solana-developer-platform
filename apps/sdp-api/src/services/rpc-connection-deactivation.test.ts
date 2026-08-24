import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { getLogger } from "@/runtime/logger";
import * as credentialSecretStore from "@/services/credential-secret-store";
import {
  type activateRpcConnection,
  deactivateRpcConnection,
} from "@/services/rpc-connection.service";
import { RpcConnectionStore } from "@/services/stores/rpc-connection.store";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";

const appEnv = env as Env;
const ORG_ID = "org_rpc_deactivation";
const USER_ID = "user_rpc_deactivation";
const CREDENTIAL_ID = "pcred_rpc_deactivation";
const CONNECTION_ID = "rconn_rpc_deactivation";
const SECRET_VERSION_REF = "projects/p/secrets/sdp-provider-credentials-x/versions/3";

const destroyVersion = vi.fn().mockResolvedValue(undefined);

let originalEncryptionKey: string | undefined;

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

async function seedActiveConnection(
  connectionId: string,
  credentialId: string,
  backend: "gcp_secret_manager" | "encrypted_db" = "gcp_secret_manager"
): Promise<void> {
  const db = getDb(appEnv);
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
      credentialId,
      ORG_ID,
      backend,
      backend === "gcp_secret_manager" ? "projects/p/secrets/sdp-provider-credentials-x" : null,
      backend === "gcp_secret_manager" ? SECRET_VERSION_REF : null,
      backend === "encrypted_db" ? "v2.stored-ciphertext" : null,
      USER_ID
    )
    .run();

  const connections = new RpcConnectionStore(db);
  await connections.insertConnection({
    id: connectionId,
    organizationId: ORG_ID,
    projectId: null,
    provider: "helius",
    providerCredentialId: credentialId,
    providerCredentialScopeKey: "__organization__",
    network: "devnet",
    displayMetadata: { endpointHost: "127.0.0.1", apiKeySuffix: "1234" },
    createdBy: USER_ID,
  });
  await connections.activateConnection({
    organizationId: ORG_ID,
    connectionId,
    scopeKeys: ["__organization__"],
    makeDefault: false,
  });
}

beforeAll(async () => {
  await seedTestDatabase(appEnv as Parameters<typeof seedTestDatabase>[0]);

  originalEncryptionKey = appEnv.CUSTODY_ENCRYPTION_KEY;
  appEnv.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  vi.spyOn(credentialSecretStore, "createCredentialSecretStore").mockReturnValue({
    storageBackend: "gcp_secret_manager",
    write: vi.fn(),
    read: vi.fn(),
    destroyVersion,
  } as unknown as credentialSecretStore.CredentialSecretStore);

  const db = getDb(appEnv);
  await db
    .prepare(
      `INSERT INTO organizations (id, name, slug, tier, status)
       VALUES (?, 'RPC Deactivation', 'rpc-deactivation', 'enterprise', 'active')`
    )
    .bind(ORG_ID)
    .run();
  await db
    .prepare(
      `INSERT INTO users (id, email, email_verified, status)
       VALUES (?, 'rpc-deactivation@example.com', 1, 'active')`
    )
    .bind(USER_ID)
    .run();
});

afterAll(() => {
  appEnv.CUSTODY_ENCRYPTION_KEY = originalEncryptionKey;
  vi.restoreAllMocks();
});

describe("deactivateRpcConnection", () => {
  it("destroys the stored secret version so a withdrawn credential stops existing", async () => {
    await seedActiveConnection(CONNECTION_ID, CREDENTIAL_ID);

    const result = await deactivateRpcConnection(serviceContext(), CONNECTION_ID);

    expect(result.status).toBe("deactivated");
    expect(destroyVersion).toHaveBeenCalledWith({ secretVersionRef: SECRET_VERSION_REF });
  });

  it("marks the provider credential deactivated alongside the connection", async () => {
    const connectionId = `${CONNECTION_ID}_cred`;
    const credentialId = `${CREDENTIAL_ID}_cred`;
    await seedActiveConnection(connectionId, credentialId);

    const result = await deactivateRpcConnection(serviceContext(), connectionId);

    expect(result.providerCredential.status).toBe("deactivated");
    const row = await getDb(appEnv)
      .prepare(`SELECT status FROM provider_credentials WHERE id = ?`)
      .bind(credentialId)
      .first<{ status: string }>();
    expect(row?.status).toBe("deactivated");
  });

  it("clears the stored ciphertext for an encrypted_db credential", async () => {
    const connectionId = `${CONNECTION_ID}_db`;
    const credentialId = `${CREDENTIAL_ID}_db`;
    await seedActiveConnection(connectionId, credentialId, "encrypted_db");
    destroyVersion.mockClear();

    const result = await deactivateRpcConnection(serviceContext(), connectionId);

    expect(result.status).toBe("deactivated");
    expect(destroyVersion).not.toHaveBeenCalled();
    const row = await getDb(appEnv)
      .prepare(`SELECT status, encrypted_secret_payload FROM provider_credentials WHERE id = ?`)
      .bind(credentialId)
      .first<{ status: string; encrypted_secret_payload: string | null }>();
    expect(row?.status).toBe("deactivated");
    expect(row?.encrypted_secret_payload).toBeNull();
  });

  it("still deactivates and logs the orphan risk when destroying the secret version fails", async () => {
    const connectionId = `${CONNECTION_ID}_orphan`;
    const credentialId = `${CREDENTIAL_ID}_orphan`;
    await seedActiveConnection(connectionId, credentialId);
    destroyVersion.mockRejectedValueOnce(new Error("gcp unavailable"));
    const logError = vi.spyOn(getLogger(), "error");

    const result = await deactivateRpcConnection(serviceContext(), connectionId);

    expect(result.status).toBe("deactivated");
    const row = await getDb(appEnv)
      .prepare(`SELECT status FROM provider_credentials WHERE id = ?`)
      .bind(credentialId)
      .first<{ status: string }>();
    expect(row?.status).toBe("deactivated");
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ provider_credential_id: credentialId }),
      "rpc_connection_secret_orphan_risk"
    );
  });

  it("rolls back the connection flip when the credential cannot be deactivated", async () => {
    const connectionId = `${CONNECTION_ID}_torn`;
    const credentialId = `${CREDENTIAL_ID}_torn`;
    await seedActiveConnection(connectionId, credentialId);
    await getDb(appEnv)
      .prepare(
        `UPDATE provider_credentials
            SET status = 'deactivated', deactivated_at = sdp_iso_now()
          WHERE id = ?`
      )
      .bind(credentialId)
      .run();

    await expect(deactivateRpcConnection(serviceContext(), connectionId)).rejects.toThrow();

    const row = await getDb(appEnv)
      .prepare(`SELECT status FROM rpc_connections WHERE id = ?`)
      .bind(connectionId)
      .first<{ status: string }>();
    expect(row?.status).toBe("active");
  });

  it("refuses a second deactivation", async () => {
    const connectionId = `${CONNECTION_ID}_repeat`;
    await seedActiveConnection(connectionId, `${CREDENTIAL_ID}_repeat`);

    await deactivateRpcConnection(serviceContext(), connectionId);

    await expect(deactivateRpcConnection(serviceContext(), connectionId)).rejects.toThrow(
      /already deactivated/i
    );
  });
});
