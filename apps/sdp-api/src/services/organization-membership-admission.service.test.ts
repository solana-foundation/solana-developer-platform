import type { LegacyOrganizationRole, MemberStatus, OrganizationRole } from "@sdp/types";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { getDb } from "@/db";
import { admitOrganizationMember } from "@/services/organization-membership-admission.service";
import { env } from "@/test/helpers/env";
import { createOrganization, createUser } from "@/test/helpers/factories";
import {
  type InvitationSeed,
  readInvitations,
  seedInvitations,
  seedOrganizationsAndUsers,
} from "@/test/helpers/organization-invitations";
import { seedTestDatabase } from "@/test/mocks/db";

const LIVE_EXPIRY = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const LAPSED_EXPIRY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const INVITED_AT = "2026-01-01 00:00:00";

const ORGANIZATION = createOrganization({ id: "org_admission", slug: "admission" });
const DELETED_ORGANIZATION = createOrganization({
  id: "org_admission_deleted",
  slug: "admission-deleted",
  status: "deleted",
});
const INVITER = createUser({ id: "usr_admission_inviter", email: "inviter@admission.test" });
const INVITEE = createUser({ id: "usr_admission_invitee", email: "invitee@admission.test" });

async function seedInvitee(
  membershipStatus: MemberStatus | null,
  invitation: Pick<InvitationSeed, "role" | "status" | "expiresAt"> | null
): Promise<void> {
  if (membershipStatus !== null) {
    await getDb(env)
      .prepare(
        "INSERT INTO organization_members (id, organization_id, user_id, role, status) VALUES (?, ?, ?, 'admin', ?)"
      )
      .bind("mem_admission_invitee", ORGANIZATION.id, INVITEE.id, membershipStatus)
      .run();
  }
  if (invitation !== null) {
    await seedInvitations(getDb(env), [
      {
        ...invitation,
        id: "inv_admission",
        organizationId: ORGANIZATION.id,
        email: INVITEE.email,
        invitedBy: INVITER.id,
        createdAt: INVITED_AT,
      },
    ]);
  }
}

function readMemberships() {
  return getDb(env).queryMany<{ role: LegacyOrganizationRole; status: MemberStatus }>(
    "SELECT role, status FROM organization_members"
  );
}

async function rejectInviteeMembershipInserts(): Promise<void> {
  await getDb(env).execute(
    `CREATE FUNCTION admission_test_reject_membership_insert() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.user_id = TG_ARGV[0] THEN
           RAISE EXCEPTION 'membership insert rejected';
         END IF;
         RETURN NEW;
       END
     $$`
  );
  await getDb(env).execute(
    `CREATE TRIGGER admission_test_reject_membership_insert
       BEFORE INSERT ON organization_members
       FOR EACH ROW EXECUTE FUNCTION admission_test_reject_membership_insert('${INVITEE.id}')`
  );
  onTestFinished(async () => {
    await getDb(env).execute(
      "DROP TRIGGER admission_test_reject_membership_insert ON organization_members"
    );
    await getDb(env).execute("DROP FUNCTION admission_test_reject_membership_insert()");
  });
}

function admitInvitee(organizationId: string, email: string, clerkRole: OrganizationRole) {
  return admitOrganizationMember(getDb(env), {
    organizationId,
    userId: INVITEE.id,
    email,
    clerkRole,
  });
}

