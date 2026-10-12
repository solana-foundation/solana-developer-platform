import type { InvitationStatus } from "@sdp/types";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import {
  revokePendingInvitationsForOrganization,
  revokePendingInvitationsForUser,
} from "@/lib/invitations";
import { seedClerkIdentity } from "@/test/helpers/clerk";
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
const CREATED_AT = "2026-01-01 00:00:00";
const ACCEPTED_AT = "2026-01-02 00:00:00";

const ORGANIZATION = createOrganization({ id: "org_invitations", slug: "invitations" });
const OTHER_ORGANIZATION = createOrganization({
  id: "org_invitations_other",
  slug: "invitations-other",
});
const INVITER = createUser({ id: "usr_invitations_inviter", email: "inviter@invitations.test" });
const MEMBER = createUser({ id: "usr_invitations_member", email: "Member@Invitations.TEST" });

const ACCOUNT_EMAIL = "member@invitations.test";
const ALIAS_EMAIL = "member.alias@invitations.test";
const BYSTANDER_EMAIL = "bystander@invitations.test";

interface SeededInvitation {
  id: string;
  organizationId: string;
  email: string;
  status: InvitationStatus;
}

const ACCOUNT_PENDING: SeededInvitation = {
  id: "inv_account_pending",
  organizationId: ORGANIZATION.id,
  email: ACCOUNT_EMAIL,
  status: "pending",
};
const ALIAS_PENDING: SeededInvitation = {
  id: "inv_alias_pending",
  organizationId: ORGANIZATION.id,
  email: ALIAS_EMAIL,
  status: "pending",
};
const ACCOUNT_ACCEPTED: SeededInvitation = {
  id: "inv_account_accepted",
  organizationId: ORGANIZATION.id,
  email: ACCOUNT_EMAIL,
  status: "accepted",
};
const ALIAS_EXPIRED: SeededInvitation = {
  id: "inv_alias_expired",
  organizationId: ORGANIZATION.id,
  email: ALIAS_EMAIL,
  status: "expired",
};
const OTHER_ORGANIZATION_PENDING: SeededInvitation = {
  id: "inv_other_org_pending",
  organizationId: OTHER_ORGANIZATION.id,
  email: ACCOUNT_EMAIL,
  status: "pending",
};
const BYSTANDER_PENDING: SeededInvitation = {
  id: "inv_bystander_pending",
  organizationId: ORGANIZATION.id,
  email: BYSTANDER_EMAIL,
  status: "pending",
};

function acceptedAtFor(status: InvitationStatus): string | null {
  return status === "accepted" ? ACCEPTED_AT : null;
}

function expiresAtFor(status: InvitationStatus): string {
  return status === "expired" ? LAPSED_EXPIRY : LIVE_EXPIRY;
}

function invitationSeed(invitation: SeededInvitation): InvitationSeed {
  return {
    ...invitation,
    role: "member",
    invitedBy: INVITER.id,
    tokenHash: `hash_${invitation.id}`,
    expiresAt: expiresAtFor(invitation.status),
    createdAt: CREATED_AT,
    acceptedAt: acceptedAtFor(invitation.status),
    clerkInvitationId: null,
  };
}

function invitationRow(invitation: SeededInvitation, status: InvitationStatus): InvitationRow {
  return {
    id: invitation.id,
    organization_id: invitation.organizationId,
    email: invitation.email,
    role: "member",
    status,
    accepted_at: acceptedAtFor(invitation.status),
  };
}

describe("pending invitation revocation", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await seedOrganizationsAndUsers(db, {
      organizations: [ORGANIZATION, OTHER_ORGANIZATION],
      users: [INVITER, MEMBER],
    });
    await seedClerkIdentity(db, {
      userId: MEMBER.id,
      email: "Member.Alias@Invitations.TEST",
      clerkUserId: "clerk_user_invitations_member",
      organizationId: ORGANIZATION.id,
      clerkOrgId: "clerk_org_invitations",
      orgSlug: ORGANIZATION.slug,
      role: "member",
    });
    await seedInvitations(
      db,
      [
        ACCOUNT_PENDING,
        ALIAS_PENDING,
        ACCOUNT_ACCEPTED,
        ALIAS_EXPIRED,
        OTHER_ORGANIZATION_PENDING,
        BYSTANDER_PENDING,
      ].map(invitationSeed)
    );
  });

  it("revokes the organization's pending invitations to any address the user is known by, regardless of case", async () => {
    await revokePendingInvitationsForUser(getDb(env), ORGANIZATION.id, MEMBER.id);

    expect(await readInvitations(getDb(env))).toEqual([
      invitationRow(ACCOUNT_ACCEPTED, "accepted"),
      invitationRow(ACCOUNT_PENDING, "revoked"),
      invitationRow(ALIAS_EXPIRED, "expired"),
      invitationRow(ALIAS_PENDING, "revoked"),
      invitationRow(BYSTANDER_PENDING, "pending"),
      invitationRow(OTHER_ORGANIZATION_PENDING, "pending"),
    ]);
  });

  it("revokes every pending invitation of the organization and nothing elsewhere", async () => {
    await revokePendingInvitationsForOrganization(getDb(env), ORGANIZATION.id);

    expect(await readInvitations(getDb(env))).toEqual([
      invitationRow(ACCOUNT_ACCEPTED, "accepted"),
      invitationRow(ACCOUNT_PENDING, "revoked"),
      invitationRow(ALIAS_EXPIRED, "expired"),
      invitationRow(ALIAS_PENDING, "revoked"),
      invitationRow(BYSTANDER_PENDING, "revoked"),
      invitationRow(OTHER_ORGANIZATION_PENDING, "pending"),
    ]);
  });
});
