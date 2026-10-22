import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { readAuditActions } from "@/test/helpers/audit-logs";
import { clerkHeaders, clerkHeadersWithoutProject } from "@/test/helpers/clerk";
import { type ClerkBackend, stubClerkBackend } from "@/test/helpers/clerk-backend";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { env } from "@/test/helpers/env";
import { readInvitationStatus, seedInvitation } from "@/test/helpers/invitations";
import {
  organizationMember,
  type SeededOrganizationMember,
  seedOrganizationMembers,
} from "@/test/helpers/organization-members";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const ORGANIZATION = { id: "org_membership_rules", slug: "membership-rules" };
const ADMIN_A = organizationMember("rules_admin_a", "admin");
const ADMIN_B = organizationMember("rules_admin_b", "admin");
const MEMBER = organizationMember("rules_member", "member");
const FOREIGN_MEMBER = organizationMember("rules_foreign", "member");
let sandboxProjectId: string;
let clerk: ClerkBackend;

async function requestAs(
  actor: SeededOrganizationMember,
  method: "PATCH" | "DELETE",
  memberId: string,
  body: { role: string } | null
): Promise<Response> {
  const token = await signSeededClerkMember(env, getDb(env), actor.userId, ORGANIZATION.id);
  return app.request(
    `/v1/members/${memberId}`,
    {
      method,
      headers: clerkHeaders(token, sandboxProjectId),
      body: body === null ? null : JSON.stringify(body),
    },
    env
  );
}

async function removeWithKey(
  target: SeededOrganizationMember,
  idempotencyKey: string
): Promise<Response> {
  const token = await signSeededClerkMember(env, getDb(env), ADMIN_A.userId, ORGANIZATION.id);
  return app.request(
    `/v1/members/${target.memberId}`,
    {
      method: "DELETE",
      headers: { ...clerkHeaders(token, sandboxProjectId), "Idempotency-Key": idempotencyKey },
    },
    env
  );
}

const CLERK_MEMBERSHIP_DELETE = {
  method: "DELETE",
  path: `/organizations/clerk_org_${ORGANIZATION.id}/memberships/clerk_user_${MEMBER.userId}`,
  body: null,
};

function membership(member: SeededOrganizationMember) {
  return getDb(env).queryOne("SELECT role, status FROM organization_members WHERE id = ?", [
    member.memberId,
  ]);
}

function projectMemberships(member: SeededOrganizationMember) {
  return getDb(env).queryMany("SELECT id FROM project_members WHERE user_id = ?", [member.userId]);
}

async function expectConflict(response: Response, message: string): Promise<void> {
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "CONFLICT", message } });
}