describe("admitOrganizationMember", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedOrganizationsAndUsers(getDb(env), {
      organizations: [ORGANIZATION, DELETED_ORGANIZATION],
      users: [INVITER, INVITEE],
    });
  });

  it("refuses a deleted organization and writes no membership", async () => {
    expect(await admitInvitee(DELETED_ORGANIZATION.id, INVITEE.email, "admin")).toEqual({
      admitted: false,
      reason: "organization_deleted",
    });
    expect(await readMemberships()).toEqual([]);
  });

  it("reactivates a removed member through a live invitation at the invited role", async () => {
    await seedInvitee("removed", { role: "member", status: "pending", expiresAt: LIVE_EXPIRY });

    expect(await admitInvitee(ORGANIZATION.id, INVITEE.email, "admin")).toEqual({
      admitted: true,
      role: "member",
      joined: true,
    });
    expect(await readMemberships()).toEqual([{ role: "member", status: "active" }]);
    expect(await readInvitations(getDb(env))).toEqual([
      { id: "inv_admission", role: "member", status: "accepted" },
    ]);
  });

  it("refuses a removed member without a live invitation", async () => {
    await seedInvitee("removed", null);

    expect(await admitInvitee(ORGANIZATION.id, INVITEE.email, "admin")).toEqual({
      admitted: false,
      reason: "membership_removed",
    });
    expect(await readMemberships()).toEqual([{ role: "admin", status: "removed" }]);
  });

  it("refuses a removed member whose invitation lapsed and marks it expired", async () => {
    await seedInvitee("removed", { role: "member", status: "pending", expiresAt: LAPSED_EXPIRY });

    expect(await admitInvitee(ORGANIZATION.id, INVITEE.email, "admin")).toEqual({
      admitted: false,
      reason: "membership_removed",
    });
    expect(await readMemberships()).toEqual([{ role: "admin", status: "removed" }]);
    expect(await readInvitations(getDb(env))).toEqual([
      { id: "inv_admission", role: "member", status: "expired" },
    ]);
  });

  it("keeps an active member's role and leaves their pending invitation pending", async () => {
    await seedInvitee("active", { role: "member", status: "pending", expiresAt: LIVE_EXPIRY });

    expect(await admitInvitee(ORGANIZATION.id, INVITEE.email, "member")).toEqual({
      admitted: true,
      role: "admin",
      joined: false,
    });
    expect(await readMemberships()).toEqual([{ role: "admin", status: "active" }]);
    expect(await readInvitations(getDb(env))).toEqual([
      { id: "inv_admission", role: "member", status: "pending" },
    ]);
  });

  it("refuses a deleted user despite a live invitation and leaves it pending", async () => {
    await seedInvitee("removed", { role: "member", status: "pending", expiresAt: LIVE_EXPIRY });
    await getDb(env)
      .prepare("UPDATE users SET status = 'deleted' WHERE id = ?")
      .bind(INVITEE.id)
      .run();

    expect(await admitInvitee(ORGANIZATION.id, INVITEE.email, "admin")).toEqual({
      admitted: false,
      reason: "user_deleted",
    });
    expect(await readMemberships()).toEqual([{ role: "admin", status: "removed" }]);
    expect(await readInvitations(getDb(env))).toEqual([
      { id: "inv_admission", role: "member", status: "pending" },
    ]);
  });

  it("refuses a user whose invitation was revoked", async () => {
    await seedInvitee(null, { role: "member", status: "revoked", expiresAt: LIVE_EXPIRY });

    expect(await admitInvitee(ORGANIZATION.id, INVITEE.email, "member")).toEqual({
      admitted: false,
      reason: "invitation_revoked",
    });
    expect(await readMemberships()).toEqual([]);
  });

  it("joins at the invited admin role over a Clerk member role", async () => {
    await seedInvitee(null, { role: "admin", status: "pending", expiresAt: LIVE_EXPIRY });

    expect(await admitInvitee(ORGANIZATION.id, INVITEE.email, "member")).toEqual({
      admitted: true,
      role: "admin",
      joined: true,
    });
    expect(await readMemberships()).toEqual([{ role: "admin", status: "active" }]);
    expect(await readInvitations(getDb(env))).toEqual([
      { id: "inv_admission", role: "admin", status: "accepted" },
    ]);
  });

  it("admits through an older live invitation when the newest one was revoked", async () => {
    await seedInvitations(getDb(env), [
      {
        id: "inv_admission_older_pending",
        organizationId: ORGANIZATION.id,
        email: INVITEE.email,
        role: "admin",
        invitedBy: INVITER.id,
        status: "pending",
        expiresAt: LIVE_EXPIRY,
        createdAt: INVITED_AT,
      },
      {
        id: "inv_admission_newer_revoked",
        organizationId: ORGANIZATION.id,
        email: INVITEE.email,
        role: "member",
        invitedBy: INVITER.id,
        status: "revoked",
        expiresAt: LIVE_EXPIRY,
        createdAt: "2026-02-01 00:00:00",
      },
    ]);

    expect(await admitInvitee(ORGANIZATION.id, INVITEE.email, "member")).toEqual({
      admitted: true,
      role: "admin",
      joined: true,
    });
    expect(await readMemberships()).toEqual([{ role: "admin", status: "active" }]);
    expect(await readInvitations(getDb(env))).toEqual([
      { id: "inv_admission_newer_revoked", role: "member", status: "revoked" },
      { id: "inv_admission_older_pending", role: "admin", status: "accepted" },
    ]);
  });

  it("refuses a join whose invitation is revoked while the admission waits on the invitation lock", async () => {
    await seedInvitee(null, { role: "member", status: "pending", expiresAt: LIVE_EXPIRY });

    const { admission } = await getDb(env).transaction(async (tx) => {
      await tx
        .prepare("SELECT id FROM invitations WHERE id = ? FOR UPDATE")
        .bind("inv_admission")
        .all();
      const pendingAdmission = admitInvitee(ORGANIZATION.id, INVITEE.email, "member");
      await vi.waitFor(async () => {
        expect(
          await getDb(env).queryMany<{ pid: number }>(
            "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'"
          )
        ).toHaveLength(1);
      });
      await tx
        .prepare("UPDATE invitations SET status = 'revoked' WHERE id = ?")
        .bind("inv_admission")
        .run();
      return { admission: pendingAdmission };
    });

    expect(await admission).toEqual({ admitted: false, reason: "invitation_revoked" });
    expect(await readMemberships()).toEqual([]);
    expect(await readInvitations(getDb(env))).toEqual([
      { id: "inv_admission", role: "member", status: "revoked" },
    ]);
  });

  it("rolls back the invitation claim when the membership insert fails", async () => {
    await seedInvitee(null, { role: "member", status: "pending", expiresAt: LIVE_EXPIRY });
    await rejectInviteeMembershipInserts();

    await expect(admitInvitee(ORGANIZATION.id, INVITEE.email, "admin")).rejects.toThrow(
      "membership insert rejected"
    );
    expect(await readInvitations(getDb(env))).toEqual([
      { id: "inv_admission", role: "member", status: "pending" },
    ]);
    expect(await readMemberships()).toEqual([]);
  });

  it("marks a lapsed invitation expired and admits at the Clerk role", async () => {
    await seedInvitee(null, { role: "member", status: "pending", expiresAt: LAPSED_EXPIRY });

    expect(await admitInvitee(ORGANIZATION.id, INVITEE.email, "admin")).toEqual({
      admitted: true,
      role: "admin",
      joined: true,
    });
    expect(await readMemberships()).toEqual([{ role: "admin", status: "active" }]);
    expect(await readInvitations(getDb(env))).toEqual([
      { id: "inv_admission", role: "member", status: "expired" },
    ]);
  });

  it("matches the invitation to the verified email regardless of case", async () => {
    await seedInvitee(null, { role: "member", status: "pending", expiresAt: LIVE_EXPIRY });

    expect(await admitInvitee(ORGANIZATION.id, "Invitee@Admission.TEST", "admin")).toEqual({
      admitted: true,
      role: "member",
      joined: true,
    });
    expect(await readInvitations(getDb(env))).toEqual([
      { id: "inv_admission", role: "member", status: "accepted" },
    ]);
  });

  it("creates exactly one membership when two admissions for the same user race", async () => {
    const admissions = await Promise.all([
      admitInvitee(ORGANIZATION.id, INVITEE.email, "member"),
      admitInvitee(ORGANIZATION.id, INVITEE.email, "member"),
    ]);

    expect(admissions).toEqual(
      expect.arrayContaining([
        { admitted: true, role: "member", joined: true },
        { admitted: true, role: "member", joined: false },
      ])
    );
    expect(await readMemberships()).toEqual([{ role: "member", status: "active" }]);
  });
});
