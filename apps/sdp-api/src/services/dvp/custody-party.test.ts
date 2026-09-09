/** Custody-lookup helper tests, against real Postgres. */

import { address } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { custodyWalletForParty } from "./custody-party";

const PROJECT_ID = "prj_custody_party_test";
const OTHER_PROJECT_ID = "prj_custody_party_other";
const OTHER_ORG_ID = "org_custody_party_other";
const CUSTODY_CONFIG_ID = "cust_custody_party_test";
const OTHER_ORG_CONFIG_ID = "cust_custody_party_other_org";

const PARTY_ADDRESS = "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC";
const UNKNOWN_ADDRESS = "9wVmMF2GpxZMsJLxCv2xXWjDWVv8HtqTmKqnZxNKkYTz";

describe("custodyWalletForParty", () => {
  beforeEach(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
    const db = getDb(env);
    await db.prepare("DELETE FROM custody_wallets").run();
    await db.prepare("DELETE FROM custody_configs").run();
    await db.prepare("DELETE FROM projects").run();

    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(OTHER_ORG_ID, OTHER_ORG_ID, OTHER_ORG_ID)
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    for (const projectId of [PROJECT_ID, OTHER_PROJECT_ID]) {
      await db
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
        )
        .bind(projectId, TEST_ORG.id, projectId, TEST_USER.id)
        .run();
    }
    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Other Org Project', ?, 'sandbox', 'active', ?)`
      )
      .bind("prj_other_org", OTHER_ORG_ID, "prj_other_org", TEST_USER.id)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, ?, 'local', 'x', 'active')`
      )
      .bind(CUSTODY_CONFIG_ID, TEST_ORG.id, PROJECT_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, provider, config_encrypted, status)
         VALUES (?, ?, 'local', 'x', 'active')`
      )
      .bind(OTHER_ORG_CONFIG_ID, OTHER_ORG_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES ('cwlt_party', ?, 'w1', ?, 'active')`
      )
      .bind(CUSTODY_CONFIG_ID, PARTY_ADDRESS)
      .run();
  });

  it("returns the active custody wallet whose public key matches the party address", async () => {
    const result = await custodyWalletForParty(
      env,
      { organizationId: TEST_ORG.id, projectId: PROJECT_ID },
      address(PARTY_ADDRESS)
    );

    expect(result).toBe("cwlt_party");
  });

  it("returns null for an unknown address", async () => {
    const result = await custodyWalletForParty(
      env,
      { organizationId: TEST_ORG.id, projectId: PROJECT_ID },
      address(UNKNOWN_ADDRESS)
    );

    expect(result).toBeNull();
  });

  it("returns null when the address is in the wrong organization", async () => {
    const result = await custodyWalletForParty(
      env,
      { organizationId: OTHER_ORG_ID, projectId: "prj_other_org" },
      address(PARTY_ADDRESS)
    );

    expect(result).toBeNull();
  });

  it("returns null when the address is in the wrong project", async () => {
    const result = await custodyWalletForParty(
      env,
      { organizationId: TEST_ORG.id, projectId: OTHER_PROJECT_ID },
      address(PARTY_ADDRESS)
    );

    expect(result).toBeNull();
  });

  it("returns null for an archived wallet with a matching address", async () => {
    const db = getDb(env);
    await db
      .prepare("UPDATE custody_wallets SET status = 'archived' WHERE id = 'cwlt_party'")
      .run();

    const result = await custodyWalletForParty(
      env,
      { organizationId: TEST_ORG.id, projectId: PROJECT_ID },
      address(PARTY_ADDRESS)
    );

    expect(result).toBeNull();
  });
});
