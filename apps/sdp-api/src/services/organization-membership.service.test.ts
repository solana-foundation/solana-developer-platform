import type { MemberStatus } from "@sdp/types/organizations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { createPostgresCustodyProposalsRepository } from "@/db/repositories/custody-proposals.repository.postgres";
import type { MoneyPrincipal } from "@/lib/money-principal";
import { getLogger } from "@/runtime/logger";
import {
  applyMembershipChange,
  type MembershipChange,
  mirrorClerkMembershipDeletion,
} from "@/services/organization-membership.service";
import { env } from "@/test/helpers/env";
import { readInvitationStatus, seedInvitation } from "@/test/helpers/invitations";
import {
  organizationMember,
  type SeededOrganizationMember,
  seedOrganizationMembers,
} from "@/test/helpers/organization-members";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { holdTransaction, untilLockWaiters } from "@/test/helpers/row-locks";
import { seedTestDatabase } from "@/test/mocks/db";

const ORGANIZATION = { id: "org_membership_race", slug: "membership-race" };
const ADMIN_A = organizationMember("race_admin_a", "admin");
const ADMIN_B = organizationMember("race_admin_b", "admin");
const MEMBER_C = organizationMember("race_member_c", "member");
const RECOVERY_FAILURE_CONSTRAINT = "sdp_test_fail_member_recovery_wake";
const MISSING_MANAGE = {
  code: "INSUFFICIENT_PERMISSIONS",
  message: "Missing action: members.manage",
};

function change(actor: SeededOrganizationMember, membershipChange: MembershipChange) {
  return getDb(env).transaction((tx) =>
    applyMembershipChange(tx, {
      organizationId: ORGANIZATION.id,
      actorUserId: actor.userId,
      change: membershipChange,
    })
  );
}

async function setMemberStatus(member: SeededOrganizationMember, status: MemberStatus) {
  await getDb(env).execute("UPDATE organization_members SET status = ? WHERE id = ?", [
    status,
    member.memberId,
  ]);
}

function activeAdminIds() {
  return getDb(env).queryMany(
    "SELECT id FROM organization_members WHERE organization_id = ? AND status = 'active' AND role = 'admin' ORDER BY id",
    [ORGANIZATION.id]
  );
}

