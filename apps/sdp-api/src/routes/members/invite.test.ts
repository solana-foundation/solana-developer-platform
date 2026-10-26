import { INVITATION_STATUSES } from "@sdp/types/organizations";
import { ORGANIZATION_ROLES } from "@sdp/types/roles";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { ClerkOrganizationsService } from "@/services/clerk-organizations.service";
import { readAuditActions } from "@/test/helpers/audit-logs";
import { clerkHeaders } from "@/test/helpers/clerk";
import { type ClerkBackend, stubClerkBackend } from "@/test/helpers/clerk-backend";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { env } from "@/test/helpers/env";
import { readInvitationStatus, seedInvitation } from "@/test/helpers/invitations";
import {
  organizationMember,
  seedActiveMemberships,
  seedOrganizationMembers,
} from "@/test/helpers/organization-members";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const ORGANIZATION = { id: "org_invite_rules", slug: "invite-rules" };
const CLERK_ORG_ID = `clerk_org_${ORGANIZATION.id}`;
const ADMIN = organizationMember("invite_admin", "admin");
const INVITEE_EMAIL = "invitee@example.com";
const CLERK_INVITATION_ID = "orginv_invite_created";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const CLERK_INVITATION_BODY = {
  email_address: INVITEE_EMAIL,
  role: "org:member",
  expires_in_days: 7,
  redirect_url: "https://dash.example.test/sign-in",
};
const SEAT_HOLDERS = Array.from({ length: 18 }, (_, index) =>
  organizationMember(`invite_seat_${index}`, "member")
);

const invitationRowSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(ORGANIZATION_ROLES),
  status: z.enum(INVITATION_STATUSES),
  expires_at: z.string(),
  clerk_invitation_id: z.string().nullable(),
});

const createdInvitationSchema = z.object({
  data: z.object({ invitation: z.object({ id: z.string() }) }),
});

let clerk: ClerkBackend;
let adminToken: string;
let sandboxProjectId: string;

async function invite(email: string): Promise<Response> {
  return app.request(
    "/v1/members/invite",
    {
      method: "POST",
      headers: clerkHeaders(adminToken, sandboxProjectId),
      body: JSON.stringify({ email, role: "admin" }),
    },
    env
  );
}

async function invitationRows() {
  return z
    .array(invitationRowSchema)
    .parse(
      await getDb(env).queryMany(
        "SELECT id, email, role, status, expires_at, clerk_invitation_id FROM invitations WHERE organization_id = ? ORDER BY created_at, id",
        [ORGANIZATION.id]
      )
    );
}

function seedPendingInvitation(id: string, email: string, expiresInDays: number) {
  return seedInvitation(getDb(env), {
    id,
    organizationId: ORGANIZATION.id,
    email,
    role: "member",
    invitedBy: ADMIN.userId,
    status: "pending",
    expiresInDays,
  });
}

