import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { MEMBER_STATUSES, type MemberStatus } from "@sdp/types/organizations";
import { ORGANIZATION_ROLES, type OrganizationRole } from "@sdp/types/roles";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb, type PreparedStatement } from "@/db/client";
import { app } from "@/index";
import {
  clerkHeadersWithoutProject,
  ensureTestClerkIssuer,
  seedClerkIdentity,
  signTestClerkJwt,
} from "@/test/helpers/clerk";
import { env } from "@/test/helpers/env";
import { readInvitationStatus, seedInvitation } from "@/test/helpers/invitations";
import { organizationMember, seedOrganizationMembers } from "@/test/helpers/organization-members";
import {
  archiveProject,
  type SeededDefaultProjects,
  seedDefaultProjects,
} from "@/test/helpers/projects";
import { holdTransaction, untilLockWaiters } from "@/test/helpers/row-locks";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const ORGANIZATION = { id: "org_admission", slug: "admission" };
const CLERK_ORG_ID = "clerk_org_admission";
const INVITATION_ID = "inv_admission";
const ADMIN = organizationMember("admission_admin", "admin");
const INVITEE = organizationMember("admission_invitee", "member");
let projects: SeededDefaultProjects;

async function signIn(orgRole: "admin" | "member", clerkOrgId: string): Promise<Response> {
  const token = await signTestClerkJwt({
    clerkUserId: `clerk_${INVITEE.userId}`,
    clerkOrgId,
    orgRole,
    orgSlug: ORGANIZATION.slug,
    email: INVITEE.email,
    expiresInSeconds: 300,
  });
  return app.request("/v1/members/me", { headers: clerkHeadersWithoutProject(token) }, env);
}

function invite(role: OrganizationRole, expiresInDays: number) {
  return seedInvitation(getDb(env), {
    id: INVITATION_ID,
    organizationId: ORGANIZATION.id,
    email: INVITEE.email,
    role,
    invitedBy: ADMIN.userId,
    status: "pending",
    expiresInDays,
  });
}

async function setInviteeMembership(
  state: { status: MemberStatus; role: OrganizationRole } | null
): Promise<void> {
  if (state === null) {
    await getDb(env).execute("DELETE FROM organization_members WHERE user_id = ?", [
      INVITEE.userId,
    ]);
    return;
  }
  await getDb(env).execute(
    "UPDATE organization_members SET status = ?, role = ? WHERE user_id = ?",
    [state.status, state.role, INVITEE.userId]
  );
}

const membershipRowSchema = z
  .object({ id: z.string(), role: z.enum(ORGANIZATION_ROLES), status: z.enum(MEMBER_STATUSES) })
  .nullable();

async function inviteeMembership(): Promise<z.infer<typeof membershipRowSchema>> {
  return membershipRowSchema.parse(
    await getDb(env).queryOne(
      "SELECT id, role, status FROM organization_members WHERE user_id = ?",
      [INVITEE.userId]
    )
  );
}

function acceptInviteAudits() {
  return getDb(env).queryMany(
    "SELECT resource_type, resource_id, user_id FROM audit_logs WHERE organization_id = ? AND action = 'accept_invite'",
    [ORGANIZATION.id]
  );
}

const ACCEPT_INVITE_AUDIT = {
  resource_type: "invitation",
  resource_id: INVITATION_ID,
  user_id: INVITEE.userId,
};

async function inviteeProjectIds(): Promise<string[]> {
  const rows = await getDb(env).queryMany<{ project_id: string }>(
    "SELECT project_id FROM project_members WHERE user_id = ? ORDER BY project_id",
    [INVITEE.userId]
  );
  return rows.map((row) => row.project_id);
}

const PENDING_INVITATION_READ =
  /FROM invitations\s+WHERE organization_id = \? AND LOWER\(email\) = \? AND status = 'pending'/;

