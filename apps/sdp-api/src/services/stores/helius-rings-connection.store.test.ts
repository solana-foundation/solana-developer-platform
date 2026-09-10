import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { HeliusRingsConnectionStore } from "./helius-rings-connection.store";
import { ProviderCredentialStore } from "./provider-credential.store";

const PROJECT_A = "prj_rings_connection_a";
const PROJECT_B = "prj_rings_connection_b";

async function insertConnection(projectId: string, tag: string, makeDefault: boolean) {
  const db = getDb(env);
  const credentialId = `pcred_rings_${tag}`;
  const connectionId = `hrconn_${tag}`;
  const credential = await new ProviderCredentialStore(db).insertCredential({
    id: credentialId,
    organizationId: TEST_ORG.id,
    projectId,
    provider: "helius_rings",
    label: tag,
    scope: "project",
    source: "stored",
    stored: { storageBackend: "encrypted_db", encryptedSecretPayload: `opaque-${tag}` },
    displayMetadata: {},
    version: 1,
    rotatedFromId: null,
    idempotencyKey: connectionId,
    idempotencyFingerprint: connectionId,
    createdBy: TEST_USER.id,
  });
  await db.execute("UPDATE provider_credentials SET status = 'active' WHERE id = ?", [
    credentialId,
  ]);
  return new HeliusRingsConnectionStore(db).insert({
    id: connectionId,
    organizationId: TEST_ORG.id,
    projectId,
    name: tag,
    providerCredentialId: credentialId,
    providerCredentialScopeKey: credential.scope_key,
    allowInsecureHttp: false,
    displayMetadata: { rpcOrigin: "https://rpc.example.test" },
    makeDefault,
    createdBy: TEST_USER.id,
  });
}

describe("HeliusRingsConnectionStore", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await db.execute("INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)", [
      TEST_ORG.id,
      TEST_ORG.name,
      TEST_ORG.slug,
    ]);
    await db.execute("INSERT INTO users (id, email) VALUES (?, ?)", [
      TEST_USER.id,
      TEST_USER.email,
    ]);
    for (const projectId of [PROJECT_A, PROJECT_B]) {
      await db.execute(
        `INSERT INTO projects (id, organization_id, name, slug, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [projectId, TEST_ORG.id, projectId, projectId, TEST_USER.id]
      );
    }
  });

  it("resolves only the active default belonging to the requested project", async () => {
    const connection = await insertConnection(PROJECT_A, "primary", true);
    const store = new HeliusRingsConnectionStore(getDb(env));

    await expect(store.findDefault(TEST_ORG.id, PROJECT_A)).resolves.toMatchObject({
      id: connection.id,
      credential_encrypted_secret_payload: "opaque-primary",
    });
    await expect(store.findById(TEST_ORG.id, PROJECT_B, connection.id)).resolves.toBeNull();
  });

  it("does not clear the current default when the requested replacement is missing", async () => {
    const connection = await insertConnection(PROJECT_A, "current", true);
    const db = getDb(env);

    const result = await db.transaction((tx) =>
      new HeliusRingsConnectionStore(tx).makeDefault(TEST_ORG.id, PROJECT_A, "hrconn_missing")
    );

    expect(result).toBeNull();
    await expect(
      new HeliusRingsConnectionStore(db).findDefault(TEST_ORG.id, PROJECT_A)
    ).resolves.toMatchObject({ id: connection.id });
  });
});
