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

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

const { verifyClerkJwtForRequest } = vi.hoisted(() => ({
  verifyClerkJwtForRequest: vi.fn(),
}));

vi.mock("@/lib/clerk-token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clerk-token")>()),
  verifyClerkJwtForRequest,
}));

const ORGANIZATION_ID = "org_onboarding_isolation";
const CLERK_ORG_ID = "org_clerk_onboarding_isolation";

function clerkPayload(clerkOrgId: string) {
  return {
    sub: "user_clerk_onboarding_isolation",
    org_id: clerkOrgId,
    org_slug: "onboarding-isolation",
    org_role: "org:admin",
    email: "onboarding-isolation@example.com",
  };
}

const getStatus = () =>
  app.request(
    "/v1/onboarding/status",
    { headers: { Authorization: "Bearer clerk-session-token" } },
    env
  );

type StatusBody = {
  data: { linked: boolean; organization: { id: string } | null; setup: unknown };
};

describe("onboarding status under database tenant isolation", () => {
  beforeEach(async () => {
    verifyClerkJwtForRequest.mockReset();
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
  });

  it("resolves a linked organization through row-level security", async () => {
    verifyClerkJwtForRequest.mockResolvedValue(clerkPayload(CLERK_ORG_ID));

    const res = await getStatus();
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatusBody;
    expect(body.data.linked).toBe(true);
    expect(body.data.organization?.id).toBe(ORGANIZATION_ID);
    expect(body.data.setup).not.toBeNull();
  });

  it("reports unlinked for a Clerk organization with no mapping", async () => {
    verifyClerkJwtForRequest.mockResolvedValue(clerkPayload("org_clerk_never_linked"));

    const res = await getStatus();
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatusBody;
    expect(body.data.linked).toBe(false);
    expect(body.data.organization).toBeNull();
  });
});
