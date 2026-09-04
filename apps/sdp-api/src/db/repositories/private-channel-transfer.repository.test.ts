import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  type CreatePrivateChannelTransferInput,
  mapPrivateChannelTransferRow,
  type PrivateChannelTransferRepository,
} from "./private-channel-transfer.repository";
import { createPostgresPrivateChannelTransferRepository } from "./private-channel-transfer.repository.postgres";

const TEST_PROJECT_ID = "prj_pct_repo_test";
const OTHER_PROJECT_ID = "prj_pct_repo_other";
const TEST_INSTANCE_ID = "pci_pct_repo_test";
const OTHER_INSTANCE_ID = "pci_pct_repo_other";
const CHANNEL_A_ID = "pch_pct_repo_a";
const CHANNEL_B_ID = "pch_pct_repo_b";
const OTHER_CHANNEL_ID = "pch_pct_repo_other";
const SENDER_PC_USER_ID = "pcu_pct_repo_sender";
const RECIPIENT_PC_USER_ID = "pcu_pct_repo_recipient";
const NON_MEMBER_PC_USER_ID = "pcu_pct_repo_non_member";
const RECIPIENT_USER_ID = "usr_pct_repo_recipient";
const NON_MEMBER_USER_ID = "usr_pct_repo_non_member";
const RECIPIENT_WALLET_A_ID = "pcvw_pct_repo_recipient_a";
const RECIPIENT_WALLET_B_ID = "pcvw_pct_repo_recipient_b";

const SENDER = "Sender1111111111111111111111111111111111111";
const RECIPIENT = "Recipient1111111111111111111111111111111111";
const MINT = "Mint11111111111111111111111111111111111111";

const SCOPE = {
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT_ID,
};

function makeInput(
  overrides: Partial<CreatePrivateChannelTransferInput> = {}
): CreatePrivateChannelTransferInput {
  return {
    ...SCOPE,
    instanceId: TEST_INSTANCE_ID,
    channelId: CHANNEL_A_ID,
    senderPrivateChannelUserId: SENDER_PC_USER_ID,
    recipientPrivateChannelUserId: RECIPIENT_PC_USER_ID,
    senderWalletId: "wal_pct_sender",
    recipientVerifiedWalletId: RECIPIENT_WALLET_A_ID,
    sender: SENDER,
    recipient: RECIPIENT,
    mint: MINT,
    amount: "12.34",
    ...overrides,
  };
}

