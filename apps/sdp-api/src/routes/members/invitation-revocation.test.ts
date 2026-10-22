import type { InvitationStatus } from "@sdp/types/organizations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { readAuditActions } from "@/test/helpers/audit-logs";
import { clerkHeaders } from "@/test/helpers/clerk";
import { type ClerkBackend, stubClerkBackend } from "@/test/helpers/clerk-backend";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { env } from "@/test/helpers/env";
import { readInvitationStatus, seedInvitation } from "@/test/helpers/invitations";
import { organizationMember, seedOrganizationMembers } from "@/test/helpers/organization-members";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const ORGANIZATION = { id: "org_invitation_revocation", slug: "invitation-revocation" };
const FOREIGN_ORGANIZATION = { id: "org_revocation_foreign", slug: "revocation-foreign" };
const CLERK_ORG_ID = `clerk_org_${ORGANIZATION.id}`;
const ADMIN = organizationMember("revocation_admin", "admin");
const FOREIGN_ADMIN = organizationMember("revocation_foreign_admin", "admin");
const INVITATION_ID = "inv_revocation_target";
const INVITEE_EMAIL = "revocation-invitee@example.com";
const OUR_CLERK_INVITATION_ID = "orginv_ours";
const OTHER_CLERK_INVITATION_ID = "orginv_theirs";
const LIST_PATH = `/organizations/${CLERK_ORG_ID}/invitations?status=pending&limit=100&offset=0`;

let clerk: ClerkBackend;
let adminToken: string;
let sandboxProjectId: string;

function clerkInvitation(id: string) {
  return { id, email_address: INVITEE_EMAIL, role: "org:member", status: "pending" };
}

function listAnswer(ids: readonly string[]) {
  return { status: 200, body: { data: ids.map(clerkInvitation) } };
}

function revokeRequest(clerkInvitationId: string) {
  return {
    method: "POST",
    path: `/organizations/${CLERK_ORG_ID}/invitations/${clerkInvitationId}/revoke`,
    body: null,
  };
}

const LIST_REQUEST = { method: "GET", path: LIST_PATH, body: null };

async function seedTarget(input: {
  organizationId: string;
  invitedBy: string;
  status: InvitationStatus;
  clerkInvitationId: string | null;
}): Promise<void> {
  const db = getDb(env);
  await seedInvitation(db, {
    id: INVITATION_ID,
    organizationId: input.organizationId,
    email: INVITEE_EMAIL,
    role: "member",
    invitedBy: input.invitedBy,
    status: input.status,
    expiresInDays: 7,
  });
  await db.execute("UPDATE invitations SET clerk_invitation_id = ? WHERE id = ?", [
    input.clerkInvitationId,
    INVITATION_ID,
  ]);
}

function seedOwnPendingTarget(clerkInvitationId: string | null) {
  return seedTarget({
    organizationId: ORGANIZATION.id,
    invitedBy: ADMIN.userId,
    status: "pending",
    clerkInvitationId,
  });
}

async function revoke(idempotencyKey: string): Promise<Response> {
  return app.request(
    `/v1/members/invitations/${INVITATION_ID}`,
    {
      method: "DELETE",
      headers: { ...clerkHeaders(adminToken, sandboxProjectId), "Idempotency-Key": idempotencyKey },
    },
    env
  );
}

function revokeAudits() {
  return readAuditActions(getDb(env), { type: "invitation", id: INVITATION_ID });
}

