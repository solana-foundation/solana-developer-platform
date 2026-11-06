import { INVITATION_STATUSES, INVITEE_NOT_ALLOWED_REASON } from "@sdp/types/organizations";
import { ORGANIZATION_ROLES } from "@sdp/types/roles";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { ClerkOrganizationsService } from "@/services/clerk-organizations.service";
import { readAuditActions } from "@/test/helpers/audit-logs";
import { clerkHeaders } from "@/test/helpers/clerk";
import {
  type ClerkBackend,
  type ClerkBackendAnswer,
  stubClerkBackend,
} from "@/test/helpers/clerk-backend";
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
const CLERK_LIST_REQUEST = {
  method: "GET",
  path: `/organizations/${CLERK_ORG_ID}/invitations?status=pending&limit=100&offset=0`,
  body: null,
};
const CLERK_SERVER_ERROR = { status: 500, body: { errors: [] } };
const OTHER_TAGGED_INVITATION = { id: "orginv_invite_retry", sdpInvitationId: "inv_invite_retry" };

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

function clerkCreateRequest(sdpInvitationId: string) {
  return {
    method: "POST",
    path: `/organizations/${CLERK_ORG_ID}/invitations`,
    body: { ...CLERK_INVITATION_BODY, private_metadata: { sdpInvitationId } },
  };
}

function clerkPendingList(
  tagged: Array<{ id: string; sdpInvitationId: string }>
): ClerkBackendAnswer {
  return {
    status: 200,
    body: {
      data: tagged.map(({ id, sdpInvitationId }) => ({
        id,
        email_address: INVITEE_EMAIL,
        status: "pending",
        private_metadata: { sdpInvitationId },
      })),
    },
  };
}

function answerOnCreate(answers: (sdpInvitationId: string) => ClerkBackendAnswer[]) {
  const createInvitation = ClerkOrganizationsService.prototype.createOrganizationInvitation;
  vi.spyOn(ClerkOrganizationsService.prototype, "createOrganizationInvitation").mockImplementation(
    async function (this: ClerkOrganizationsService, params) {
      clerk.answer(...answers(params.sdpInvitationId));
      return createInvitation.call(this, params);
    }
  );
}