describe("POST /v1/members/invite", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await seedOrganizationMembers(db, { organization: ORGANIZATION, members: [ADMIN] });
    const projects = await seedDefaultProjects(db, {
      organizationId: ORGANIZATION.id,
      createdBy: ADMIN.userId,
      members: [ADMIN.userId],
    });
    sandboxProjectId = projects.sandbox.id;
    adminToken = await signSeededClerkMember(env, db, ADMIN.userId, ORGANIZATION.id);
    clerk = stubClerkBackend(env);
    env.FRONTEND_URL = "https://dash.example.test/app/";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearKVStores(env);
    env.CLERK_SECRET_KEY = undefined;
    env.CLERK_API_URL = undefined;
    env.FRONTEND_URL = undefined;
  });

  it("claims the address, audits it, then invites in Clerk as org:member landing on the dashboard origin's sign-in page", async () => {
    clerk.answer({ status: 200, body: { id: CLERK_INVITATION_ID, status: "pending" } });

    const before = Date.now();
    const response = await invite("Invitee@Example.com");
    const after = Date.now();

    expect(response.status).toBe(201);
    expect(clerk.requests).toEqual([
      {
        method: "POST",
        path: `/organizations/${CLERK_ORG_ID}/invitations`,
        body: CLERK_INVITATION_BODY,
      },
    ]);
    const rows = await invitationRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      email: INVITEE_EMAIL,
      role: "admin",
      status: "pending",
      clerk_invitation_id: CLERK_INVITATION_ID,
    });
    expect(Date.parse(row.expires_at)).toBeGreaterThanOrEqual(before + SEVEN_DAYS_MS);
    expect(Date.parse(row.expires_at)).toBeLessThanOrEqual(after + SEVEN_DAYS_MS);
    expect(await response.json()).toEqual({
      data: {
        invitation: {
          id: row.id,
          email: INVITEE_EMAIL,
          role: "admin",
          expiresAt: row.expires_at,
          clerkInvitationId: CLERK_INVITATION_ID,
        },
      },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
    expect(await readAuditActions(getDb(env), { type: "invitation", id: row.id })).toEqual([
      "invite",
    ]);
  });

  it("refuses before claiming the address or calling Clerk when FRONTEND_URL is unset", async () => {
    env.FRONTEND_URL = undefined;

    const response = await invite(INVITEE_EMAIL);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "FRONTEND_URL is required to send invitations" },
      meta: { requestId: expect.any(String) },
    });
    expect(clerk.requests).toEqual([]);
    expect(await invitationRows()).toEqual([]);
  });

  it("expires a lapsed pending invitation to the address and invites again", async () => {
    await seedPendingInvitation("inv_invite_lapsed", INVITEE_EMAIL, -1);
    clerk.answer({ status: 200, body: { id: CLERK_INVITATION_ID, status: "pending" } });

    const response = await invite(INVITEE_EMAIL);

    expect(response.status).toBe(201);
    const created = createdInvitationSchema.parse(await response.json());
    expect(await readInvitationStatus(getDb(env), "inv_invite_lapsed")).toBe("expired");
    expect(await readInvitationStatus(getDb(env), created.data.invitation.id)).toBe("pending");
  });

  it("refuses before any Clerk call once active members and unexpired pending invitations fill 20 seats", async () => {
    await seedActiveMemberships(getDb(env), ORGANIZATION.id, SEAT_HOLDERS);
    await seedPendingInvitation("inv_invite_seat_open", "seat-open@example.com", 7);
    await seedPendingInvitation("inv_invite_seat_lapsed", "seat-lapsed@example.com", -1);

    const response = await invite(INVITEE_EMAIL);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "CONFLICT",
        message:
          "The organization has reached its limit of 20 members, pending invitations included",
      },
      meta: { requestId: expect.any(String) },
    });
    expect(clerk.requests).toEqual([]);
    expect(new Set((await invitationRows()).map((row) => row.id))).toEqual(
      new Set(["inv_invite_seat_open", "inv_invite_seat_lapsed"])
    );
  });

  it("does not count a lapsed pending invitation against the seats", async () => {
    await seedActiveMemberships(getDb(env), ORGANIZATION.id, SEAT_HOLDERS);
    await seedPendingInvitation("inv_invite_seat_lapsed", "seat-lapsed@example.com", -1);
    clerk.answer({ status: 200, body: { id: CLERK_INVITATION_ID, status: "pending" } });

    expect((await invite(INVITEE_EMAIL)).status).toBe(201);
  });

  it("keeps the claimed invitation pending with no Clerk id when Clerk refuses it", async () => {
    clerk.answer({ status: 500, body: { errors: [] } });

    expect((await invite(INVITEE_EMAIL)).status).toBe(500);
    expect(clerk.requests).toHaveLength(1);
    expect(await invitationRows()).toEqual([
      expect.objectContaining({
        email: INVITEE_EMAIL,
        status: "pending",
        clerk_invitation_id: null,
      }),
    ]);
  });

  it("withdraws the Clerk invitation it created when the invitation was revoked while Clerk was inviting", async () => {
    const createInvitation = ClerkOrganizationsService.prototype.createOrganizationInvitation;
    vi.spyOn(
      ClerkOrganizationsService.prototype,
      "createOrganizationInvitation"
    ).mockImplementation(async function (this: ClerkOrganizationsService, params) {
      await getDb(env).execute(
        "UPDATE invitations SET status = 'revoked' WHERE organization_id = ?",
        [ORGANIZATION.id]
      );
      return createInvitation.call(this, params);
    });
    clerk.answer(
      { status: 200, body: { id: CLERK_INVITATION_ID, status: "pending" } },
      { status: 200, body: { id: CLERK_INVITATION_ID, status: "revoked" } }
    );

    const response = await invite(INVITEE_EMAIL);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "CONFLICT", message: "The invitation was revoked while it was being sent" },
      meta: { requestId: expect.any(String) },
    });
    expect(clerk.requests).toEqual([
      {
        method: "POST",
        path: `/organizations/${CLERK_ORG_ID}/invitations`,
        body: CLERK_INVITATION_BODY,
      },
      {
        method: "POST",
        path: `/organizations/${CLERK_ORG_ID}/invitations/${CLERK_INVITATION_ID}/revoke`,
        body: null,
      },
    ]);
    expect(await invitationRows()).toEqual([
      expect.objectContaining({
        email: INVITEE_EMAIL,
        status: "revoked",
        clerk_invitation_id: null,
      }),
    ]);
  });

  it("completes the invite without withdrawing the Clerk invitation when a sign-in accepted it while Clerk was inviting", async () => {
    const createInvitation = ClerkOrganizationsService.prototype.createOrganizationInvitation;
    vi.spyOn(
      ClerkOrganizationsService.prototype,
      "createOrganizationInvitation"
    ).mockImplementation(async function (this: ClerkOrganizationsService, params) {
      await getDb(env).execute(
        "UPDATE invitations SET status = 'accepted' WHERE organization_id = ?",
        [ORGANIZATION.id]
      );
      return createInvitation.call(this, params);
    });
    clerk.answer({ status: 200, body: { id: CLERK_INVITATION_ID, status: "pending" } });

    const response = await invite(INVITEE_EMAIL);

    expect(response.status).toBe(201);
    expect(clerk.requests).toEqual([
      {
        method: "POST",
        path: `/organizations/${CLERK_ORG_ID}/invitations`,
        body: CLERK_INVITATION_BODY,
      },
    ]);
    const [row] = await invitationRows();
    expect(row.status).toBe("accepted");
    expect(await response.json()).toEqual({
      data: {
        invitation: {
          id: row.id,
          email: INVITEE_EMAIL,
          role: "admin",
          expiresAt: row.expires_at,
          clerkInvitationId: CLERK_INVITATION_ID,
        },
      },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
  });
});
