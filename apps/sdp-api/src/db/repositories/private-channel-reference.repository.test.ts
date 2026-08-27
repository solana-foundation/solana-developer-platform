import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { PrivateChannelReferenceRepository } from "./private-channel-reference.repository";
import { createPostgresPrivateChannelReferenceRepository } from "./private-channel-reference.repository.postgres";

const TEST_PROJECT_ID = "prj_pcref_repo_test";
const TEST_INSTANCE_ID = "pci_pcref_repo_test";
const CHANNEL_A = "pch_pcref_a";
const CHANNEL_B = "pch_pcref_b";
const CHANNEL_ARCHIVED = "pch_pcref_archived";
const PCU_A = "pcu_pcref_a";
const PCU_B = "pcu_pcref_b";
const USER_B = "usr_pcref_b";
const CUSTODY_CONFIG_ID = "ccfg_pcref_test";
const CUSTODY_WALLET_ROW_ID = "cwlt_pcref_test";
const WALLET_ID = "wallet_pcref_treasury";
const PUBLIC_KEY = "TreasuryPubkey1111111111111111111111111";
const BLANK_LABEL_WALLET_ROW_ID = "cwlt_pcref_blank";
const BLANK_LABEL_WALLET_ID = "wallet_pcref_blank";
const BLANK_LABEL_PUBLIC_KEY = "BlankLabelPubkey11111111111111111111";
const ISSUED_TOKEN_ID = "tok_pcref_test";
const ISSUED_TOKEN_MINT = "IssuedMint1111111111111111111111111111";
const UNDEPLOYED_TOKEN_ID = "tok_pcref_undeployed";

