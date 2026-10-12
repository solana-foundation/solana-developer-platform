import type { InvitationStatus, MemberStatus, OrganizationRole } from "@sdp/types";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { admitOrganizationMember } from "@/services/organization-membership-admission.service";
import { env } from "@/test/helpers/env";
import { createOrganization, createUser } from "@/test/helpers/factories";
import {
  type InvitationRow,
  type InvitationSeed,
  readInvitations,
  seedInvitations,
  seedOrganizationsAndUsers,
} from "@/test/helpers/organization-invitations";
import { seedTestDatabase } from "@/test/mocks/db";

const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE_EXPIRY = new Date(Date.now() + 7 * DAY_MS).toISOString();
const LAPSED_EXPIRY = new Date(Date.now() - DAY_MS).toISOString();
const OLDER = "2026-01-01 00:00:00";
const NEWER = "2026-01-02 00:00:00";

const ACCEPTED_AT = expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
const MINTED_MEMBERSHIP_ID = expect.stringMatching(/^mem_[0-9a-f-]{36}$/);

const ORGANIZATION = createOrganization({ id: "org_admission", slug: "admission" });
const DELETED_ORGANIZATION = createOrganization({
  id: "org_admission_deleted",
  slug: "admission-deleted",
  status: "deleted",
});
const INVITER = createUser({ id: "usr_admission_inviter", email: "inviter@admission.test" });
const INVITEE = createUser({ id: "usr_admission_invitee", email: "invitee@admission.test" });
const SEEDED_MEMBERSHIP_ID = "mem_admission_invitee";

interface MembershipRow {
  id: string;
  organization_id: string;
  user_id: string;
  role: string;
  status: string;
}

function invitationToInvitee(params: {
  id: string;
  organizationId: string;
  role: OrganizationRole;
  status: InvitationStatus;
  expiresAt: string;
  createdAt: string;
}): InvitationSeed {
  return {
    ...params,
    email: INVITEE.email,
    invitedBy: INVITER.id,
    tokenHash: `hash_${params.id}`,
    acceptedAt: null,
    clerkInvitationId: null,
  };
}

function invitationRow(params: {
  id: string;
  organizationId: string;
  role: OrganizationRole;
  status: InvitationStatus;
  accepted: boolean;
}): InvitationRow {
  return {
    id: params.id,
    organization_id: params.organizationId,
    email: INVITEE.email,
    role: params.role,
    status: params.status,
    accepted_at: params.accepted ? ACCEPTED_AT : null,
  };
}

