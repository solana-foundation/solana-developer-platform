import type { MemberStatus } from "@sdp/types/organizations";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import {
  applyMembershipChange,
  type MembershipChange,
} from "@/services/organization-membership.service";
import { env } from "@/test/helpers/env";
import { readInvitationStatus, seedInvitation } from "@/test/helpers/invitations";
import {
  organizationMember,
  type SeededOrganizationMember,
  seedOrganizationMembers,
} from "@/test/helpers/organization-members";
import { holdTransaction, untilLockWaiters } from "@/test/helpers/row-locks";
import { seedTestDatabase } from "@/test/mocks/db";

const ORGANIZATION = { id: "org_membership_race", slug: "membership-race" };
const ADMIN_A = organizationMember("race_admin_a", "admin");
const ADMIN_B = organizationMember("race_admin_b", "admin");
const MEMBER_C = organizationMember("race_member_c", "member");
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
    await untilLockWaiters(db, { fragment: "ORDER BY id", count: 1 });
    await firstRemoval.commit();

    await expect(staleRemoval).rejects.toMatchObject(MISSING_MANAGE);
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