describe("PrivateChannelTransferRepository (postgres)", () => {
  let repo: PrivateChannelTransferRepository;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM private_channel_transfers").run();
    await db.prepare("DELETE FROM private_channel_verified_wallets").run();
    await db.prepare("DELETE FROM private_channel_memberships").run();
    await db.prepare("DELETE FROM private_channel_users").run();
    await db.prepare("DELETE FROM private_channels").run();
    await db.prepare("DELETE FROM private_channel_instances").run();
    await db.prepare("DELETE FROM projects").run();
    await db.prepare("DELETE FROM users").run();
    await db.prepare("DELETE FROM organizations").run();

    await db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();

    const users = [
      [TEST_USER.id, TEST_USER.email, "Sender User"],
      [RECIPIENT_USER_ID, "recipient@example.com", "Recipient User"],
      [NON_MEMBER_USER_ID, "non-member@example.com", null],
    ] as const;
    for (const [id, email, name] of users) {
      await db
        .prepare(
          "INSERT INTO users (id, email, email_verified, name, status) VALUES (?, ?, 1, ?, 'active')"
        )
        .bind(id, email, name)
        .run();
    }

    for (const projectId of [TEST_PROJECT_ID, OTHER_PROJECT_ID]) {
      await db
        .prepare(
          `INSERT INTO projects (
             id, organization_id, name, slug, environment, status, created_by
           ) VALUES (?, ?, 'Transfer Repo Test', ?, 'sandbox', 'active', ?)`
        )
        .bind(projectId, TEST_ORG.id, projectId, TEST_USER.id)
        .run();
    }

    await db
      .prepare(
        `INSERT INTO custody_configs (
           id, organization_id, project_id, provider, config_encrypted
         ) VALUES ('cc_pct_repo_test', ?, ?, 'local', 'encrypted-test-config')`
      )
      .bind(TEST_ORG.id, TEST_PROJECT_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_wallets (
           id, custody_config_id, wallet_id, public_key, label
         ) VALUES
           ('cw_pct_sender', 'cc_pct_repo_test', 'wal_pct_sender', ?, 'Treasury'),
           ('cw_pct_recipient_a', 'cc_pct_repo_test', 'wal_pct_recipient_a', ?, 'Operations'),
           ('cw_pct_recipient_b', 'cc_pct_repo_test', 'wal_pct_recipient_b', ?, NULL)`
      )
      .bind(SENDER, RECIPIENT, "RecipientTwo11111111111111111111111111111111")
      .run();

    await db
      .prepare(
        `INSERT INTO private_channel_instances (
           id, organization_id, project_id, gateway_url,
           escrow_program_id, withdraw_program_id, escrow_instance_addr, auth_url, is_active
         ) VALUES
           (?, ?, ?, 'https://gateway.example',
            'escrow_program', 'withdraw_program', 'escrow_instance', 'https://auth.example', TRUE),
           (?, ?, ?, 'https://other-gateway.example',
            'other_escrow_program', 'other_withdraw_program', 'other_escrow_instance',
            'https://other-auth.example', TRUE)`
      )
      .bind(
        TEST_INSTANCE_ID,
        TEST_ORG.id,
        TEST_PROJECT_ID,
        OTHER_INSTANCE_ID,
        TEST_ORG.id,
        OTHER_PROJECT_ID
      )
      .run();

    await db
      .prepare(
        `INSERT INTO private_channels (
           id, organization_id, project_id, instance_id, name, status
         ) VALUES
           (?, ?, ?, ?, 'Channel A', 'active'),
           (?, ?, ?, ?, 'Channel B', 'active'),
           (?, ?, ?, ?, 'Other Channel', 'active')`
      )
      .bind(
        CHANNEL_A_ID,
        TEST_ORG.id,
        TEST_PROJECT_ID,
        TEST_INSTANCE_ID,
        CHANNEL_B_ID,
        TEST_ORG.id,
        TEST_PROJECT_ID,
        TEST_INSTANCE_ID,
        OTHER_CHANNEL_ID,
        TEST_ORG.id,
        OTHER_PROJECT_ID,
        OTHER_INSTANCE_ID
      )
      .run();

    const privateChannelUsers = [
      [SENDER_PC_USER_ID, TEST_USER.id],
      [RECIPIENT_PC_USER_ID, RECIPIENT_USER_ID],
      [NON_MEMBER_PC_USER_ID, NON_MEMBER_USER_ID],
    ] as const;
    for (const [privateChannelUserId, userId] of privateChannelUsers) {
      await db
        .prepare(
          `INSERT INTO private_channel_users (id, organization_id, project_id, user_id)
           VALUES (?, ?, ?, ?)`
        )
        .bind(privateChannelUserId, TEST_ORG.id, TEST_PROJECT_ID, userId)
        .run();
    }

    await db
      .prepare(
        `INSERT INTO private_channel_memberships (id, channel_id, private_channel_user_id)
         VALUES
           ('pcm_pct_sender', ?, ?),
           ('pcm_pct_recipient', ?, ?)`
      )
      .bind(CHANNEL_A_ID, SENDER_PC_USER_ID, CHANNEL_A_ID, RECIPIENT_PC_USER_ID)
      .run();

    await db
      .prepare(
        `INSERT INTO private_channel_verified_wallets (
           id, organization_id, project_id, user_id, instance_id, wallet_id, pubkey
         ) VALUES
           ('pcvw_pct_sender', ?, ?, ?, ?, 'wal_pct_sender', ?),
           (?, ?, ?, ?, ?, 'wal_pct_recipient_a', ?),
           (?, ?, ?, ?, ?, 'wal_pct_recipient_b', ?),
           ('pcvw_pct_non_member', ?, ?, ?, ?, 'wal_pct_non_member', ?)`
      )
      .bind(
        TEST_ORG.id,
        TEST_PROJECT_ID,
        SENDER_PC_USER_ID,
        TEST_INSTANCE_ID,
        SENDER,
        RECIPIENT_WALLET_A_ID,
        TEST_ORG.id,
        TEST_PROJECT_ID,
        RECIPIENT_PC_USER_ID,
        TEST_INSTANCE_ID,
        RECIPIENT,
        RECIPIENT_WALLET_B_ID,
        TEST_ORG.id,
        TEST_PROJECT_ID,
        RECIPIENT_PC_USER_ID,
        TEST_INSTANCE_ID,
        "RecipientTwo11111111111111111111111111111111",
        TEST_ORG.id,
        TEST_PROJECT_ID,
        NON_MEMBER_PC_USER_ID,
        TEST_INSTANCE_ID,
        "NonMember111111111111111111111111111111111"
      )
      .run();

    repo = createPostgresPrivateChannelTransferRepository(db);
  });

  async function seedTransfer(overrides: Partial<CreatePrivateChannelTransferInput> = {}) {
    const row = await repo.createTransfer(makeInput(overrides));
    if (!row) {
      throw new Error("test setup: createTransfer returned null");
    }
    return row;
  }

  /** Seed a row and advance it out of `pending`, as the service does. */
  async function seedSubmitted(overrides: Partial<CreatePrivateChannelTransferInput> = {}) {
    const pending = await seedTransfer(overrides);
    const row = await repo.updateTransfer({
      id: pending.id,
      status: "submitted",
      signature: "transfer_signature",
      expectedStatus: "pending",
    });
    if (!row) {
      throw new Error("test setup: updateTransfer returned null");
    }
    return row;
  }

  it("creates a transfer as pending with no signature or failure reason", async () => {
    const row = await seedTransfer();

    expect(row.id).toMatch(/^pct_/);
    expect(row.status).toBe("pending");
    expect(row.signature).toBeNull();
    expect(row.failure_reason).toBeNull();
    expect(row.sender_wallet_id).toBe("wal_pct_sender");
    expect(row.recipient_verified_wallet_id).toBe(RECIPIENT_WALLET_A_ID);
  });

  it("maps a submitted transfer without exposing internal audit fields", async () => {
    const row = await seedSubmitted();

    expect(row.status).toBe("submitted");
    expect(row.signature).toBe("transfer_signature");
    expect(row.failure_reason).toBeNull();

    expect(mapPrivateChannelTransferRow(row)).toEqual({
      id: row.id,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      instanceId: TEST_INSTANCE_ID,
      channelId: CHANNEL_A_ID,
      walletId: "wal_pct_sender",
      sender: SENDER,
      recipient: RECIPIENT,
      mint: MINT,
      amount: "12.34",
      status: "submitted",
      signature: "transfer_signature",
      failureReason: null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  });

  // The confirm write passes no signature, so the column must survive via COALESCE —
  // the `confirmed` CHECK constraint requires a non-null signature.
  it("confirms a submitted transfer and keeps its signature", async () => {
    const submitted = await seedSubmitted();

    const confirmed = await repo.updateTransfer({
      id: submitted.id,
      status: "confirmed",
      expectedStatus: "submitted",
    });

    expect(confirmed).toMatchObject({
      status: "confirmed",
      signature: "transfer_signature",
      failure_reason: null,
    });
  });

  it("does not confirm a row that never reached submitted", async () => {
    const pending = await seedTransfer();

    expect(
      await repo.updateTransfer({
        id: pending.id,
        status: "confirmed",
        expectedStatus: "submitted",
      })
    ).toBeNull();
    expect(await repo.getTransferById({ ...SCOPE, id: pending.id })).toMatchObject({
      status: "pending",
    });
  });

  it("only advances a row that is still pending", async () => {
    const submitted = await seedSubmitted();

    // The compare-and-swap guard makes a second settle a no-op rather than a
    // regression, so a stale writer cannot walk a terminal row backwards.
    expect(
      await repo.updateTransfer({
        id: submitted.id,
        status: "failed",
        failureReason: "stale writer",
        expectedStatus: "pending",
      })
    ).toBeNull();

    expect(await repo.getTransferById({ ...SCOPE, id: submitted.id })).toMatchObject({
      status: "submitted",
      signature: "transfer_signature",
      failure_reason: null,
    });
  });

  it("scopes reads to the project and optionally filters project history by channel", async () => {
    const channelA = await seedTransfer();
    const channelB = await seedTransfer({
      channelId: CHANNEL_B_ID,
    });
    const otherProject = await seedTransfer({
      projectId: OTHER_PROJECT_ID,
      instanceId: OTHER_INSTANCE_ID,
      channelId: OTHER_CHANNEL_ID,
    });

    expect(
      await repo.getTransferById({
        ...SCOPE,
        id: channelA.id,
      })
    ).toMatchObject({ id: channelA.id });
    expect(
      await repo.getTransferById({
        organizationId: TEST_ORG.id,
        projectId: OTHER_PROJECT_ID,
        id: channelA.id,
      })
    ).toBeNull();

    const projectRows = await repo.listTransfersByProject(SCOPE);
    expect(new Set(projectRows.map((row) => row.id))).toEqual(new Set([channelA.id, channelB.id]));
    expect(await repo.listTransfersByProject({ ...SCOPE, channelId: CHANNEL_A_ID })).toEqual([
      expect.objectContaining({ id: channelA.id }),
    ]);
    expect(projectRows.map((row) => row.id)).not.toContain(otherProject.id);
  });

  it("stores failed transfer errors as terminal history", async () => {
    const pending = await seedTransfer();
    const failed = await repo.updateTransfer({
      id: pending.id,
      status: "failed",
      failureReason: "SPC rejected transfer",
      expectedStatus: "pending",
    });

    expect(failed).toMatchObject({
      status: "failed",
      signature: null,
      failure_reason: "SPC rejected transfer",
    });
  });

  it("allows repeated attempts with the same financial details", async () => {
    const firstPending = await seedTransfer();
    const first = await repo.updateTransfer({
      id: firstPending.id,
      status: "failed",
      failureReason: "SPC rejected transfer",
      expectedStatus: "pending",
    });
    const retry = await seedSubmitted();

    expect(first?.id).not.toBe(retry.id);
    const rows = await repo.listTransfersByProject(SCOPE);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: retry.id, status: "submitted" }),
        expect.objectContaining({ id: firstPending.id, status: "failed" }),
      ])
    );
  });

  it("caps project history at the requested limit, newest first", async () => {
    await seedSubmitted();
    await seedSubmitted();
    await seedSubmitted();

    expect(await repo.listTransfersByProject({ ...SCOPE, limit: 2 })).toHaveLength(2);
  });

  it("lists every verified wallet on the channel, one per wallet and the caller's own first", async () => {
    const recipients = await repo.listEligibleRecipients({
      ...SCOPE,
      instanceId: TEST_INSTANCE_ID,
      channelId: CHANNEL_A_ID,
      initiatingPrivateChannelUserId: SENDER_PC_USER_ID,
    });

    expect(recipients).toEqual([
      {
        id: "pcvw_pct_sender",
        pubkey: SENDER,
        walletName: "Treasury",
        privateChannelUserId: SENDER_PC_USER_ID,
        isSelf: true,
      },
      {
        id: RECIPIENT_WALLET_A_ID,
        pubkey: RECIPIENT,
        walletName: "Operations",
        privateChannelUserId: RECIPIENT_PC_USER_ID,
        isSelf: false,
      },
      {
        id: RECIPIENT_WALLET_B_ID,
        pubkey: "RecipientTwo11111111111111111111111111111111",
        walletName: null,
        privateChannelUserId: RECIPIENT_PC_USER_ID,
        isSelf: false,
      },
    ]);
  });

  it("excludes verified wallets of members who are not in the channel", async () => {
    const recipients = await repo.listEligibleRecipients({
      ...SCOPE,
      instanceId: TEST_INSTANCE_ID,
      channelId: CHANNEL_A_ID,
      initiatingPrivateChannelUserId: SENDER_PC_USER_ID,
    });

    expect(
      recipients.some((recipient) => recipient.privateChannelUserId === NON_MEMBER_PC_USER_ID)
    ).toBe(false);
  });

  it("returns no recipients outside an active channel and active instance", async () => {
    const input = {
      ...SCOPE,
      instanceId: TEST_INSTANCE_ID,
      channelId: CHANNEL_A_ID,
      initiatingPrivateChannelUserId: SENDER_PC_USER_ID,
    };

    expect(await repo.listEligibleRecipients({ ...input, instanceId: OTHER_INSTANCE_ID })).toEqual(
      []
    );

    const db = getDb(env);
    await db
      .prepare("UPDATE private_channels SET status = 'archived' WHERE id = ?")
      .bind(CHANNEL_A_ID)
      .run();
    expect(await repo.listEligibleRecipients(input)).toEqual([]);

    await db
      .prepare("UPDATE private_channels SET status = 'active' WHERE id = ?")
      .bind(CHANNEL_A_ID)
      .run();
    await db
      .prepare("UPDATE private_channel_instances SET is_active = FALSE WHERE id = ?")
      .bind(TEST_INSTANCE_ID)
      .run();
    expect(await repo.listEligibleRecipients(input)).toEqual([]);
  });

  it("keeps transfer history after instance, channel, member, and verification deletion", async () => {
    const created = await seedTransfer();
    const db = getDb(env);

    await db
      .prepare("DELETE FROM private_channel_instances WHERE id = ?")
      .bind(TEST_INSTANCE_ID)
      .run();
    await db
      .prepare("DELETE FROM private_channel_users WHERE project_id = ?")
      .bind(TEST_PROJECT_ID)
      .run();

    expect(await repo.getTransferById({ ...SCOPE, id: created.id })).toMatchObject({
      id: created.id,
      instance_id: TEST_INSTANCE_ID,
      channel_id: CHANNEL_A_ID,
      sender_private_channel_user_id: SENDER_PC_USER_ID,
      recipient_private_channel_user_id: RECIPIENT_PC_USER_ID,
      recipient_verified_wallet_id: RECIPIENT_WALLET_A_ID,
    });
  });

  it("rejects transfers whose sender and recipient addresses are identical", async () => {
    await expect(
      repo.createTransfer(
        makeInput({
          sender: SENDER,
          recipient: SENDER,
        })
      )
    ).rejects.toThrow();
  });
});
