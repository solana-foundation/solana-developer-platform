/** Custody-lookup helper tests, against real Postgres. */

import { address } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import {
  expectProjectScoped,
  type SeededDefaultProjects,
  seedDefaultProjects,
} from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { custodyWalletForParty } from "./custody-party";

const ALL_WALLETS = { scope: "all" } as const;

const PROJECT_ID = "prj_custody_party_test";
const OTHER_ORG_ID = "org_custody_party_other";
const OTHER_ORG_PROJECT_ID = "prj_other_org";
const CUSTODY_CONFIG_ID = "cust_custody_party_test";
const OTHER_ORG_CONFIG_ID = "cust_custody_party_other_org";

const PARTY_ADDRESS = "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC";
const UNKNOWN_ADDRESS = "9wVmMF2GpxZMsJLxCv2xXWjDWVv8HtqTmKqnZxNKkYTz";

describe("custodyWalletForParty", () => {
  let projects: SeededDefaultProjects;
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
    projects = await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
    });
    await seedDefaultProjects(db, {
      organizationId: OTHER_ORG_ID,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: OTHER_ORG_PROJECT_ID, production: `${OTHER_ORG_PROJECT_ID}_production` },
    });
    await seedTestCustodyRows(env, {
      configs: [
        {
          id: CUSTODY_CONFIG_ID,
          organizationId: TEST_ORG.id,
          projectId: PROJECT_ID,
          provider: "local",
          configEncrypted: "x",
          status: "active",
        },
        {
          id: OTHER_ORG_CONFIG_ID,
          organizationId: OTHER_ORG_ID,
          projectId: OTHER_ORG_PROJECT_ID,
          provider: "local",
          configEncrypted: "x",
          status: "active",
        },
      ],
      wallets: [
        {
          id: "cwlt_party",
          owner: { kind: "config", custodyConfigId: CUSTODY_CONFIG_ID },
          walletId: "w1",
          publicKey: PARTY_ADDRESS,
          label: null,
          purpose: null,
          status: "active",
        },
      ],
    });
  });

  it("returns the active custody wallet whose public key matches the party address", async () => {
    const result = await custodyWalletForParty(
      env,
      { organizationId: TEST_ORG.id, projectId: PROJECT_ID },
      address(PARTY_ADDRESS),
      ALL_WALLETS
    );

    expect(result).toBe("cwlt_party");
  });

  it("returns null for an unknown address", async () => {
    const result = await custodyWalletForParty(
      env,
      { organizationId: TEST_ORG.id, projectId: PROJECT_ID },
      address(UNKNOWN_ADDRESS),
      ALL_WALLETS
    );

    expect(result).toBeNull();
  });

  it("returns null when the address is in the wrong organization", async () => {
    const result = await custodyWalletForParty(
      env,
      { organizationId: OTHER_ORG_ID, projectId: OTHER_ORG_PROJECT_ID },
      address(PARTY_ADDRESS),
      ALL_WALLETS
    );

    expect(result).toBeNull();
  });

  it("returns null when the address is in the wrong project", async () => {
    await expectProjectScoped(
      (projectId) =>
        custodyWalletForParty(
          env,
          { organizationId: TEST_ORG.id, projectId },
          address(PARTY_ADDRESS),
          ALL_WALLETS
        ),
      { own: projects.sandbox, other: projects.production },
      (row) => row === null
    );
  });

  describe("duplicate active records for one address", () => {
    beforeEach(async () => {
      await getDb(env)
        .prepare(
          `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
           VALUES ('cwlt_party_dup', ?, 'w2', ?, 'active')`
        )
        .bind(CUSTODY_CONFIG_ID, PARTY_ADDRESS)
        .run();
    });

    it("returns the oldest for an unrestricted caller", async () => {
      const result = await custodyWalletForParty(
        env,
        { organizationId: TEST_ORG.id, projectId: PROJECT_ID },
        address(PARTY_ADDRESS),
        ALL_WALLETS
      );

      expect(result).toBe("cwlt_party");
    });

    // HOO-2099: a selected key that lists only the newer record funds with
    // it; one that lists neither gets the oldest, for the scope check to refuse.
    it("prefers the record a selected caller lists, else the oldest", async () => {
      const pick = (custodyWalletIds: string[]) =>
        custodyWalletForParty(
          env,
          { organizationId: TEST_ORG.id, projectId: PROJECT_ID },
          address(PARTY_ADDRESS),
          { scope: "selected", custodyWalletIds }
        );

      expect(await pick(["cwlt_party_dup"])).toBe("cwlt_party_dup");
      expect(await pick(["cwlt_party", "cwlt_party_dup"])).toBe("cwlt_party");
      expect(await pick([])).toBe("cwlt_party");
    });

    it("breaks equal creation timestamps by wallet id, regardless of insertion order", async () => {
      await getDb(env)
        .prepare("UPDATE custody_wallets SET created_at = '2020-01-01' WHERE id = 'cwlt_party'")
        .run();
      await getDb(env)
        .prepare(`INSERT INTO custody_wallets
          (id, custody_config_id, wallet_id, public_key, status, created_at)
          VALUES ('cwlt_a_tied', ?, 'w_tied', ?, 'active', '2020-01-01')`)
        .bind(CUSTODY_CONFIG_ID, PARTY_ADDRESS)
        .run();

      expect(
        await custodyWalletForParty(
          env,
          { organizationId: TEST_ORG.id, projectId: PROJECT_ID },
          address(PARTY_ADDRESS),
          ALL_WALLETS
        )
      ).toBe("cwlt_a_tied");
    });
  });

  it("returns null for an archived wallet with a matching address", async () => {
    const db = getDb(env);
    await db
      .prepare("UPDATE custody_wallets SET status = 'archived' WHERE id = 'cwlt_party'")
      .run();

    const result = await custodyWalletForParty(
      env,
      { organizationId: TEST_ORG.id, projectId: PROJECT_ID },
      address(PARTY_ADDRESS),
      ALL_WALLETS
    );

    expect(result).toBeNull();
  });
});