describe("PrivateChannelReferenceRepository (postgres)", () => {
  let repo: PrivateChannelReferenceRepository;

  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);

    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();

    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, name, email_verified, status) VALUES (?, ?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email, "Ada Lovelace")
      .run();

    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, name, email_verified, status) VALUES (?, ?, NULL, 1, 'active')"
      )
      .bind(USER_B, "bob@example.com")
      .run();

    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Test Project', 'test-project', 'sandbox', 'active', ?)`
      )
      .bind(TEST_PROJECT_ID, TEST_ORG.id, TEST_USER.id)
      .run();

    await db
      .prepare(
        `INSERT INTO private_channel_instances
           (id, organization_id, project_id, gateway_url,
            escrow_program_id, withdraw_program_id, escrow_instance_addr, auth_url, is_active)
         VALUES (?, ?, ?, 'http://gw', 'prog1', 'prog2', 'escrow1', 'http://auth', true)`
      )
      .bind(TEST_INSTANCE_ID, TEST_ORG.id, TEST_PROJECT_ID)
      .run();

    await db
      .prepare(
        `INSERT INTO private_channels
           (id, organization_id, project_id, instance_id, name, is_default, status)
         VALUES
           (?, ?, ?, ?, 'Treasury', true, 'active'),
           (?, ?, ?, ?, 'Payroll', false, 'active'),
           (?, ?, ?, ?, 'Archived Ops', false, 'archived')`
      )
      .bind(
        CHANNEL_A,
        TEST_ORG.id,
        TEST_PROJECT_ID,
        TEST_INSTANCE_ID,
        CHANNEL_B,
        TEST_ORG.id,
        TEST_PROJECT_ID,
        TEST_INSTANCE_ID,
        CHANNEL_ARCHIVED,
        TEST_ORG.id,
        TEST_PROJECT_ID,
        TEST_INSTANCE_ID
      )
      .run();

    await db
      .prepare(
        `INSERT INTO private_channel_users (id, organization_id, project_id, user_id)
         VALUES (?, ?, ?, ?), (?, ?, ?, ?)`
      )
      .bind(
        PCU_A,
        TEST_ORG.id,
        TEST_PROJECT_ID,
        TEST_USER.id,
        PCU_B,
        TEST_ORG.id,
        TEST_PROJECT_ID,
        USER_B
      )
      .run();

    await db
      .prepare(
        `INSERT INTO private_channel_memberships (id, channel_id, private_channel_user_id)
         VALUES
           ('pcm_pcref_a_a', ?, ?),
           ('pcm_pcref_b_b', ?, ?)`
      )
      .bind(CHANNEL_A, PCU_A, CHANNEL_B, PCU_B)
      .run();

    await db
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, ?, 'local', 'encrypted', 'active')`
      )
      .bind(CUSTODY_CONFIG_ID, TEST_ORG.id, TEST_PROJECT_ID)
      .run();

    await db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES
           (?, ?, ?, ?, 'Treasury Wallet', 'transfer', 'active'),
           (?, ?, ?, ?, '', 'transfer', 'active')`
      )
      .bind(
        CUSTODY_WALLET_ROW_ID,
        CUSTODY_CONFIG_ID,
        WALLET_ID,
        PUBLIC_KEY,
        BLANK_LABEL_WALLET_ROW_ID,
        CUSTODY_CONFIG_ID,
        BLANK_LABEL_WALLET_ID,
        BLANK_LABEL_PUBLIC_KEY
      )
      .run();

    await db
      .prepare(
        `INSERT INTO issued_tokens
           (id, project_id, organization_id, mint_address, name, symbol, decimals, status, created_by)
         VALUES
           (?, ?, ?, ?, 'Issued Test Token', 'ITT', 6, 'active', ?),
           (?, ?, ?, NULL, 'Pending Token', 'PND', 6, 'pending', ?)`
      )
      .bind(
        ISSUED_TOKEN_ID,
        TEST_PROJECT_ID,
        TEST_ORG.id,
        ISSUED_TOKEN_MINT,
        TEST_USER.id,
        UNDEPLOYED_TOKEN_ID,
        TEST_PROJECT_ID,
        TEST_ORG.id,
        TEST_USER.id
      )
      .run();

    repo = createPostgresPrivateChannelReferenceRepository(db);
  });

  it("returns channels, wallets, members, instances, and tokens for a full viewer", async () => {
    const rows = await repo.listReferences({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      walletScope: { scope: "all" },
      viewer: { scope: "all" },
    });

    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));

    expect(byKey[CHANNEL_A]).toEqual({ kind: "channel", key: CHANNEL_A, name: "Treasury" });
    expect(byKey[CHANNEL_B]).toEqual({ kind: "channel", key: CHANNEL_B, name: "Payroll" });
    expect(byKey[CHANNEL_ARCHIVED]).toEqual({
      kind: "channel",
      key: CHANNEL_ARCHIVED,
      name: "Archived Ops",
    });

    expect(byKey[PUBLIC_KEY]).toEqual({
      kind: "wallet",
      key: PUBLIC_KEY,
      name: "Treasury Wallet",
    });
    expect(byKey[WALLET_ID]).toEqual({
      kind: "wallet",
      key: WALLET_ID,
      name: "Treasury Wallet",
    });
    expect(byKey[BLANK_LABEL_PUBLIC_KEY]).toEqual({
      kind: "wallet",
      key: BLANK_LABEL_PUBLIC_KEY,
      name: BLANK_LABEL_WALLET_ID,
    });

    expect(byKey[PCU_A]).toEqual({ kind: "member", key: PCU_A, name: "Ada Lovelace" });
    expect(byKey[TEST_USER.id]).toEqual({
      kind: "member",
      key: TEST_USER.id,
      name: "Ada Lovelace",
    });
    expect(byKey[PCU_B]).toEqual({ kind: "member", key: PCU_B, name: "bob@example.com" });
    expect(byKey[USER_B]).toEqual({ kind: "member", key: USER_B, name: "bob@example.com" });

    expect(byKey[TEST_INSTANCE_ID]).toEqual({
      kind: "instance",
      key: TEST_INSTANCE_ID,
      name: "http://gw",
    });

    expect(byKey[ISSUED_TOKEN_MINT]).toEqual({
      kind: "token",
      key: ISSUED_TOKEN_MINT,
      name: "ITT",
    });
    // A token without a mint has nothing to key on.
    expect(rows.some((row) => row.kind === "token" && row.name === "PND")).toBe(false);
  });

  it("narrows channels and members for a member viewer", async () => {
    const rows = await repo.listReferences({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      walletScope: { scope: "all" },
      viewer: { scope: "member", channelIds: [CHANNEL_A], userId: TEST_USER.id },
    });

    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));

    expect(byKey[CHANNEL_A]?.name).toBe("Treasury");
    expect(byKey[CHANNEL_B]).toBeUndefined();
    expect(byKey[CHANNEL_ARCHIVED]).toBeUndefined();

    // Wallet labels stay visible — wallets:read is already held by members.
    expect(byKey[PUBLIC_KEY]?.name).toBe("Treasury Wallet");
    expect(byKey[WALLET_ID]?.name).toBe("Treasury Wallet");

    // Token symbols and the visible instance resolve for channel members.
    expect(byKey[ISSUED_TOKEN_MINT]?.name).toBe("ITT");
    expect(byKey[TEST_INSTANCE_ID]?.name).toBe("http://gw");

    // Viewer themselves resolve; co-member on CHANNEL_B does not.
    expect(byKey[PCU_A]?.name).toBe("Ada Lovelace");
    expect(byKey[TEST_USER.id]?.name).toBe("Ada Lovelace");
    expect(byKey[PCU_B]).toBeUndefined();
    expect(byKey[USER_B]).toBeUndefined();
  });

  it("omits wallet labels when the caller cannot read wallets", async () => {
    const rows = await repo.listReferences({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      walletScope: { scope: "none" },
      viewer: { scope: "member", channelIds: [CHANNEL_A], userId: TEST_USER.id },
    });

    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
    expect(byKey[PUBLIC_KEY]).toBeUndefined();
    expect(byKey[WALLET_ID]).toBeUndefined();
    expect(byKey[BLANK_LABEL_PUBLIC_KEY]).toBeUndefined();
    // Everything the caller may read still resolves.
    expect(byKey[CHANNEL_A]?.name).toBe("Treasury");
    expect(byKey[ISSUED_TOKEN_MINT]?.name).toBe("ITT");
  });

  it("includes co-members who share a channel with the viewer", async () => {
    const db = getDb(env);
    await db
      .prepare(
        `INSERT INTO private_channel_memberships (id, channel_id, private_channel_user_id)
         VALUES ('pcm_pcref_b_a', ?, ?)`
      )
      .bind(CHANNEL_A, PCU_B)
      .run();

    const rows = await repo.listReferences({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      walletScope: { scope: "all" },
      viewer: { scope: "member", channelIds: [CHANNEL_A], userId: TEST_USER.id },
    });

    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
    expect(byKey[PCU_B]?.name).toBe("bob@example.com");
    expect(byKey[USER_B]?.name).toBe("bob@example.com");
  });

  it("still resolves the viewer when they have no channel memberships", async () => {
    const rows = await repo.listReferences({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      walletScope: { scope: "all" },
      viewer: { scope: "member", channelIds: [], userId: TEST_USER.id },
    });

    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
    expect(byKey[CHANNEL_A]).toBeUndefined();
    expect(byKey[PCU_A]?.name).toBe("Ada Lovelace");
    expect(byKey[TEST_USER.id]?.name).toBe("Ada Lovelace");
    expect(byKey[PUBLIC_KEY]?.name).toBe("Treasury Wallet");
    // A viewer with an empty feed still learns nothing about instances.
    expect(byKey[TEST_INSTANCE_ID]).toBeUndefined();
    expect(byKey[PCU_B]).toBeUndefined();
  });
});
