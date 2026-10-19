import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

describe("0084 Provider Credential container scans", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await getDb(env).execute(
      `INSERT INTO organizations (id, name, slug, tier, status)
       VALUES ('org_scans', 'Scans', 'scans', 'enterprise', 'active')`
    );
    await getDb(env).execute(
      "INSERT INTO users (id, email) VALUES ('usr_scans', 'scans@example.test')"
    );
    await seedDefaultProjects(getDb(env), {
      organizationId: "org_scans",
      createdBy: "usr_scans",
      members: [],
      ids: { sandbox: "prj_scans", production: "prj_scans_production" },
    });
    await getDb(env).execute(
      `INSERT INTO provider_credentials (
         id, organization_id, project_id, provider, label, scope, source, storage_backend,
         secret_ref, secret_version_ref, status, secret_next_scan_at
       ) VALUES ('pcred_scan_owner', 'org_scans', 'prj_scans', 'privy', 'Privy', 'project', 'stored',
         'gcp_secret_manager', 'projects/p/secrets/shared', 'projects/p/secrets/shared/versions/1',
         'pending', clock_timestamp())`
    );
  });

  it("permits shared versions but only one schedule owner per container", async () => {
    await getDb(env).execute(
      `INSERT INTO provider_credentials (
         id, organization_id, project_id, provider, label, scope, source, storage_backend,
         secret_ref, secret_version_ref, status
       ) VALUES ('pcred_scan_child', 'org_scans', 'prj_scans', 'privy', 'Privy', 'project', 'stored',
         'gcp_secret_manager', 'projects/p/secrets/shared', 'projects/p/secrets/shared/versions/2', 'pending')`
    );
    await expect(
      getDb(env).execute(
        "UPDATE provider_credentials SET secret_next_scan_at = clock_timestamp() WHERE id = 'pcred_scan_child'"
      )
    ).rejects.toThrow(/idx_provider_credentials_gcp_scan_owner/);
  });

  it.each(["retired", "deactivated"])(
    "retains scheduling after the owner becomes %s",
    async (status) => {
      await getDb(env).execute(
        "UPDATE provider_credentials SET status = ?, deactivated_at = CASE WHEN ? = 'deactivated' THEN sdp_iso_now() ELSE NULL END WHERE id = 'pcred_scan_owner'",
        [status, status]
      );
      expect(
        await getDb(env).queryOne(
          "SELECT secret_next_scan_at IS NOT NULL AS scheduled FROM provider_credentials WHERE id = 'pcred_scan_owner'"
        )
      ).toEqual({ scheduled: true });
    }
  );

  it.each([
    "provider = 'other'",
    "storage_backend = 'encrypted_db', secret_ref = NULL, secret_version_ref = NULL, encrypted_secret_payload = 'v2.payload'",
    "source = 'runtime', storage_backend = 'runtime_env', secret_ref = NULL, secret_version_ref = NULL",
  ])("rejects a scan owner outside stored Privy GCP credentials: %s", async (change) => {
    await expect(
      getDb(env).execute(`UPDATE provider_credentials SET ${change} WHERE id = 'pcred_scan_owner'`)
    ).rejects.toThrow(/provider_credentials_scan_owner_check/);
  });
});
