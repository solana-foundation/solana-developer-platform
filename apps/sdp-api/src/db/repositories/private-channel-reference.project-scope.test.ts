import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import type { PrivateChannelReferenceWalletScope } from "./private-channel-reference.repository";
import { createPostgresPrivateChannelReferenceRepository } from "./private-channel-reference.repository.postgres";

const OWNER_PROJECT_ID = "prj_pcref_scope_owner";
const OTHER_PROJECT_ID = "prj_pcref_scope_owner_production";
const OWNER_CONFIG_ID = "ccfg_pcref_scope_owner";
const OWNER_WALLET = {
  id: "cwlt_pcref_scope_owner",
  walletId: "wallet_pcref_scope_owner",
  publicKey: "ScopeOwnerPubkey111111111111111111111111",
  label: "Owner treasury",
};

const WALLET_SCOPES: PrivateChannelReferenceWalletScope[] = [
  { scope: "all" },
  { scope: "selected", walletIds: [OWNER_WALLET.walletId] },
];

function listWalletReferences(projectId: string, walletScope: PrivateChannelReferenceWalletScope) {
  return createPostgresPrivateChannelReferenceRepository(getDb(env)).listReferences({
    organizationId: TEST_ORG.id,
    projectId,
    walletScope,
    viewer: { scope: "all" },
  });
}

describe("PrivateChannelReferenceRepository wallet project scope (postgres)", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await db.batch([
      db
        .prepare(
          "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
        )
        .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug),
      db
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(TEST_USER.id, TEST_USER.email),
    ]);
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: OWNER_PROJECT_ID, production: OTHER_PROJECT_ID },
    });
    await seedTestCustodyRows(env, {
      configs: [
        {
          id: OWNER_CONFIG_ID,
          organizationId: TEST_ORG.id,
          projectId: OWNER_PROJECT_ID,
          provider: "local",
          configEncrypted: "encrypted",
          status: "active",
        },
      ],
      wallets: [
        {
          id: OWNER_WALLET.id,
          owner: { kind: "config", custodyConfigId: OWNER_CONFIG_ID },
          walletId: OWNER_WALLET.walletId,
          publicKey: OWNER_WALLET.publicKey,
          label: OWNER_WALLET.label,
          purpose: "transfer",
          status: "active",
        },
      ],
    });
  });

  it.each(WALLET_SCOPES)(
    "names a wallet only for the project whose config owns it ($scope scope)",
    async (walletScope) => {
      const ownerReferences = await listWalletReferences(OWNER_PROJECT_ID, walletScope);
      expect([...ownerReferences].sort((left, right) => left.key.localeCompare(right.key))).toEqual(
        [
          { kind: "wallet", key: OWNER_WALLET.publicKey, name: OWNER_WALLET.label },
          { kind: "wallet", key: OWNER_WALLET.walletId, name: OWNER_WALLET.label },
        ].sort((left, right) => left.key.localeCompare(right.key))
      );

      expect(await listWalletReferences(OTHER_PROJECT_ID, walletScope)).toEqual([]);
    }
  );
});