describe("applyMembershipChange", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedOrganizationMembers(getDb(env), {
      organization: ORGANIZATION,
      members: [ADMIN_A, ADMIN_B, MEMBER_C],
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await getDb(env).execute(
      `ALTER TABLE custody_proposals DROP CONSTRAINT IF EXISTS ${RECOVERY_FAILURE_CONSTRAINT}`
    );
  });

  it.each(["remove", "leave", "clerk"] as const)(
    "withdraws membership when the recovery wake fails in PostgreSQL (%s)",
    async (kind) => {
      const db = getDb(env);
      const projects = await seedDefaultProjects(db, {
        organizationId: ORGANIZATION.id,
        createdBy: ADMIN_A.userId,
        members: [ADMIN_A.userId, MEMBER_C.userId],
      });
      await db.execute(
        `INSERT INTO payment_transfers
           (id, organization_id, project_id, wallet_id, source_address,
            destination_address, token, amount, type, direction, status,
            created_at, updated_at, provider_reference, provider_data, initiated_by_principal)
         VALUES ('trf_member_wake_failure', ?, ?, 'provider-wallet', 'Source', 'Destination',
                 'SOL', '1', 'transfer', 'outbound', 'processing',
                 '2026-01-01T00:00:00.000Z', sdp_iso_now(), 'fireblocks_pending',
                 '{"fireblocksTransfer":{"connectionId":"recovery-connection","accountFingerprint":"recovery-account","vaultAccountId":"0","assetId":"SOL_TEST"},"fireblocksStatus":"PENDING_AUTHORIZATION","fireblocksSubStatus":"private_provider_detail_do_not_log"}'::jsonb,
                 ?::jsonb)`,
        [
          ORGANIZATION.id,
          projects.sandbox.id,
          JSON.stringify({ kind: "member", userId: MEMBER_C.userId }),
        ]
      );
      await seedInvitation(db, {
        id: "inv_failed_member_wake",
        organizationId: ORGANIZATION.id,
        email: MEMBER_C.email,
        role: "member",
        invitedBy: ADMIN_A.userId,
        status: "pending",
        expiresInDays: 7,
      });
      await db.execute(
        `ALTER TABLE custody_proposals ADD CONSTRAINT ${RECOVERY_FAILURE_CONSTRAINT}
           CHECK (recheck_requested_at IS NULL)`
      );
      const error = vi.spyOn(getLogger(), "error");

      if (kind === "clerk") {
        await db.transaction((tx) =>
          mirrorClerkMembershipDeletion(tx, {
            organizationId: ORGANIZATION.id,
            userId: MEMBER_C.userId,
            heldInClerk: async () => false,
          })
        );
      } else {
        await change(
          kind === "leave" ? MEMBER_C : ADMIN_A,
          kind === "leave" ? { kind: "leave" } : { kind: "remove", memberId: MEMBER_C.memberId }
        );
      }
      expect(
        await db.queryOne("SELECT status FROM organization_members WHERE id = ?", [
          MEMBER_C.memberId,
        ])
      ).toEqual({ status: "removed" });
      expect(
        await db.queryMany("SELECT id FROM project_members WHERE user_id = ?", [MEMBER_C.userId])
      ).toEqual([]);
      expect(await readInvitationStatus(db, "inv_failed_member_wake")).toBe("revoked");
      expect(
        await db.queryOne(
          "SELECT id FROM custody_proposals WHERE payment_transfer_id = 'trf_member_wake_failure'"
        )
      ).toBeNull();
      expect(error).toHaveBeenCalledWith(
        {
          event: "proposal_recovery_wake_failed",
          organizationId: ORGANIZATION.id,
          projectId: undefined,
          principal: `member:${MEMBER_C.userId}`,
          sqlstate: "23514",
        },
        expect.any(String)
      );
      expect(JSON.stringify(error.mock.calls)).not.toContain("private_provider_detail_do_not_log");

      await db.execute(
        `ALTER TABLE custody_proposals DROP CONSTRAINT ${RECOVERY_FAILURE_CONSTRAINT}`
      );
      const proposals = createPostgresCustodyProposalsRepository(db);
      const now = new Date().toISOString();
      await proposals.adoptLegacyTransfers({ environment: "sandbox", now, limit: 50 });
      expect(
        (await proposals.claimDue({ environment: "sandbox", now, limit: 50 })).map(
          (proposal) => proposal.payment_transfer_id
        )
      ).toEqual(["trf_member_wake_failure"]);
    }
  );

  it.each(["remove", "leave", "clerk"] as const)(
    "queues only the removed member's proposals across projects (%s)",
    async (kind) => {
      const db = getDb(env);
      const projects = await seedDefaultProjects(db, {
        organizationId: ORGANIZATION.id,
        createdBy: ADMIN_A.userId,
        members: [ADMIN_A.userId, MEMBER_C.userId],
      });
      const identities: Array<{ id: string; principal: MoneyPrincipal | null; projectId: string }> =
        [
          {
            id: "member_sandbox",
            principal: { kind: "member", userId: MEMBER_C.userId },
            projectId: projects.sandbox.id,
          },
          {
            id: "member_production",
            principal: { kind: "member", userId: MEMBER_C.userId },
            projectId: projects.production.id,
          },
          {
            id: "different_member",
            principal: { kind: "member", userId: ADMIN_A.userId },
            projectId: projects.sandbox.id,
          },
          {
            id: "created_key",
            principal: { kind: "api_key", apiKeyId: "key_member_created" },
            projectId: projects.sandbox.id,
          },
          {
            id: "mandate",
            principal: { kind: "mandate", recurringPaymentId: "recurring_member_created" },
            projectId: projects.sandbox.id,
          },
          { id: "legacy_audit_id", principal: null, projectId: projects.sandbox.id },
        ];
      for (const row of identities) {
        await db.execute(
          `INSERT INTO payment_transfers
             (id, organization_id, project_id, wallet_id, source_address,
              destination_address, token, amount, type, direction, status,
              created_at, updated_at, provider_data, initiated_by_principal, initiated_by_key_id)
           VALUES (?, ?, ?, 'provider-wallet', 'Source', 'Destination', 'SOL', '1',
                   'transfer', 'outbound', 'processing', sdp_iso_now(), sdp_iso_now(),
                   '{"fireblocksTransfer":{"connectionId":"recovery-connection","accountFingerprint":"recovery-account","vaultAccountId":"0","assetId":"SOL_TEST"}}'::jsonb, ?::jsonb, ?)`,
          [
            row.id,
            ORGANIZATION.id,
            row.projectId,
            row.principal === null ? null : JSON.stringify(row.principal),
            MEMBER_C.userId,
          ]
        );
      }
      if (kind === "clerk") {
        await db.transaction((tx) =>
          mirrorClerkMembershipDeletion(tx, {
            organizationId: ORGANIZATION.id,
            userId: MEMBER_C.userId,
            heldInClerk: async () => false,
          })
        );
      } else {
        await change(
          kind === "leave" ? MEMBER_C : ADMIN_A,
          kind === "leave" ? { kind: "leave" } : { kind: "remove", memberId: MEMBER_C.memberId }
        );
      }
      expect(
        await db.queryMany(
          "SELECT payment_transfer_id AS id FROM custody_proposals WHERE recheck_requested_at IS NOT NULL ORDER BY payment_transfer_id"
        )
      ).toEqual([{ id: "member_production" }, { id: "member_sandbox" }]);
    }
  );

  it.each([
    {
      kind: "set_role",
      against: (memberId: string): MembershipChange => ({
        kind: "set_role",
        memberId,
        role: "member",
      }),
    },
    {
      kind: "remove",
      against: (memberId: string): MembershipChange => ({ kind: "remove", memberId }),
    },
  ])(
    "refuses the second of two admins acting on each other at once ($kind)",
    async ({ against }) => {
      const db = getDb(env);
      const blocker = await holdTransaction(db, async (tx) => {
        await tx.execute(
          "SELECT id FROM organization_members WHERE organization_id = ? FOR UPDATE",
          [ORGANIZATION.id]
        );
      });
      const settling = Promise.allSettled([
        change(ADMIN_A, against(ADMIN_B.memberId)),
        change(ADMIN_B, against(ADMIN_A.memberId)),
      ]);
      await untilLockWaiters(db, { fragment: "ORDER BY id", count: 2 });
      await blocker.commit();
      const outcomes = await settling;

      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const reasons: unknown[] = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : []
      );
      expect(reasons).toEqual([expect.objectContaining(MISSING_MANAGE)]);
      expect(await activeAdminIds()).toHaveLength(1);
    }
  );

  it("refuses an admin removed while their own removal of another admin waited", async () => {
    const db = getDb(env);
    await db.execute("UPDATE organization_members SET role = 'admin' WHERE id = ?", [
      MEMBER_C.memberId,
    ]);
    const firstRemoval = await holdTransaction(db, async (tx) => {
      await applyMembershipChange(tx, {
        organizationId: ORGANIZATION.id,
        actorUserId: ADMIN_A.userId,
        change: { kind: "remove", memberId: ADMIN_B.memberId },
      });
    });
    const staleRemoval = change(ADMIN_B, { kind: "remove", memberId: MEMBER_C.memberId });
    // Observed before the commit: the refusal can land before `commit` returns.
    const refused = expect(staleRemoval).rejects.toMatchObject(MISSING_MANAGE);
    await untilLockWaiters(db, { fragment: "ORDER BY id", count: 1 });
    await firstRemoval.commit();

    await refused;
    expect(await activeAdminIds()).toEqual([{ id: ADMIN_A.memberId }, { id: MEMBER_C.memberId }]);
  });

  it("changes nothing when removing a member already removed, keeping an invitation raised since", async () => {
    await setMemberStatus(MEMBER_C, "removed");
    await seedInvitation(getDb(env), {
      id: "inv_race_reinvite",
      organizationId: ORGANIZATION.id,
      email: MEMBER_C.email,
      role: "member",
      invitedBy: ADMIN_A.userId,
      status: "pending",
      expiresInDays: 7,
    });

    await expect(change(ADMIN_A, { kind: "remove", memberId: MEMBER_C.memberId })).resolves.toEqual(
      {
        memberId: MEMBER_C.memberId,
        userId: MEMBER_C.userId,
        previousRole: "member",
        changed: false,
      }
    );
    expect(await readInvitationStatus(getDb(env), "inv_race_reinvite")).toBe("pending");
  });

  it.each([
    { status: "suspended", membershipChange: { kind: "remove", memberId: MEMBER_C.memberId } },
    {
      status: "removed",
      membershipChange: { kind: "set_role", memberId: MEMBER_C.memberId, role: "admin" },
    },
  ] as const satisfies readonly { status: MemberStatus; membershipChange: MembershipChange }[])(
    "refuses $membershipChange.kind of a $status member",
    async ({ status, membershipChange }) => {
      await setMemberStatus(MEMBER_C, status);

      await expect(change(ADMIN_A, membershipChange)).rejects.toMatchObject({
        code: "CONFLICT",
        message: "Member is not active",
      });
    }
  );
});

