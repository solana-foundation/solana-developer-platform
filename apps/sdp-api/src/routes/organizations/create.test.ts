import type { OrganizationStatus } from "@sdp/types/organizations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { DASHBOARD_ACTOR_MAX_REQUESTS } from "@/middleware/rate-limit";
import { readAuditActions } from "@/test/helpers/audit-logs";
import {
  clerkHeadersWithoutProject,
  ensureTestClerkIssuer,
  signTestClerkClaims,
  signTestClerkJwt,
} from "@/test/helpers/clerk";
import {
  type ClerkBackend,
  type ClerkBackendAnswer,
  stubClerkBackend,
} from "@/test/helpers/clerk-backend";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedRateLimit } from "@/test/mocks/kv";

const NAME = "Acme Labs";
const CLERK_USER_ID = "user_clerk_org_creator";
const EMAIL = "org-creator@example.com";
const CLERK_ORG_ID = "org_clerk_org_creator";
const MEMBERSHIPS_PATH = `/organizations/${CLERK_ORG_ID}/memberships`;

const FIRST_SIGN_IN: ClerkBackendAnswer = {
  status: 200,
  body: {
    id: CLERK_USER_ID,
    primary_email_address_id: "idn_org_creator",
    email_addresses: [
      { id: "idn_org_creator", email_address: EMAIL, verification: { status: "verified" } },
    ],
  },
};
const CLERK_ORGANIZATION: ClerkBackendAnswer = { status: 200, body: { id: CLERK_ORG_ID } };
const MEMBERSHIP_CREATED: ClerkBackendAnswer = { status: 200, body: { id: "orgmem_creator" } };

function membershipsPage(count: number): ClerkBackendAnswer {
  return { status: 200, body: { data: [], total_count: count } };
}

const createdRowSchema = z.object({ id: z.string(), created_by_user_id: z.string() });

let clerk: ClerkBackend;

async function postOrganization(headers: Record<string, string>, name: string) {
  return app.request(
    "/v1/organizations",
    { method: "POST", headers, body: JSON.stringify({ name }) },
    env
  );
}

async function signupHeaders(): Promise<Record<string, string>> {
  return clerkHeadersWithoutProject(
    await signTestClerkClaims({ sub: CLERK_USER_ID, email: EMAIL }, 300)
  );
}

async function createdRow() {
  return createdRowSchema.parse(
    await getDb(env).queryOne("SELECT id, created_by_user_id FROM organizations")
  );
}

async function storedState(organizationId: string) {
  const db = getDb(env);
  return {
    organizations: await db.queryMany(
      "SELECT id, name, status, created_by_user_id FROM organizations"
    ),
    mappings: await db.queryMany(
      "SELECT provider_org_id, organization_id FROM auth_organization_identities"
    ),
    memberships: await db.queryMany(
      "SELECT organization_id, user_id, role, status FROM organization_members"
    ),
    projectMembers: await db.queryMany(
      `SELECT p.organization_id, p.environment, pm.user_id
         FROM projects p LEFT JOIN project_members pm ON pm.project_id = p.id
        ORDER BY p.environment`
    ),
    audits: await readAuditActions(db, { type: "organization", id: organizationId }),
  };
}

function activeState(created: z.infer<typeof createdRowSchema>) {
  const creator = created.created_by_user_id;
  return {
    organizations: [{ id: created.id, name: NAME, status: "active", created_by_user_id: creator }],
    mappings: [{ provider_org_id: CLERK_ORG_ID, organization_id: created.id }],
    memberships: [
      { organization_id: created.id, user_id: creator, role: "admin", status: "active" },
    ],
    projectMembers: [
      { organization_id: created.id, environment: "production", user_id: creator },
      { organization_id: created.id, environment: "sandbox", user_id: creator },
    ],
    audits: ["create"],
  };
}

