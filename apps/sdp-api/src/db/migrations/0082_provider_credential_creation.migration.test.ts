import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

describe("0082 Provider Credential creation", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await getDb(env).execute(
      `INSERT INTO organizations (id, name, slug, tier, status)
       VALUES ('org_creation', 'Creation', 'creation', 'enterprise', 'active')`
    );
  });

  it("reserves a GCP location before a version exists, then retains abandoned root cleanup", async () => {
    await getDb(env).execute(
      `INSERT INTO provider_credentials (
         id, organization_id, provider, label, scope, source, storage_backend,
         secret_ref, status
       ) VALUES (
         'pcred_creation', 'org_creation', 'privy', 'Privy', 'organization', 'stored',
         'gcp_secret_manager', 'projects/p/secrets/sdp-provider-credentials-pcred_creation',
         'creating'
       )`
    );
    await expect(
      getDb(env).execute(
        `UPDATE provider_credentials
         SET status = 'deactivated', deactivated_at = sdp_iso_now(),
             last_failure_code = 'secret_creation_abandoned',
             secret_retention_expires_at = sdp_iso_now()
         WHERE id = 'pcred_creation'`
      )
    ).resolves.toBe(1);
  });

  it("does not permit cleanup markers on unrelated deactivated GCP roots", async () => {
    await expect(
      getDb(env).execute(
        `INSERT INTO provider_credentials (
           id, organization_id, provider, label, scope, source, storage_backend,
           secret_ref, status, deactivated_at, secret_retention_expires_at
         ) VALUES (
           'pcred_unrelated', 'org_creation', 'privy', 'Privy', 'organization', 'stored',
           'gcp_secret_manager', 'projects/p/secrets/unrelated',
           'deactivated', sdp_iso_now(), sdp_iso_now()
         )`
      )
    ).rejects.toThrow(/provider_credentials_secret_retention_check/);
  });

  it.each([
    "storage_backend = 'encrypted_db', secret_ref = NULL, encrypted_secret_payload = 'v2.payload'",
    "source = 'runtime', storage_backend = 'runtime_env', secret_ref = NULL",
    "secret_version_ref = 'projects/p/secrets/creation/versions/7'",
  ])("restricts creating to a stored GCP location without a version: %s", async (change) => {
    await getDb(env).execute(
      `INSERT INTO provider_credentials (
         id, organization_id, provider, label, scope, source, storage_backend,
         secret_ref, status
       ) VALUES ('pcred_creating_constraint', 'org_creation', 'privy', 'Privy',
         'organization', 'stored', 'gcp_secret_manager', 'projects/p/secrets/creation', 'creating')`
    );
    await expect(
      getDb(env).execute(
        `UPDATE provider_credentials SET ${change} WHERE id = 'pcred_creating_constraint'`
      )
    ).rejects.toThrow(/provider_credentials_creating_location_check/);
  });
});