describe("mirrorClerkMembershipDeletion", () => {
  const MIRROR_ORGANIZATION = { id: "org_membership_mirror", slug: "membership-mirror" };
  const LONE_ADMIN = organizationMember("mirror_lone_admin", "admin");

  function mirror(userId: string, heldInClerk: () => Promise<boolean>) {
    return getDb(env).transaction((tx) =>
      mirrorClerkMembershipDeletion(tx, {
        organizationId: MIRROR_ORGANIZATION.id,
        userId,
        heldInClerk,
      })
    );
  }

  function seedPendingInvitation(id: string, email: string) {
    return seedInvitation(getDb(env), {
      id,
      organizationId: MIRROR_ORGANIZATION.id,
      email,
      role: "member",
      invitedBy: LONE_ADMIN.userId,
      status: "pending",
      expiresInDays: 7,
    });
  }

  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedOrganizationMembers(getDb(env), {
      organization: MIRROR_ORGANIZATION,
      members: [LONE_ADMIN],
    });
  });

  it("removes the last admin with their project memberships and pending invitations", async () => {
    const db = getDb(env);
    await seedDefaultProjects(db, {
      organizationId: MIRROR_ORGANIZATION.id,
      createdBy: LONE_ADMIN.userId,
      members: [LONE_ADMIN.userId],
    });
    await seedPendingInvitation("inv_mirror_admin", LONE_ADMIN.email);

    await expect(mirror(LONE_ADMIN.userId, async () => false)).resolves.toEqual({
      removedMemberId: LONE_ADMIN.memberId,
      removedRole: "admin",
      revokedInvitations: 1,
    });
    expect(
      await db.queryOne("SELECT status FROM organization_members WHERE id = ?", [
        LONE_ADMIN.memberId,
      ])
    ).toEqual({ status: "removed" });
    expect(
      await db.queryMany("SELECT id FROM project_members WHERE user_id = ?", [LONE_ADMIN.userId])
    ).toEqual([]);
    expect(await readInvitationStatus(db, "inv_mirror_admin")).toBe("revoked");
  });

  it("changes nothing for a membership already removed, keeping an invitation raised since", async () => {
    await setMemberStatus(LONE_ADMIN, "removed");
    await seedPendingInvitation("inv_mirror_reinvite", LONE_ADMIN.email);

    await expect(mirror(LONE_ADMIN.userId, async () => false)).resolves.toEqual({
      removedMemberId: null,
      removedRole: null,
      revokedInvitations: 0,
    });
    expect(await readInvitationStatus(getDb(env), "inv_mirror_reinvite")).toBe("pending");
  });

  it("keeps a membership Clerk lists again once the row is locked", async () => {
    await expect(mirror(LONE_ADMIN.userId, async () => true)).resolves.toEqual({
      removedMemberId: null,
      removedRole: null,
      revokedInvitations: 0,
    });
    expect(
      await getDb(env).queryOne("SELECT status FROM organization_members WHERE id = ?", [
        LONE_ADMIN.memberId,
      ])
    ).toEqual({ status: "active" });
  });

  it("revokes the pending invitations of someone never admitted", async () => {
    const db = getDb(env);
    await db.execute(
      "INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')",
      ["usr_mirror_invitee", "mirror-invitee@example.com"]
    );
    await seedPendingInvitation("inv_mirror_invitee", "mirror-invitee@example.com");

    await expect(mirror("usr_mirror_invitee", async () => false)).resolves.toEqual({
      removedMemberId: null,
      removedRole: null,
      revokedInvitations: 1,
    });
    expect(await readInvitationStatus(db, "inv_mirror_invitee")).toBe("revoked");
  });

  it("removes a member a sign-in admitted while the mirror waited on their invitation", async () => {
    const db = getDb(env);
    await db.execute(
      "INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')",
      ["usr_mirror_admitted", "mirror-admitted@example.com"]
    );
    await seedPendingInvitation("inv_mirror_admitted", "mirror-admitted@example.com");
    const signIn = await holdTransaction(db, async (tx) => {
      await tx.execute("SELECT id FROM invitations WHERE id = ? FOR UPDATE", [
        "inv_mirror_admitted",
      ]);
      await tx.execute(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES (?, ?, ?, 'member', 'active')`,
        ["mem_mirror_admitted", MIRROR_ORGANIZATION.id, "usr_mirror_admitted"]
      );
      await tx.execute("UPDATE invitations SET status = 'accepted' WHERE id = ?", [
        "inv_mirror_admitted",
      ]);
    });
    const mirrored = mirror("usr_mirror_admitted", async () => false);
    await untilLockWaiters(db, { fragment: "UPDATE invitations SET status = 'revoked'", count: 1 });
    await signIn.commit();

    await expect(mirrored).resolves.toEqual({
      removedMemberId: "mem_mirror_admitted",
      removedRole: "member",
      revokedInvitations: 0,
    });
    expect(
      await db.queryOne("SELECT status FROM organization_members WHERE id = ?", [
        "mem_mirror_admitted",
      ])
    ).toEqual({ status: "removed" });
    expect(await readInvitationStatus(db, "inv_mirror_admitted")).toBe("accepted");
  });
});