function createdResponse(organizationId: string) {
  return {
    data: {
      organization: {
        id: organizationId,
        name: NAME,
        slug: "acme-labs",
        tier: "enterprise",
        status: "active",
        settings: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
      clerkOrganizationId: CLERK_ORG_ID,
    },
    meta: { requestId: expect.any(String), timestamp: expect.any(String) },
  };
}

async function createActiveOrganization() {
  clerk.answer(FIRST_SIGN_IN, CLERK_ORGANIZATION, membershipsPage(0), MEMBERSHIP_CREATED);
  const response = await postOrganization(await signupHeaders(), NAME);
  return { response, created: await createdRow() };
}

describe("POST /v1/organizations", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await ensureTestClerkIssuer(env);
    clerk = stubClerkBackend(env);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearKVStores(env);
    env.CLERK_API_URL = undefined;
    env.CLERK_SECRET_KEY = undefined;
  });

  it("creates a new person's organization in Clerk with no creator, then their admin membership and both projects, audited", async () => {
    const { response, created } = await createActiveOrganization();

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(createdResponse(created.id));
    expect(clerk.requests).toEqual([
      { method: "GET", path: `/users/${CLERK_USER_ID}`, body: null },
      {
        method: "POST",
        path: "/organizations",
        body: { name: NAME, private_metadata: { sdpOrganizationId: created.id } },
      },
      { method: "GET", path: `${MEMBERSHIPS_PATH}?user_id=${CLERK_USER_ID}`, body: null },
      {
        method: "POST",
        path: MEMBERSHIPS_PATH,
        body: { user_id: CLERK_USER_ID, role: "org:member" },
      },
    ]);
    expect(await storedState(created.id)).toEqual(activeState(created));
  });

  it("finishes a creation whose Clerk membership failed without creating the Clerk organization again", async () => {
    clerk.answer(FIRST_SIGN_IN, CLERK_ORGANIZATION, membershipsPage(0), {
      status: 500,
      body: { errors: [{ code: "internal_clerk_error" }] },
    });
    const failed = await postOrganization(await signupHeaders(), NAME);
    const created = await createdRow();

    expect(failed.status).toBe(500);
    expect(await storedState(created.id)).toEqual({
      organizations: [
        {
          id: created.id,
          name: NAME,
          status: "provisioning",
          created_by_user_id: created.created_by_user_id,
        },
      ],
      mappings: [{ provider_org_id: CLERK_ORG_ID, organization_id: created.id }],
      memberships: [],
      projectMembers: [],
      audits: [],
    });

    const requestsBefore = clerk.requests.length;
    clerk.answer(membershipsPage(1));
    const retried = await postOrganization(await signupHeaders(), NAME);

    expect(retried.status).toBe(201);
    expect(await retried.json()).toEqual(createdResponse(created.id));
    expect(clerk.requests.slice(requestsBefore)).toEqual([
      { method: "GET", path: `${MEMBERSHIPS_PATH}?user_id=${CLERK_USER_ID}`, body: null },
    ]);
    expect(await storedState(created.id)).toEqual(activeState(created));
  });

  it("returns a finished organization again on the same name, writing nothing in Clerk or SDP", async () => {
    const { created } = await createActiveOrganization();
    const before = await storedState(created.id);
    const requestsBefore = clerk.requests.length;

    const again = await postOrganization(await signupHeaders(), NAME);

    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(createdResponse(created.id));
    expect(clerk.requests.slice(requestsBefore)).toEqual([]);
    expect(await storedState(created.id)).toEqual(before);
  });

  it.each([
    { refused: "another name", name: "Second Labs", status: "active" },
    { refused: "a suspended organization", name: NAME, status: "suspended" },
  ] satisfies { refused: string; name: string; status: OrganizationStatus }[])(
    "refuses $refused with a conflict, reaching Clerk not at all",
    async ({ name, status }) => {
      const { created } = await createActiveOrganization();
      await getDb(env).execute("UPDATE organizations SET status = ? WHERE id = ?", [
        status,
        created.id,
      ]);
      const before = await storedState(created.id);
      const requestsBefore = clerk.requests.length;

      const refused = await postOrganization(await signupHeaders(), name);

      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: "CONFLICT" } });
      expect(clerk.requests.slice(requestsBefore)).toEqual([]);
      expect(await storedState(created.id)).toEqual(before);
    }
  );

  it("refuses a creator removed from their organization, reaching Clerk not at all", async () => {
    const { created } = await createActiveOrganization();
    await getDb(env).execute(
      "UPDATE organization_members SET status = 'removed' WHERE organization_id = ?",
      [created.id]
    );
    const before = await storedState(created.id);
    const requestsBefore = clerk.requests.length;

    const refused = await postOrganization(await signupHeaders(), NAME);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: { code: "CONFLICT", message: "You have already created an organization" },
      meta: { requestId: expect.any(String) },
    });
    expect(clerk.requests.slice(requestsBefore)).toEqual([]);
    expect(await storedState(created.id)).toEqual(before);
  });

  it("rate-limits signup on the Clerk subject before writing the user or reaching Clerk", async () => {
    await seedRateLimit(
      env,
      `clerk:${CLERK_USER_ID}:organization-signup`,
      DASHBOARD_ACTOR_MAX_REQUESTS
    );

    const limited = await postOrganization(await signupHeaders(), NAME);

    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: expect.stringMatching(/^Rate limit exceeded\. Retry after \d+ seconds\.$/),
      },
      meta: { requestId: expect.any(String) },
    });
    expect(clerk.requests).toEqual([]);
    expect(await getDb(env).queryMany("SELECT id FROM users")).toEqual([]);
    expect(await getDb(env).queryMany("SELECT id FROM organizations")).toEqual([]);
  });

  it("creates the organization for a session whose active Clerk organization SDP never linked", async () => {
    clerk.answer(FIRST_SIGN_IN, CLERK_ORGANIZATION, membershipsPage(0), MEMBERSHIP_CREATED);
    const unlinked = await signTestClerkJwt({
      clerkUserId: CLERK_USER_ID,
      clerkOrgId: "org_clerk_unlinked",
      orgRole: "admin",
      orgSlug: "unlinked",
      email: EMAIL,
      expiresInSeconds: 300,
    });

    const response = await postOrganization(clerkHeadersWithoutProject(unlinked), NAME);
    const created = await createdRow();

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(createdResponse(created.id));
    expect(await storedState(created.id)).toEqual(activeState(created));
  });

  it("refuses a session naming an organization SDP links and a request with none, reaching Clerk for neither", async () => {
    const db = getDb(env);
    await db.batch([
      db
        .prepare(
          `INSERT INTO organizations (id, name, slug, status) VALUES ('org_linked', 'Linked', 'linked', 'active')`
        )
        .bind(),
      db
        .prepare(
          `INSERT INTO auth_organization_identities (id, provider, provider_org_id, organization_id, slug)
           VALUES ('aoi_linked', 'clerk', 'org_clerk_already_active', 'org_linked', 'linked')`
        )
        .bind(),
    ]);
    const withOrganization = await signTestClerkJwt({
      clerkUserId: CLERK_USER_ID,
      clerkOrgId: "org_clerk_already_active",
      orgRole: "member",
      orgSlug: "linked",
      email: EMAIL,
      expiresInSeconds: 300,
    });

    const scoped = await postOrganization(clerkHeadersWithoutProject(withOrganization), NAME);
    const anonymous = await postOrganization({ "Content-Type": "application/json" }, NAME);

    expect(scoped.status).toBe(400);
    expect(await scoped.json()).toMatchObject({
      error: { code: "BAD_REQUEST", message: "Clear the active organization before creating one" },
    });
    expect(anonymous.status).toBe(401);
    expect(clerk.requests).toEqual([]);
    expect(await db.queryMany("SELECT id FROM organizations")).toEqual([{ id: "org_linked" }]);
    expect(await db.queryMany("SELECT id FROM users")).toEqual([]);
  });
});