describe("organization membership rules", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await seedOrganizationMembers(db, {
      organization: ORGANIZATION,
      members: [ADMIN_A, ADMIN_B, MEMBER],
    });
    await seedOrganizationMembers(db, {
      organization: { id: "org_membership_rules_foreign", slug: "membership-foreign" },
      members: [FOREIGN_MEMBER],
    });
    const projects = await seedDefaultProjects(db, {
      organizationId: ORGANIZATION.id,
      createdBy: ADMIN_A.userId,
      members: [ADMIN_A.userId, ADMIN_B.userId, MEMBER.userId],
    });
    sandboxProjectId = projects.sandbox.id;
    clerk = stubClerkBackend(env);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearKVStores(env);
    env.CLERK_SECRET_KEY = undefined;
    env.CLERK_API_URL = undefined;
  });

  it("refuses an admin changing their own role", async () => {
    await expectConflict(
      await requestAs(ADMIN_A, "PATCH", ADMIN_A.memberId, { role: "member" }),
      "An admin cannot change their own role"
    );
    expect(await membership(ADMIN_A)).toEqual({ role: "admin", status: "active" });
  });

  it("promotes a member to admin", async () => {
    const response = await requestAs(ADMIN_A, "PATCH", MEMBER.memberId, { role: "admin" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        memberId: MEMBER.memberId,
        userId: MEMBER.userId,
        organizationId: ORGANIZATION.id,
        role: "admin",
      },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
    expect(await membership(MEMBER)).toEqual({ role: "admin", status: "active" });
  });

  it("refuses a member changing a role", async () => {
    expect((await requestAs(MEMBER, "PATCH", ADMIN_B.memberId, { role: "member" })).status).toBe(
      403
    );
    expect(await membership(ADMIN_B)).toEqual({ role: "admin", status: "active" });
  });

  it("does not find a member of another organization", async () => {
    const response = await requestAs(ADMIN_A, "PATCH", FOREIGN_MEMBER.memberId, { role: "admin" });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: "Member not found" },
    });
    expect(await membership(FOREIGN_MEMBER)).toEqual({ role: "member", status: "active" });
  });

  it("refuses an admin leaving", async () => {
    await expectConflict(
      await requestAs(ADMIN_A, "DELETE", "me", null),
      "An admin cannot leave the organization"
    );
    expect(await membership(ADMIN_A)).toEqual({ role: "admin", status: "active" });
  });

  it("ends a leaving member's project access and pending invitations", async () => {
    await seedInvitation(getDb(env), {
      id: "inv_rules_member",
      organizationId: ORGANIZATION.id,
      email: MEMBER.email,
      role: "admin",
      invitedBy: ADMIN_A.userId,
      status: "pending",
      expiresInDays: 7,
    });

    clerk.answer({ status: 200, body: {} });

    expect((await requestAs(MEMBER, "DELETE", "me", null)).status).toBe(204);
    expect(await membership(MEMBER)).toEqual({ role: "member", status: "removed" });
    expect(await projectMemberships(MEMBER)).toEqual([]);
    expect(await readInvitationStatus(getDb(env), "inv_rules_member")).toBe("revoked");
  });

  it.each(["without a project header", "with a stale project header"])(
    "lets a member with no project access leave %s",
    async (scenario) => {
      await getDb(env).execute("DELETE FROM project_members WHERE user_id = ?", [MEMBER.userId]);
      const token = await signSeededClerkMember(env, getDb(env), MEMBER.userId, ORGANIZATION.id);
      clerk.answer({ status: 200, body: {} });

      const response = await app.request(
        "/v1/members/me",
        {
          method: "DELETE",
          headers:
            scenario === "with a stale project header"
              ? clerkHeaders(token, sandboxProjectId)
              : clerkHeadersWithoutProject(token),
        },
        env
      );

      expect(response.status).toBe(204);
      expect(await membership(MEMBER)).toEqual({ role: "member", status: "removed" });
      expect(
        (await app.request("/v1/members/me", { headers: clerkHeadersWithoutProject(token) }, env))
          .status
      ).toBe(401);
    }
  );

  it("refuses an admin removing themselves", async () => {
    await expectConflict(
      await requestAs(ADMIN_A, "DELETE", ADMIN_A.memberId, null),
      "You cannot remove yourself from the organization"
    );
    expect(await membership(ADMIN_A)).toEqual({ role: "admin", status: "active" });
  });

  it("removes another admin and their project access", async () => {
    expect((await requestAs(ADMIN_A, "DELETE", ADMIN_B.memberId, null)).status).toBe(204);
    expect(await membership(ADMIN_B)).toEqual({ role: "admin", status: "removed" });
    expect(await projectMemberships(ADMIN_B)).toEqual([]);
  });

  it("commits and audits a removal whose Clerk half fails, and a retry finishes only the Clerk half", async () => {
    await signSeededClerkMember(env, getDb(env), MEMBER.userId, ORGANIZATION.id);
    clerk.answer({ status: 500, body: { errors: [] } });

    expect((await removeWithKey(MEMBER, "idem_rules_remove_retry")).status).toBe(500);
    expect(await membership(MEMBER)).toEqual({ role: "member", status: "removed" });

    clerk.answer({ status: 200, body: {} });

    expect((await removeWithKey(MEMBER, "idem_rules_remove_retry")).status).toBe(204);
    expect(clerk.requests).toEqual([CLERK_MEMBERSHIP_DELETE, CLERK_MEMBERSHIP_DELETE]);
    expect(await readAuditActions(getDb(env), { type: "member", id: MEMBER.memberId })).toEqual([
      "delete",
    ]);
  });

  it("treats a membership Clerk no longer has as removed there", async () => {
    await signSeededClerkMember(env, getDb(env), MEMBER.userId, ORGANIZATION.id);
    clerk.answer({ status: 404, body: { errors: [] } });

    expect((await removeWithKey(MEMBER, "idem_rules_remove_gone")).status).toBe(204);
    expect(clerk.requests).toEqual([CLERK_MEMBERSHIP_DELETE]);
    expect(await membership(MEMBER)).toEqual({ role: "member", status: "removed" });
  });

  it("ends a leaving member's membership even when Clerk fails", async () => {
    clerk.answer({ status: 500, body: { errors: [] } });

    expect((await requestAs(MEMBER, "DELETE", "me", null)).status).toBe(500);
    expect(clerk.requests).toEqual([CLERK_MEMBERSHIP_DELETE]);
    expect(await membership(MEMBER)).toEqual({ role: "member", status: "removed" });
  });
});
