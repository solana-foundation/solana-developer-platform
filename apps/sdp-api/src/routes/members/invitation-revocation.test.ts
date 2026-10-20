import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { invitationWasRevoked } from "@/lib/invitations";
import { TEST_ORG } from "@/test/fixtures/organizations";
import { clerkHeaders, ensureTestClerkIssuer, signTestClerkJwt } from "@/test/helpers/clerk";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const CLERK_API_URL = "https://clerk.example.test/v1";
const CLERK_ORG_ID = "org_clerk_invitation_revocation";
const ORGANIZATION_ID = TEST_ORG.id;
const INVITEE_EMAIL = "duplicate-invite@example.com";

/** The invitation the local row was created for. */
const OUR_CLERK_INVITATION_ID = "orginv_ours";
/** A second invitation raised for the same address by someone else. */
const OTHER_CLERK_INVITATION_ID = "orginv_theirs";

const LOCAL_INVITATION_ID = "inv_revocation_target";
const INVITER_USER_ID = "usr_revocation_inviter";
const ADMIN_USER_ID = "usr_revocation_admin";
const ADMIN_CLERK_USER_ID = "clerk_user_admin";
const ADMIN_PROJECT_ID = "prj_invitation_revocation";
let adminToken: string;

interface ClerkInvitationStub {
  id: string;
  email_address: string;
  status: string;
  inviter_id: string;
  url: string;
}

function clerkInvitation(id: string): ClerkInvitationStub {
  return {
    id,
    email_address: INVITEE_EMAIL,
    status: "pending",
    inviter_id: "clerk_user_inviter",
    url: `https://accept.example.test/${id}`,
  };
}

/**
 * Stands in for Clerk's organization-invitation endpoints.
 *
 * `pendingByCall` supplies the pending list per call, so a test can have the
 * follow-up reconciliation lookup see a different world than the first read —
 * which is the whole situation being exercised here.
 */