async function seedInviteeMembership(role: OrganizationRole, status: MemberStatus): Promise<void> {
  await getDb(env)
    .prepare(
      "INSERT INTO organization_members (id, organization_id, user_id, role, status) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(SEEDED_MEMBERSHIP_ID, ORGANIZATION.id, INVITEE.id, role, status)
    .run();
}

async function readMemberships(): Promise<MembershipRow[]> {
  return getDb(env).queryMany<MembershipRow>(
    "SELECT id, organization_id, user_id, role, status FROM organization_members ORDER BY id"
  );
}

function admitInvitee(clerkRole: OrganizationRole) {
  return admitOrganizationMember(getDb(env), {
    organizationId: ORGANIZATION.id,
    userId: INVITEE.id,
    email: INVITEE.email,
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

  it("refuses a deleted organization and writes nothing", async () => {
    await seedInvitations(getDb(env), [
      invitationToInvitee({
        id: "inv_deleted_org",
        organizationId: DELETED_ORGANIZATION.id,
        role: "member",
        status: "pending",
        expiresAt: LIVE_EXPIRY,
        createdAt: OLDER,
      }),
    ]);

    const admission = await admitOrganizationMember(getDb(env), {
      organizationId: DELETED_ORGANIZATION.id,
      userId: INVITEE.id,
      email: INVITEE.email,
      clerkRole: "member",
    });

    expect(admission).toEqual({ admitted: false, reason: "organization_deleted" });
    expect(await readMemberships()).toEqual([]);
    expect(await readInvitations(getDb(env))).toEqual([
      invitationRow({
        id: "inv_deleted_org",
        organizationId: DELETED_ORGANIZATION.id,
        role: "member",
        status: "pending",
        accepted: false,
      }),
    ]);
  });

  it("keeps an active member's stored role and accepts their live invitation", async () => {
    await seedInviteeMembership("admin", "active");
    await seedInvitations(getDb(env), [
      invitationToInvitee({
        id: "inv_active_member",
        organizationId: ORGANIZATION.id,
        role: "member",
        status: "pending",
        expiresAt: LIVE_EXPIRY,
        createdAt: OLDER,
      }),
    ]);

    const admission = await admitInvitee("member");

    expect(admission).toEqual({ admitted: true, role: "admin", joined: false });
    expect(await readMemberships()).toEqual([
      {
        id: SEEDED_MEMBERSHIP_ID,
        organization_id: ORGANIZATION.id,
        user_id: INVITEE.id,
        role: "admin",
        status: "active",
      },
    ]);
    expect(await readInvitations(getDb(env))).toEqual([
      invitationRow({
        id: "inv_active_member",
        organizationId: ORGANIZATION.id,
        role: "member",
        status: "accepted",
        accepted: true,
      }),
    ]);
  });

  it("reactivates a removed member through a live invitation at the less privileged role", async () => {
    await seedInviteeMembership("admin", "removed");
    await seedInvitations(getDb(env), [
      invitationToInvitee({
        id: "inv_removed_member",
        organizationId: ORGANIZATION.id,
        role: "admin",
        status: "pending",
        expiresAt: LIVE_EXPIRY,
        createdAt: OLDER,
      }),
    ]);

    const admission = await admitInvitee("member");

    expect(admission).toEqual({ admitted: true, role: "member", joined: true });
    expect(await readMemberships()).toEqual([
      {
        id: SEEDED_MEMBERSHIP_ID,
        organization_id: ORGANIZATION.id,
        user_id: INVITEE.id,
        role: "member",
        status: "active",
      },
    ]);
    expect(await readInvitations(getDb(env))).toEqual([
      invitationRow({
        id: "inv_removed_member",
        organizationId: ORGANIZATION.id,
        role: "member",
        status: "accepted",
        accepted: true,
      }),
    ]);
  });

  it("refuses a removed member without a live invitation and leaves them removed", async () => {
    await seedInviteeMembership("member", "removed");

    const admission = await admitInvitee("admin");

    expect(admission).toEqual({ admitted: false, reason: "membership_removed" });
    expect(await readMemberships()).toEqual([
      {
        id: SEEDED_MEMBERSHIP_ID,
        organization_id: ORGANIZATION.id,
        user_id: INVITEE.id,
        role: "member",
        status: "removed",
      },
    ]);
  });

  it.each([
    { invitedRole: "admin", clerkRole: "member", grantedRole: "member" },
    { invitedRole: "admin", clerkRole: "admin", grantedRole: "admin" },
    { invitedRole: "member", clerkRole: "admin", grantedRole: "member" },
  ] satisfies readonly {
    invitedRole: OrganizationRole;
    clerkRole: OrganizationRole;
    grantedRole: OrganizationRole;
  }[])(
    "admits a new member invited as $invitedRole with Clerk role $clerkRole as $grantedRole",
    async ({ invitedRole, clerkRole, grantedRole }) => {
      await seedInvitations(getDb(env), [
        invitationToInvitee({
          id: "inv_new_member",
          organizationId: ORGANIZATION.id,
          role: invitedRole,
          status: "pending",
          expiresAt: LIVE_EXPIRY,
          createdAt: OLDER,
        }),
      ]);

      const admission = await admitInvitee(clerkRole);

      expect(admission).toEqual({ admitted: true, role: grantedRole, joined: true });
      expect(await readMemberships()).toEqual([
        {
          id: MINTED_MEMBERSHIP_ID,
          organization_id: ORGANIZATION.id,
          user_id: INVITEE.id,
          role: grantedRole,
          status: "active",
        },
      ]);
      expect(await readInvitations(getDb(env))).toEqual([
        invitationRow({
          id: "inv_new_member",
          organizationId: ORGANIZATION.id,
          role: grantedRole,
          status: "accepted",
          accepted: true,
        }),
      ]);
    }
  );

  it("admits a user with no membership or invitation at their Clerk role", async () => {
    const admission = await admitInvitee("admin");

    expect(admission).toEqual({ admitted: true, role: "admin", joined: true });
    expect(await readMemberships()).toEqual([
      {
        id: MINTED_MEMBERSHIP_ID,
        organization_id: ORGANIZATION.id,
        user_id: INVITEE.id,
        role: "admin",
        status: "active",
      },
    ]);
  });

  it("refuses a user whose newest invitation was revoked", async () => {
    await seedInvitations(getDb(env), [
      invitationToInvitee({
        id: "inv_revoked",
        organizationId: ORGANIZATION.id,
        role: "member",
        status: "revoked",
        expiresAt: LIVE_EXPIRY,
        createdAt: OLDER,
      }),
    ]);

    const admission = await admitInvitee("member");

    expect(admission).toEqual({ admitted: false, reason: "invitation_revoked" });
    expect(await readMemberships()).toEqual([]);
    expect(await readInvitations(getDb(env))).toEqual([
      invitationRow({
        id: "inv_revoked",
        organizationId: ORGANIZATION.id,
        role: "member",
        status: "revoked",
        accepted: false,
      }),
    ]);
  });

  it("expires a lapsed pending invitation and admits at the Clerk role", async () => {
    await seedInvitations(getDb(env), [
      invitationToInvitee({
        id: "inv_lapsed",
        organizationId: ORGANIZATION.id,
        role: "member",
        status: "pending",
        expiresAt: LAPSED_EXPIRY,
        createdAt: OLDER,
      }),
    ]);

    const admission = await admitInvitee("admin");

    expect(admission).toEqual({ admitted: true, role: "admin", joined: true });
    expect(await readMemberships()).toEqual([
      {
        id: MINTED_MEMBERSHIP_ID,
        organization_id: ORGANIZATION.id,
        user_id: INVITEE.id,
        role: "admin",
        status: "active",
      },
    ]);
    expect(await readInvitations(getDb(env))).toEqual([
      invitationRow({
        id: "inv_lapsed",
        organizationId: ORGANIZATION.id,
        role: "member",
        status: "expired",
        accepted: false,
      }),
    ]);
  });

  it("admits at the Clerk role when a lapsed pending invitation is newer than a revoked one", async () => {
    await seedInvitations(getDb(env), [
      invitationToInvitee({
        id: "inv_lapsed",
        organizationId: ORGANIZATION.id,
        role: "admin",
        status: "pending",
        expiresAt: LAPSED_EXPIRY,
        createdAt: NEWER,
      }),
      invitationToInvitee({
        id: "inv_revoked",
        organizationId: ORGANIZATION.id,
        role: "admin",
        status: "revoked",
        expiresAt: LIVE_EXPIRY,
        createdAt: OLDER,
      }),
    ]);

    const admission = await admitInvitee("member");

    expect(admission).toEqual({ admitted: true, role: "member", joined: true });
    expect(await readMemberships()).toEqual([
      {
        id: MINTED_MEMBERSHIP_ID,
        organization_id: ORGANIZATION.id,
        user_id: INVITEE.id,
        role: "member",
        status: "active",
      },
    ]);
    expect(await readInvitations(getDb(env))).toEqual([
      invitationRow({
        id: "inv_lapsed",
        organizationId: ORGANIZATION.id,
        role: "admin",
        status: "expired",
        accepted: false,
      }),
      invitationRow({
        id: "inv_revoked",
        organizationId: ORGANIZATION.id,
        role: "admin",
        status: "revoked",
        accepted: false,
      }),
    ]);
  });

  it("refuses when a revoked invitation is newer than a lapsed pending one, still expiring it", async () => {
    await seedInvitations(getDb(env), [
      invitationToInvitee({
        id: "inv_lapsed",
        organizationId: ORGANIZATION.id,
        role: "member",
        status: "pending",
        expiresAt: LAPSED_EXPIRY,
        createdAt: OLDER,
      }),
      invitationToInvitee({
        id: "inv_revoked",
        organizationId: ORGANIZATION.id,
        role: "member",
        status: "revoked",
        expiresAt: LIVE_EXPIRY,
        createdAt: NEWER,
      }),
    ]);

    const admission = await admitInvitee("member");

    expect(admission).toEqual({ admitted: false, reason: "invitation_revoked" });
    expect(await readMemberships()).toEqual([]);
    expect(await readInvitations(getDb(env))).toEqual([
      invitationRow({
        id: "inv_lapsed",
        organizationId: ORGANIZATION.id,
        role: "member",
        status: "expired",
        accepted: false,
      }),
      invitationRow({
        id: "inv_revoked",
        organizationId: ORGANIZATION.id,
        role: "member",
        status: "revoked",
        accepted: false,
      }),
    ]);
  });

  it("matches the invitation to the verified email regardless of case", async () => {
    await seedInvitations(getDb(env), [
      invitationToInvitee({
        id: "inv_case",
        organizationId: ORGANIZATION.id,
        role: "member",
        status: "pending",
        expiresAt: LIVE_EXPIRY,
        createdAt: OLDER,
      }),
    ]);

    const admission = await admitOrganizationMember(getDb(env), {
      organizationId: ORGANIZATION.id,
      userId: INVITEE.id,
      email: "Invitee@Admission.TEST",
      clerkRole: "admin",
    });

    expect(admission).toEqual({ admitted: true, role: "member", joined: true });
    expect(await readMemberships()).toEqual([
      {
        id: MINTED_MEMBERSHIP_ID,
        organization_id: ORGANIZATION.id,
        user_id: INVITEE.id,
        role: "member",
        status: "active",
      },
    ]);
    expect(await readInvitations(getDb(env))).toEqual([
      invitationRow({
        id: "inv_case",
        organizationId: ORGANIZATION.id,
        role: "member",
        status: "accepted",
        accepted: true,
      }),
    ]);
  });

  it("creates exactly one membership when two admissions for the same user race", async () => {
    const admissions = await Promise.all([admitInvitee("member"), admitInvitee("member")]);

    expect(admissions).toEqual(
      expect.arrayContaining([
        { admitted: true, role: "member", joined: true },
        { admitted: true, role: "member", joined: false },
      ])
    );
    expect(await readMemberships()).toEqual([
      {
        id: MINTED_MEMBERSHIP_ID,
        organization_id: ORGANIZATION.id,
        user_id: INVITEE.id,
        role: "member",
        status: "active",
      },
    ]);
  });
});
