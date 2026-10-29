/**
 * /v1/onboarding runs before clerkAuthMiddleware ever links a session, so its
 * middleware must resolve the Clerk-org mapping under the system database
 * identity and narrow the request to the mapped organization. Exercised
 * through the full HTTP stack under the plain NOSUPERUSER/NOBYPASSRLS runtime
 * role so the forced RLS policies (migration 0081) actually apply.
 *
 * Regression: the middleware verified the Clerk JWT but stamped no database
 * identity, so the status handler's auth_organization_identities lookup ran
 * identity-less, RLS returned zero rows, and every linked organization
 * reported linked:false (the dashboard then failed closed and badged every
 * treasury vault "Access unavailable").
 */

import type { InvitationStatus, MemberStatus } from "@sdp/types/organizations";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import {
  ensureTestClerkIssuer,
  seedClerkIdentity,
  signTestClerkClaims,
} from "@/test/helpers/clerk";
import { env } from "@/test/helpers/env";
import { seedInvitation } from "@/test/helpers/invitations";
import { organizationMember, seedActiveMemberships } from "@/test/helpers/organization-members";
import { seedTestDatabase } from "@/test/mocks/db";
import { ONBOARDING_VERSION } from "./state";

const ORGANIZATION_ID = "org_onboarding_isolation";
const CLERK_ORG_ID = "org_clerk_onboarding_isolation";
const SESSION_EMAIL = "onboarding-isolation@example.com";
const INVITER = organizationMember("onboarding_isolation_inviter", "admin");

function invite(invitation: { email: string; status: InvitationStatus; expiresInDays: number }) {
  return seedInvitation(getDb(env), {
    id: "inv_onboarding_isolation",
    organizationId: ORGANIZATION_ID,
    role: "member",
    invitedBy: INVITER.userId,
    ...invitation,
  });
}

async function seedSessionMembership(status: MemberStatus) {
  const db = getDb(env);
  await db.execute(
    "INSERT INTO users (id, email, email_verified, status) VALUES ('usr_onboarding_isolation', ?, 1, 'active')",
    [SESSION_EMAIL]
  );
  await seedClerkIdentity(db, {
    userId: "usr_onboarding_isolation",
    email: SESSION_EMAIL,
    clerkUserId: "user_clerk_onboarding_isolation",
    organizationId: ORGANIZATION_ID,
    clerkOrgId: CLERK_ORG_ID,
    orgSlug: "onboarding-isolation",
    role: "admin",
  });
  await db.execute(
    "UPDATE organization_members SET status = ? WHERE organization_id = ? AND user_id = 'usr_onboarding_isolation'",
    [status, ORGANIZATION_ID]
  );
}

function clerkPayload(clerkOrgId: string) {
  return {
    sub: "user_clerk_onboarding_isolation",
    org_id: clerkOrgId,
    org_slug: "onboarding-isolation",
    org_role: "org:admin",
    email: SESSION_EMAIL,
  };
}

async function getStatus(clerkOrgId: string) {
  await ensureTestClerkIssuer(env);
  const token = await signTestClerkClaims(clerkPayload(clerkOrgId), 300);
  return app.request(
    "/v1/onboarding/status",
    { headers: { Authorization: `Bearer ${token}` } },
    env
  );
}

type StatusBody = {
  data: { linked: boolean; organization: { id: string } | null; setup: unknown };
};

describe("onboarding status under database tenant isolation", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);

    const db = getDb(env);
    await db.batch([
      db
        .prepare(
          `INSERT INTO organizations (id, name, slug, tier, status)
           VALUES (?, 'Onboarding isolation', 'onboarding-isolation', 'individual', 'active')`
        )
        .bind(ORGANIZATION_ID),
      db
        .prepare(
          `INSERT INTO auth_organization_identities
             (id, provider, provider_org_id, organization_id, slug)
           VALUES ('aoi_onboarding_isolation', 'clerk', ?, ?, 'onboarding-isolation')`
        )
        .bind(CLERK_ORG_ID, ORGANIZATION_ID),
    ]);
    await seedActiveMemberships(db, ORGANIZATION_ID, [INVITER]);
  });

  it("resolves a linked organization through row-level security", async () => {
    const db = getDb(env);
    await db.execute(
      "INSERT INTO users (id, email, email_verified, status) VALUES ('usr_onboarding_isolation', ?, 1, 'active')",
      [SESSION_EMAIL]
    );
    await seedClerkIdentity(db, {
      userId: "usr_onboarding_isolation",
      email: SESSION_EMAIL,
      clerkUserId: "user_clerk_onboarding_isolation",
      organizationId: ORGANIZATION_ID,
      clerkOrgId: CLERK_ORG_ID,
      orgSlug: "onboarding-isolation",
      role: "member",
    });
    const res = await getStatus(CLERK_ORG_ID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatusBody;
    expect(body.data.linked).toBe(true);
    expect(body.data.organization?.id).toBe(ORGANIZATION_ID);
    expect(body.data.setup).not.toBeNull();
  });

  it("reports unlinked for a Clerk organization with no mapping", async () => {
    const res = await getStatus("org_clerk_never_linked");
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatusBody;
    expect(body.data.linked).toBe(false);
    expect(body.data.organization).toBeNull();
  });

  it.each([
    { holding: "no invitation", invitations: [] },
    {
      holding: "an expired invitation",
      invitations: [{ email: SESSION_EMAIL, status: "pending", expiresInDays: -1 }],
    },
    {
      holding: "a revoked invitation",
      invitations: [{ email: SESSION_EMAIL, status: "revoked", expiresInDays: 7 }],
    },
  ] as const)(
    "refuses a Clerk member SDP never admitted who holds $holding",
    async ({ invitations }) => {
      for (const invitation of invitations) {
        await invite(invitation);
      }

      const res = await getStatus(CLERK_ORG_ID);

      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({
        error: { code: "UNAUTHORIZED", message: "No pending invitation to this organization" },
      });
    }
  );

  it.each([
    { holder: "an invitee SDP never admitted", formerAdmin: false },
    { holder: "an admin removed since", formerAdmin: true },
  ])(
    "answers $holder whose pending invitation names their address in other letter case, without management",
    async ({ formerAdmin }) => {
      if (formerAdmin) {
        await seedSessionMembership("removed");
      }
      await invite({ email: SESSION_EMAIL.toUpperCase(), status: "pending", expiresInDays: 7 });

      const res = await getStatus(CLERK_ORG_ID);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: {
          linked: true,
          organization: {
            id: ORGANIZATION_ID,
            name: "Onboarding isolation",
            slug: "onboarding-isolation",
            tier: "individual",
            status: "active",
            settings: null,
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
          },
          setup: {
            status: "not_started",
            currentStep: "custody",
            custodyProviders: [],
            completedAt: null,
            version: ONBOARDING_VERSION,
            canManage: false,
          },
        },
        meta: { requestId: expect.any(String), timestamp: expect.any(String) },
      });
    }
  );

  it("refuses a suspended member even while an invitation to their address is pending", async () => {
    await seedSessionMembership("suspended");
    await invite({ email: SESSION_EMAIL, status: "pending", expiresInDays: 7 });

    const res = await getStatus(CLERK_ORG_ID);

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: { code: "UNAUTHORIZED", message: "Organization membership is inactive" },
    });
  });
});