function stubClerk(options: {
  pendingByCall: ClerkInvitationStub[][];
  revokeStatus?: number;
  /** Makes the follow-up reconciliation lookup fail, leaving the outcome unknown. */
  failListAfterFirst?: boolean;
}): {
  revokedIds: string[];
  requestingUserIds: string[];
} {
  const revokedIds: string[] = [];
  const requestingUserIds: string[] = [];
  let listCall = 0;

  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    // The admin's session token verifies against the local test issuer.
    if (env.CLERK_JWKS_URL && url.startsWith(env.CLERK_JWKS_URL)) {
      return realFetch(input, init);
    }

    if (url.includes("/invitations?status=pending")) {
      if (options.failListAfterFirst && listCall > 0) {
        throw new TypeError("network error");
      }
      const page = options.pendingByCall[listCall] ?? options.pendingByCall.at(-1) ?? [];
      listCall += 1;
      return new Response(JSON.stringify({ data: page }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const revokeMatch = url.match(/\/invitations\/([^/]+)\/revoke$/);
    if (revokeMatch && init?.method === "POST") {
      const status = options.revokeStatus ?? 200;
      if (status >= 400) {
        return new Response(JSON.stringify({ errors: [] }), { status });
      }
      revokedIds.push(revokeMatch[1] as string);
      requestingUserIds.push(
        (JSON.parse(String(init?.body ?? "{}")) as { requesting_user_id?: string })
          .requesting_user_id ?? ""
      );
      return new Response(JSON.stringify({ id: revokeMatch[1], status: "revoked" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch in test: ${init?.method ?? "GET"} ${url}`);
  });

  return { revokedIds, requestingUserIds };
}

async function seedInvitation(clerkInvitationId: string | null): Promise<void> {
  const db = getDb(env);

  await db.batch([
    db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, 'Invitation Revocation', 'invitation-revocation', 'individual', 'active')"
      )
      .bind(ORGANIZATION_ID),
    db
      .prepare(
        "INSERT INTO users (id, email, email_verified, status) VALUES (?, 'revocation-inviter@example.com', 1, 'active')"
      )
      .bind(INVITER_USER_ID),
    db
      .prepare(
        `INSERT INTO auth_organization_identities (id, provider, provider_org_id, organization_id, slug)
         VALUES ('aoi_revocation', 'clerk', ?, ?, 'invitation-revocation')`
      )
      .bind(CLERK_ORG_ID, ORGANIZATION_ID),
    db
      .prepare(
        `INSERT INTO invitations
           (id, organization_id, email, role, invited_by, token_hash, expires_at, status, clerk_invitation_id)
         VALUES (?, ?, ?, 'member', ?, ?, ?, 'pending', ?)`
      )
      .bind(
        LOCAL_INVITATION_ID,
        ORGANIZATION_ID,
        INVITEE_EMAIL,
        INVITER_USER_ID,
        "hash_revocation_target",
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        clerkInvitationId
      ),
  ]);

  await signInAdmin();
}

/**
 * Signs in an organization admin: invitations are revoked by a signed-in
 * person, never an API key (HOO-2099), and Clerk is told that person asked.
 */
async function signInAdmin(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        "INSERT INTO users (id, email, email_verified, status) VALUES (?, 'revocation-admin@example.com', 1, 'active')"
      )
      .bind(ADMIN_USER_ID),
    db
      .prepare(
        `INSERT INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
         VALUES ('aui_revocation_admin', 'clerk', ?, ?, 'revocation-admin@example.com')`
      )
      .bind(ADMIN_CLERK_USER_ID, ADMIN_USER_ID),
    db
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES ('mem_revocation_admin', ?, ?, 'admin', 'active')`
      )
      .bind(ORGANIZATION_ID, ADMIN_USER_ID),
  ]);
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: ADMIN_USER_ID,
    members: [ADMIN_USER_ID],
    ids: { sandbox: ADMIN_PROJECT_ID, production: `${ADMIN_PROJECT_ID}_production` },
  });
  await ensureTestClerkIssuer(env);
  adminToken = await signTestClerkJwt({
    clerkUserId: ADMIN_CLERK_USER_ID,
    clerkOrgId: CLERK_ORG_ID,
    orgRole: "admin",
    orgSlug: "invitation-revocation",
    email: "revocation-admin@example.com",
    expiresInSeconds: 300,
  });
}

async function revoke(): Promise<Response> {
  return app.request(
    `/v1/members/invitations/${LOCAL_INVITATION_ID}`,
    { method: "DELETE", headers: clerkHeaders(adminToken, ADMIN_PROJECT_ID) },
    env
  );
}

async function invitationStatus(): Promise<string | undefined> {
  const row = await getDb(env)
    .prepare("SELECT status FROM invitations WHERE id = ?")
    .bind(LOCAL_INVITATION_ID)
    .first<{ status: string }>();

  return row?.status;
}

describe("invitation revocation identity", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await clearKVStores(env);
    env.CLERK_SECRET_KEY = "sk_test_invitation_revocation";
    env.CLERK_API_URL = CLERK_API_URL;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearKVStores(env);
    env.CLERK_SECRET_KEY = undefined;
    env.CLERK_API_URL = undefined;
  });

  it("revokes only the Clerk invitation this row was created for", async () => {
    await seedInvitation(OUR_CLERK_INVITATION_ID);
    const clerk = stubClerk({
      pendingByCall: [
        [clerkInvitation(OUR_CLERK_INVITATION_ID), clerkInvitation(OTHER_CLERK_INVITATION_ID)],
      ],
    });

    const response = await revoke();

    expect(response.status).toBe(204);
    // The second invitation belongs to someone else's request for the same
    // address; revoking it would cancel an invite nobody asked to withdraw.
    expect(clerk.revokedIds).toEqual([OUR_CLERK_INVITATION_ID]);
    expect(clerk.requestingUserIds).toEqual([ADMIN_CLERK_USER_ID]);
    expect(await invitationStatus()).toBe("revoked");
  });

  it("keeps the invitation revoked when only a different invitation for the same address survives", async () => {
    await seedInvitation(OUR_CLERK_INVITATION_ID);
    stubClerk({
      pendingByCall: [
        [clerkInvitation(OUR_CLERK_INVITATION_ID), clerkInvitation(OTHER_CLERK_INVITATION_ID)],
        // Reconciliation after the ambiguous failure: ours is gone, so Clerk did
        // apply the revocation. Only the unrelated invitation is left.
        [clerkInvitation(OTHER_CLERK_INVITATION_ID)],
      ],
      revokeStatus: 500,
    });

    await revoke();

    // Matching on email would read the surviving invitation as proof ours was
    // still live and reopen a token Clerk had already revoked.
    expect(await invitationStatus()).toBe("revoked");
  });

  it("reopens the invitation when its own Clerk invitation is still pending", async () => {
    await seedInvitation(OUR_CLERK_INVITATION_ID);
    stubClerk({
      pendingByCall: [[clerkInvitation(OUR_CLERK_INVITATION_ID)]],
      revokeStatus: 500,
    });

    await revoke();

    // Clerk never applied it, so the acceptance link is still live and the local
    // row must not claim otherwise.
    expect(await invitationStatus()).toBe("pending");
  });

  it("keeps the token dead when the revocation and its verification both fail", async () => {
    await seedInvitation(OUR_CLERK_INVITATION_ID);
    stubClerk({
      pendingByCall: [[clerkInvitation(OUR_CLERK_INVITATION_ID)]],
      revokeStatus: 500,
      failListAfterFirst: true,
    });

    await revoke();

    // Nothing is known about whether Clerk applied it. Reopening would leave a
    // token we issued redeemable after a revocation that may have succeeded,
    // and would not close the Clerk side either — clerk-auth provisions from
    // Clerk org membership regardless of this row.
    expect(await invitationStatus()).toBe("revoked");
  });

  it("locks the invitation rows so a revocation cannot commit mid-check", async () => {
    await seedInvitation(OUR_CLERK_INVITATION_ID);
    const db = getDb(env);

    await db.transaction(async (tx) => {
      expect(await invitationWasRevoked(tx, ORGANIZATION_ID, INVITEE_EMAIL, { lock: true })).toBe(
        false
      );

      // NOWAIT fails outright rather than blocking, so this asserts the rows are
      // genuinely locked without depending on a timeout. Without the lock the
      // revocation would commit between the check and the membership write.
      await expect(
        db
          .prepare(
            `SELECT id FROM invitations
              WHERE organization_id = ? AND email = ?
              FOR UPDATE NOWAIT`
          )
          .bind(ORGANIZATION_ID, INVITEE_EMAIL)
          .all()
      ).rejects.toThrow();
    });
  });

  it("revokes every invitation for the address when the row predates the stored id", async () => {
    await seedInvitation(null);
    const clerk = stubClerk({
      pendingByCall: [
        [clerkInvitation(OUR_CLERK_INVITATION_ID), clerkInvitation(OTHER_CLERK_INVITATION_ID)],
      ],
    });

    const response = await revoke();

    expect(response.status).toBe(204);
    // Without the id there is no way to tell which one is ours, so the invariant
    // enforced is that none survive.
    expect(clerk.revokedIds).toEqual([OUR_CLERK_INVITATION_ID, OTHER_CLERK_INVITATION_ID]);
    expect(await invitationStatus()).toBe("revoked");
  });
});
