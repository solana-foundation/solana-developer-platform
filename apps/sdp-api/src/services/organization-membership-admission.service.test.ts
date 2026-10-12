import type { MemberStatus, OrganizationRole } from "@sdp/types";
import { beforeEach, describe, expect, it } from "vitest";
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
      },
    ]);
  }
}

function readMemberships() {
  return getDb(env).queryMany<{ role: string; status: string }>(
    "SELECT role, status FROM organization_members"
  );
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

  it("refuses a user whose invitation was revoked", async () => {
    await seedInvitee(null, { role: "member", status: "revoked", expiresAt: LIVE_EXPIRY });

    expect(await admitInvitee(ORGANIZATION.id, INVITEE.email, "member")).toEqual({
      admitted: false,
      reason: "invitation_revoked",
    });
    expect(await readMemberships()).toEqual([]);
  });

  it("caps an admin invitation at the member role Clerk verified", async () => {
    await seedInvitee(null, { role: "admin", status: "pending", expiresAt: LIVE_EXPIRY });

    expect(await admitInvitee(ORGANIZATION.id, INVITEE.email, "member")).toEqual({
      admitted: true,
      role: "member",
      joined: true,
    });
    expect(await readMemberships()).toEqual([{ role: "member", status: "active" }]);
    expect(await readInvitations(getDb(env))).toEqual([
      { id: "inv_admission", role: "member", status: "accepted" },
    ]);
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