function readAfter(settled: Promise<Response>, statement: PreparedStatement): PreparedStatement {
  return {
    bind: (...values) => readAfter(settled, statement.bind(...values)),
    first: async <T>(columnName?: string) => {
      await settled;
      return statement.first<T>(columnName);
    },
    all: <T>() => statement.all<T>(),
    run: () => statement.run(),
  };
}

async function expectUnauthorized(response: Response, message: string): Promise<void> {
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ error: { code: "UNAUTHORIZED", message } });
}

describe("sign-in admission", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await ensureTestClerkIssuer(env);
    const db = getDb(env);
    await seedOrganizationMembers(db, { organization: ORGANIZATION, members: [ADMIN] });
    await db.execute(
      "INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')",
      [INVITEE.userId, INVITEE.email]
    );
    await seedClerkIdentity(db, {
      userId: INVITEE.userId,
      email: INVITEE.email,
      clerkUserId: `clerk_${INVITEE.userId}`,
      organizationId: ORGANIZATION.id,
      clerkOrgId: CLERK_ORG_ID,
      orgSlug: ORGANIZATION.slug,
      role: "member",
    });
    projects = await seedDefaultProjects(db, {
      organizationId: ORGANIZATION.id,
      createdBy: ADMIN.userId,
      members: [ADMIN.userId],
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearKVStores(env);
  });

  it("refuses a Clerk admin of a mapped organization who holds no invitation", async () => {
    await setInviteeMembership(null);

    await expectUnauthorized(
      await signIn("admin", CLERK_ORG_ID),
      "No pending invitation to this organization"
    );
    expect(await inviteeMembership()).toBeNull();
  });

  it("expires an invitation past its expiry instead of admitting", async () => {
    await setInviteeMembership(null);
    await invite("member", -1);

    await expectUnauthorized(
      await signIn("member", CLERK_ORG_ID),
      "Invitation to this organization has expired"
    );
    expect(await readInvitationStatus(getDb(env), INVITATION_ID)).toBe("expired");
    expect(await inviteeMembership()).toBeNull();
  });

  it("admits at the invitation's role, never the Clerk role, into every project, audited", async () => {
    await setInviteeMembership(null);
    await invite("admin", 7);

    const response = await signIn("member", CLERK_ORG_ID);

    expect(response.status).toBe(200);
    const membership = await inviteeMembership();
    assert(membership);
    expect(await response.json()).toEqual({
      data: {
        memberId: membership.id,
        userId: INVITEE.userId,
        organizationId: ORGANIZATION.id,
        role: "admin",
      },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
    expect(await readInvitationStatus(getDb(env), INVITATION_ID)).toBe("accepted");
    expect(await inviteeProjectIds()).toEqual([projects.production.id, projects.sandbox.id]);
    expect(await acceptInviteAudits()).toEqual([ACCEPT_INVITE_AUDIT]);
  });

  it("admits on a pending invitation stored in other letter case", async () => {
    await setInviteeMembership(null);
    await seedInvitation(getDb(env), {
      id: INVITATION_ID,
      organizationId: ORGANIZATION.id,
      email: INVITEE.email.toUpperCase(),
      role: "admin",
      invitedBy: ADMIN.userId,
      status: "pending",
      expiresInDays: 7,
    });

    expect((await signIn("member", CLERK_ORG_ID)).status).toBe(200);
    expect(await inviteeMembership()).toMatchObject({ role: "admin", status: "active" });
    expect(await readInvitationStatus(getDb(env), INVITATION_ID)).toBe("accepted");
  });

  it("reactivates a removed membership at the new invitation's role", async () => {
    await setInviteeMembership({ status: "removed", role: "admin" });
    const removed = await inviteeMembership();
    assert(removed);
    await invite("member", 7);

    expect((await signIn("member", CLERK_ORG_ID)).status).toBe(200);
    expect(await inviteeMembership()).toEqual({ id: removed.id, role: "member", status: "active" });
  });

  it("refuses a suspended member and leaves their invitation pending", async () => {
    await setInviteeMembership({ status: "suspended", role: "member" });
    await invite("member", 7);

    await expectUnauthorized(
      await signIn("member", CLERK_ORG_ID),
      "Organization membership is inactive"
    );
    expect(await readInvitationStatus(getDb(env), INVITATION_ID)).toBe("pending");
  });

  it("refuses a Clerk organization SDP never created, creating none", async () => {
    await expectUnauthorized(
      await signIn("admin", "clerk_org_unmapped"),
      "Organization is not provisioned in SDP"
    );
    expect(await getDb(env).queryMany("SELECT id FROM organizations")).toEqual([
      { id: ORGANIZATION.id },
    ]);
  });

  it("does not restore an established member's missing project memberships", async () => {
    expect((await signIn("member", CLERK_ORG_ID)).status).toBe(200);
    expect(await inviteeProjectIds()).toEqual([]);
  });

  it("rolls the claim, membership and audit back together when admission fails", async () => {
    await archiveProject(getDb(env), projects.sandbox.id);
    await archiveProject(getDb(env), projects.production.id);
    await setInviteeMembership(null);
    await invite("member", 7);

    const response = await signIn("member", CLERK_ORG_ID);

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "INTERNAL_ERROR", message: "Organization has no active projects" },
    });
    expect(await readInvitationStatus(getDb(env), INVITATION_ID)).toBe("pending");
    expect(await inviteeMembership()).toBeNull();
    expect(await inviteeProjectIds()).toEqual([]);
    expect(await acceptInviteAudits()).toEqual([]);
  });

  it("admits concurrent first sign-ins on one invitation once, answering both", async () => {
    await setInviteeMembership(null);
    await invite("member", 7);
    const blocker = await holdTransaction(getDb(env), async (tx) => {
      await tx.execute("SELECT id FROM invitations WHERE id = ? FOR UPDATE", [INVITATION_ID]);
    });

    const signingIn = Promise.all([signIn("member", CLERK_ORG_ID), signIn("member", CLERK_ORG_ID)]);
    await untilLockWaiters(getDb(env), { fragment: "SET status = 'accepted'", count: 1 });
    await untilLockWaiters(getDb(env), { fragment: "pg_advisory_lock", count: 1 });
    await blocker.commit();
    const responses = await signingIn;

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await inviteeMembership()).toMatchObject({ role: "member", status: "active" });
    expect(await readInvitationStatus(getDb(env), INVITATION_ID)).toBe("accepted");
    expect(await acceptInviteAudits()).toEqual([ACCEPT_INVITE_AUDIT]);
  });

  it("answers the winner's role when a concurrent admission claims the invitation between its reads", async () => {
    await setInviteeMembership(null);
    await invite("admin", 7);
    const db = getDb(env);
    const prepare = db.prepare.bind(db);
    const outsideRequest = AsyncLocalStorage.snapshot();
    const competingSignIns: Promise<Response>[] = [];
    vi.spyOn(db, "prepare").mockImplementation((query) => {
      if (competingSignIns.length > 0 || !PENDING_INVITATION_READ.test(query)) {
        return prepare(query);
      }
      const competingSignIn = outsideRequest(() => signIn("member", CLERK_ORG_ID));
      competingSignIns.push(competingSignIn);
      return readAfter(competingSignIn, prepare(query));
    });

    const response = await signIn("member", CLERK_ORG_ID);

    const competing = await Promise.all(competingSignIns);
    expect(competing.map((competingResponse) => competingResponse.status)).toEqual([200]);
    const membership = await inviteeMembership();
    assert(membership);
    expect(membership).toMatchObject({ role: "admin", status: "active" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        memberId: membership.id,
        userId: INVITEE.userId,
        organizationId: ORGANIZATION.id,
        role: "admin",
      },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
    expect(await readInvitationStatus(getDb(env), INVITATION_ID)).toBe("accepted");
    expect(await acceptInviteAudits()).toEqual([ACCEPT_INVITE_AUDIT]);
  });
});