describe("DELETE /v1/members/invitations/:invitationId", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await seedOrganizationMembers(db, { organization: ORGANIZATION, members: [ADMIN] });
    await seedOrganizationMembers(db, {
      organization: FOREIGN_ORGANIZATION,
      members: [FOREIGN_ADMIN],
    });
    const projects = await seedDefaultProjects(db, {
      organizationId: ORGANIZATION.id,
      createdBy: ADMIN.userId,
      members: [ADMIN.userId],
    });
    sandboxProjectId = projects.sandbox.id;
    adminToken = await signSeededClerkMember(env, db, ADMIN.userId, ORGANIZATION.id);
    clerk = stubClerkBackend(env);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearKVStores(env);
    env.CLERK_SECRET_KEY = undefined;
    env.CLERK_API_URL = undefined;
  });

  it("revokes in SDP and audits, then revokes only this row's Clerk invitation naming no user", async () => {
    await seedOwnPendingTarget(OUR_CLERK_INVITATION_ID);
    clerk.answer(listAnswer([OUR_CLERK_INVITATION_ID, OTHER_CLERK_INVITATION_ID]), {
      status: 200,
      body: { id: OUR_CLERK_INVITATION_ID, status: "revoked" },
    });

    expect((await revoke("idem_revocation_ours")).status).toBe(204);
    expect(clerk.requests).toEqual([LIST_REQUEST, revokeRequest(OUR_CLERK_INVITATION_ID)]);
    expect(await readInvitationStatus(getDb(env), INVITATION_ID)).toBe("revoked");
    expect(await revokeAudits()).toEqual(["revoke"]);
  });

  it("keeps the invitation revoked when Clerk fails, and a retry re-runs only the Clerk half", async () => {
    await seedOwnPendingTarget(OUR_CLERK_INVITATION_ID);
    clerk.answer(listAnswer([OUR_CLERK_INVITATION_ID]), { status: 500, body: { errors: [] } });

    expect((await revoke("idem_revocation_retry")).status).toBe(500);
    expect(await readInvitationStatus(getDb(env), INVITATION_ID)).toBe("revoked");

    clerk.answer(listAnswer([OUR_CLERK_INVITATION_ID]), {
      status: 200,
      body: { id: OUR_CLERK_INVITATION_ID, status: "revoked" },
    });

    expect((await revoke("idem_revocation_retry")).status).toBe(204);
    expect(clerk.requests).toEqual([
      LIST_REQUEST,
      revokeRequest(OUR_CLERK_INVITATION_ID),
      LIST_REQUEST,
      revokeRequest(OUR_CLERK_INVITATION_ID),
    ]);
    expect(await readInvitationStatus(getDb(env), INVITATION_ID)).toBe("revoked");
    expect(await revokeAudits()).toEqual(["revoke"]);
  });

  it("calls no revoke when Clerk no longer holds the invitation as pending", async () => {
    await seedOwnPendingTarget(OUR_CLERK_INVITATION_ID);
    clerk.answer(listAnswer([OTHER_CLERK_INVITATION_ID]));

    expect((await revoke("idem_revocation_gone")).status).toBe(204);
    expect(clerk.requests).toEqual([LIST_REQUEST]);
    expect(await readInvitationStatus(getDb(env), INVITATION_ID)).toBe("revoked");
  });

  it("revokes every pending Clerk invitation for the address when the row has no Clerk id", async () => {
    await seedOwnPendingTarget(null);
    clerk.answer(
      listAnswer([OUR_CLERK_INVITATION_ID, OTHER_CLERK_INVITATION_ID]),
      { status: 200, body: { id: OUR_CLERK_INVITATION_ID, status: "revoked" } },
      { status: 200, body: { id: OTHER_CLERK_INVITATION_ID, status: "revoked" } }
    );

    expect((await revoke("idem_revocation_unlinked")).status).toBe(204);
    expect(clerk.requests).toEqual([
      LIST_REQUEST,
      revokeRequest(OUR_CLERK_INVITATION_ID),
      revokeRequest(OTHER_CLERK_INVITATION_ID),
    ]);
  });

  it("does not match newer Clerk invitations by address when retrying a revoked row with no Clerk id", async () => {
    await seedTarget({
      organizationId: ORGANIZATION.id,
      invitedBy: ADMIN.userId,
      status: "revoked",
      clerkInvitationId: null,
    });
    await seedInvitation(getDb(env), {
      id: "inv_revocation_newer",
      organizationId: ORGANIZATION.id,
      email: INVITEE_EMAIL,
      role: "member",
      invitedBy: ADMIN.userId,
      status: "pending",
      expiresInDays: 7,
    });
    await getDb(env).execute("UPDATE invitations SET clerk_invitation_id = ? WHERE id = ?", [
      OTHER_CLERK_INVITATION_ID,
      "inv_revocation_newer",
    ]);

    expect((await revoke("idem_revocation_unlinked_retry")).status).toBe(204);
    expect(clerk.requests).toEqual([]);
    expect(await readInvitationStatus(getDb(env), "inv_revocation_newer")).toBe("pending");
  });

  it.each([
    {
      target: "an accepted invitation",
      organizationId: ORGANIZATION.id,
      invitedBy: ADMIN.userId,
      status: "accepted",
      expected: 400,
    },
    {
      target: "another organization's invitation",
      organizationId: FOREIGN_ORGANIZATION.id,
      invitedBy: FOREIGN_ADMIN.userId,
      status: "pending",
      expected: 404,
    },
  ] as const)(
    "refuses $target without calling Clerk",
    async ({ organizationId, invitedBy, status, expected }) => {
      await seedTarget({
        organizationId,
        invitedBy,
        status,
        clerkInvitationId: OUR_CLERK_INVITATION_ID,
      });

      expect((await revoke("idem_revocation_refused")).status).toBe(expected);
      expect(clerk.requests).toEqual([]);
      expect(await readInvitationStatus(getDb(env), INVITATION_ID)).toBe(status);
      expect(await revokeAudits()).toEqual([]);
    }
  );
});