async function invitationAuditEntries(invitationId: string) {
  return z
    .array(z.object({ action: z.string(), status: z.string(), clerk_code: z.string().nullable() }))
    .parse(
      await getDb(env).queryMany(
        "SELECT action, status, metadata::jsonb ->> 'clerkCode' AS clerk_code FROM audit_logs WHERE resource_type = 'invitation' AND resource_id = ? ORDER BY ledger_sequence",
        [invitationId]
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
    const rows = await invitationRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(clerk.requests).toEqual([clerkCreateRequest(row.id)]);
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

  it("refuses a second pending invitation to the address in another letter case before any Clerk call", async () => {
    await seedPendingInvitation("inv_invite_existing", "Invitee@Example.COM", 7);

    const response = await invite(INVITEE_EMAIL);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "CONFLICT", message: "Invitation already sent to this email" },
      meta: { requestId: expect.any(String) },
    });
    expect(clerk.requests).toEqual([]);
    expect((await invitationRows()).map((row) => row.id)).toEqual(["inv_invite_existing"]);
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

  it("re-invites an address that already holds the Clerk membership, keeping Clerk's wording out of the answer", async () => {
    await seedInvitation(getDb(env), {
      id: "inv_invite_expired",
      organizationId: ORGANIZATION.id,
      email: INVITEE_EMAIL,
      role: "member",
      invitedBy: ADMIN.userId,
      status: "expired",
      expiresInDays: -1,
    });
    clerk.answer({
      status: 400,
      body: {
        errors: [
          {
            code: "already_a_member_in_organization",
            message: "already a member",
            long_message: `${INVITEE_EMAIL} is already a member of the organization.`,
          },
        ],
      },
    });

    const response = await invite(INVITEE_EMAIL);

    expect(response.status).toBe(201);
    const rows = await invitationRows();
    const fresh = rows.find((row) => row.id !== "inv_invite_expired");
    expect(fresh).toMatchObject({
      email: INVITEE_EMAIL,
      role: "admin",
      status: "pending",
      clerk_invitation_id: null,
    });
    expect(await response.json()).toEqual({
      data: {
        invitation: {
          id: fresh?.id,
          email: INVITEE_EMAIL,
          role: "admin",
          expiresAt: fresh?.expires_at,
          clerkInvitationId: null,
        },
      },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
  });

  it("fails the claimed invitation and audits Clerk's code when Clerk refuses it, answering the generic internal error", async () => {
    clerk.answer({
      status: 422,
      body: { errors: [{ code: "form_param_format_invalid", long_message: "Clerk says no" }] },
    });

    const response = await invite(INVITEE_EMAIL);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "An internal error occurred" },
      meta: { requestId: expect.any(String) },
    });
    const rows = await invitationRows();
    expect(rows.map((row) => row.status)).toEqual(["failed"]);
    expect(clerk.requests).toEqual([clerkCreateRequest(rows[0].id)]);
    expect(await invitationAuditEntries(rows[0].id)).toEqual([
      { action: "invite", status: "success", clerk_code: null },
      { action: "invite", status: "failure", clerk_code: "form_param_format_invalid" },
    ]);
  });

  it("fails the claimed invitation and answers 400 when Clerk's restrictions do not admit the address", async () => {
    clerk.answer({
      status: 403,
      body: { errors: [{ code: "not_allowed_access", long_message: "Clerk says no" }] },
    });

    const response = await invite(INVITEE_EMAIL);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: "This email's domain isn't approved yet. Contact us to get it added.",
        details: { reason: INVITEE_NOT_ALLOWED_REASON },
      },
      meta: { requestId: expect.any(String) },
    });
    const rows = await invitationRows();
    expect(rows.map((row) => row.status)).toEqual(["failed"]);
    expect(clerk.requests).toEqual([clerkCreateRequest(rows[0].id)]);
  });

  it("adopts the Clerk invitation tagged with its id when Clerk answers 5xx to the create", async () => {
    answerOnCreate((sdpInvitationId) => [
      CLERK_SERVER_ERROR,
      clerkPendingList([OTHER_TAGGED_INVITATION, { id: CLERK_INVITATION_ID, sdpInvitationId }]),
    ]);

    const response = await invite(INVITEE_EMAIL);

    expect(response.status).toBe(201);
    const [row] = await invitationRows();
    expect(row).toMatchObject({ status: "pending", clerk_invitation_id: CLERK_INVITATION_ID });
    expect(clerk.requests).toEqual([clerkCreateRequest(row.id), CLERK_LIST_REQUEST]);
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

  it("fails the claimed invitation when Clerk answers 5xx and lists no invitation tagged with its id", async () => {
    answerOnCreate(() => [CLERK_SERVER_ERROR, clerkPendingList([OTHER_TAGGED_INVITATION])]);

    expect((await invite(INVITEE_EMAIL)).status).toBe(500);
    const rows = await invitationRows();
    expect(rows).toEqual([
      expect.objectContaining({ status: "failed", clerk_invitation_id: null }),
    ]);
    expect(clerk.requests).toEqual([clerkCreateRequest(rows[0].id), CLERK_LIST_REQUEST]);
  });

  it("fails the claimed invitation when the Clerk call times out and Clerk cannot list its invitations", async () => {
    vi.spyOn(ClerkOrganizationsService.prototype, "createOrganizationInvitation").mockRejectedValue(
      new DOMException("The operation timed out", "TimeoutError")
    );
    clerk.answer(CLERK_SERVER_ERROR);

    expect((await invite(INVITEE_EMAIL)).status).toBe(500);
    expect(clerk.requests).toEqual([CLERK_LIST_REQUEST]);
    expect((await invitationRows()).map((row) => row.status)).toEqual(["failed"]);
  });

  it("invites again an address whose last invitation failed", async () => {
    clerk.answer(
      { status: 422, body: { errors: [{ code: "form_param_format_invalid" }] } },
      { status: 200, body: { id: CLERK_INVITATION_ID, status: "pending" } }
    );

    expect((await invite(INVITEE_EMAIL)).status).toBe(500);
    expect((await invite(INVITEE_EMAIL)).status).toBe(201);
    expect((await invitationRows()).map((row) => row.status).sort()).toEqual(["failed", "pending"]);
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
    const [revoked] = await invitationRows();
    expect(clerk.requests).toEqual([
      clerkCreateRequest(revoked.id),
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
    const [row] = await invitationRows();
    expect(clerk.requests).toEqual([clerkCreateRequest(row.id)]);
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
