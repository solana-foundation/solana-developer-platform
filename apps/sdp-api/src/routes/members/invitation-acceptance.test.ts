/**
 * Who an invitation can be redeemed by: the token travels by email and is
 * forwardable, so acceptance must be bound to the invited identity.
 */

import { hashString } from "@sdp/payments/hash";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { SessionService } from "@/services/session.service";
import { TEST_API_KEY, TEST_CACHED_API_KEY } from "@/test/fixtures/api-keys";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

/** The organization the caller is signed in to. */
const HOME_ORG_ID = TEST_CACHED_API_KEY.organizationId;
/** The organization the invitations under test belong to. */
const INVITING_ORG_ID = "org_inviting_acceptance";
const HOME_PROJECT_ID = "prj_acceptance_home";

const CALLER_USER_ID = "usr_acceptance_caller";
const CALLER_EMAIL = "caller@example.com";
const INVITER_USER_ID = "usr_acceptance_inviter";
const OTHER_EMAIL = "someone-else@example.com";

const INVITATION_TOKEN = "acceptance-token";
const INVITATION_ID = "inv_acceptance";

function inSevenDays(): string {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

function sevenDaysAgo(): string {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
}

async function seedOrganization(id: string, slug: string): Promise<void> {
  await getDb(env)
    .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
    .bind(id, slug, slug, "individual", "active")
    .run();
}

/** A user whose session authenticates and scopes to a home-org project. */
async function seedCaller(email = CALLER_EMAIL): Promise<string> {
  await getDb(env)
    .prepare("INSERT INTO users (id, email, status) VALUES (?, ?, 'active'), (?, ?, 'active')")
    .bind(CALLER_USER_ID, email, INVITER_USER_ID, "inviter@example.com")
    .run();
  await getDb(env)
    .prepare(
      `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES ('mem_acceptance_home', ?, ?, 'admin', 'active')`
    )
    .bind(HOME_ORG_ID, CALLER_USER_ID)
    .run();
  await getDb(env)
    .prepare(
      `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Home', 'acceptance-home', 'sandbox', 'active', ?)`
    )
    .bind(HOME_PROJECT_ID, HOME_ORG_ID, CALLER_USER_ID)
    .run();
  await getDb(env)
    .prepare(
      `INSERT INTO project_members (id, project_id, user_id, role)
         VALUES ('pm_acceptance_home', ?, ?, 'developer')`
    )
    .bind(HOME_PROJECT_ID, CALLER_USER_ID)
    .run();

  const session = await new SessionService(getDb(env)).createSession(
    CALLER_USER_ID,
    HOME_ORG_ID,
    {}
  );
  return session.id;
}

async function seedInvitation(
  options: {
    email?: string;
    organizationId?: string;
    role?: string;
    status?: string;
    expiresAt?: string;
    id?: string;
    token?: string;
  } = {}
): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO invitations (id, organization_id, email, role, invited_by, token_hash, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      options.id ?? INVITATION_ID,
      options.organizationId ?? INVITING_ORG_ID,
      options.email ?? CALLER_EMAIL,
      options.role ?? "member",
      INVITER_USER_ID,
      await hashString(options.token ?? INVITATION_TOKEN),
      options.expiresAt ?? inSevenDays(),
      options.status ?? "pending"
    )
    .run();
}

function accept(sessionId: string, token = INVITATION_TOKEN, name?: string) {
  return app.request(
    "/v1/members/accept",
    {
      method: "POST",
      headers: {
        Cookie: `sdp_session=${sessionId}`,
        "x-project-id": HOME_PROJECT_ID,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(name === undefined ? { token } : { token, name }),
    },
    env
  );
}

async function membershipsIn(organizationId: string, userId: string) {
  const rows = await getDb(env)
    .prepare(
      "SELECT id, role, status FROM organization_members WHERE organization_id = ? AND user_id = ?"
    )
    .bind(organizationId, userId)
    .all<{ id: string; role: string; status: string }>();

  return rows.results;
}

async function invitationStatus(id = INVITATION_ID): Promise<string | undefined> {
  const row = await getDb(env)
    .prepare("SELECT status FROM invitations WHERE id = ?")
    .bind(id)
    .first<{ status: string }>();

  return row?.status;
}

describe("POST /v1/members/accept", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedOrganization(HOME_ORG_ID, "acceptance-home-org");
    await seedOrganization(INVITING_ORG_ID, "acceptance-inviting-org");
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  it("refuses a caller whose address is not the one invited", async () => {
    const sessionId = await seedCaller();
    await seedInvitation({ email: OTHER_EMAIL });

    const res = await accept(sessionId);

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");

    // The invitation is still the invitee's to spend, and nobody was enrolled.
    expect(await invitationStatus()).toBe("pending");
    expect(await membershipsIn(INVITING_ORG_ID, CALLER_USER_ID)).toHaveLength(0);
    const anyMembers = await getDb(env)
      .prepare("SELECT COUNT(*) AS total FROM organization_members WHERE organization_id = ?")
      .bind(INVITING_ORG_ID)
      .first<{ total: number }>();
    expect(Number(anyMembers?.total ?? 0)).toBe(0);
  });

  it("refuses an API key, which has no identity to be the invitee", async () => {
    await seedCaller();
    await seedInvitation({ email: OTHER_EMAIL });
    await seedCachedApiKey(env, await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER), {
      ...TEST_CACHED_API_KEY,
      permissions: ["*"],
    });

    const res = await app.request(
      "/v1/members/accept",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: INVITATION_TOKEN }),
      },
      env
    );

    expect(res.status).toBe(403);
    expect(await invitationStatus()).toBe("pending");
  });

  it("grants the membership in the inviting organization, not the caller's own", async () => {
    const sessionId = await seedCaller();
    await seedInvitation({ role: "admin" });

    const res = await accept(sessionId);

    expect(res.status).toBe(200);
    expect(await invitationStatus()).toBe("accepted");

    const granted = await membershipsIn(INVITING_ORG_ID, CALLER_USER_ID);
    expect(granted).toHaveLength(1);
    expect(granted[0]?.role).toBe("admin");
    expect(granted[0]?.status).toBe("active");

    // The caller's signed-in org is untouched.
    const home = await membershipsIn(HOME_ORG_ID, CALLER_USER_ID);
    expect(home).toHaveLength(1);
    expect(home[0]?.role).toBe("admin");
  });

  it("matches the invited address regardless of case", async () => {
    const sessionId = await seedCaller();
    await seedInvitation({ email: CALLER_EMAIL.toUpperCase() });

    expect((await accept(sessionId)).status).toBe(200);
    expect(await membershipsIn(INVITING_ORG_ID, CALLER_USER_ID)).toHaveLength(1);
  });

  it("cannot be replayed once spent", async () => {
    const sessionId = await seedCaller();
    await seedInvitation();

    expect((await accept(sessionId)).status).toBe(200);

    const replay = await accept(sessionId);

    expect(replay.status).toBe(400);
    const body = (await replay.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_INVITATION");
    expect(await membershipsIn(INVITING_ORG_ID, CALLER_USER_ID)).toHaveLength(1);
  });

  it("survives two simultaneous acceptances of the same token as one membership", async () => {
    const sessionId = await seedCaller();
    await seedInvitation();

    const [first, second] = await Promise.all([accept(sessionId), accept(sessionId)]);

    expect([first.status, second.status].sort()).toEqual([200, 400]);
    expect(await membershipsIn(INVITING_ORG_ID, CALLER_USER_ID)).toHaveLength(1);
  });

  it("refuses an expired invitation", async () => {
    const sessionId = await seedCaller();
    await seedInvitation({ expiresAt: sevenDaysAgo() });

    const res = await accept(sessionId);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("EXPIRED_INVITATION");
    expect(await invitationStatus()).toBe("pending");
    expect(await membershipsIn(INVITING_ORG_ID, CALLER_USER_ID)).toHaveLength(0);
  });

  it("refuses a revoked invitation", async () => {
    const sessionId = await seedCaller();
    await seedInvitation({ status: "revoked" });

    const res = await accept(sessionId);

    expect(res.status).toBe(400);
    expect(await membershipsIn(INVITING_ORG_ID, CALLER_USER_ID)).toHaveLength(0);
  });

  it("refuses an unknown token", async () => {
    const sessionId = await seedCaller();
    await seedInvitation();

    const res = await accept(sessionId, "not-the-token");

    expect(res.status).toBe(400);
    expect(await invitationStatus()).toBe("pending");
  });

  it("reinstates a removed membership from an invitation issued after the removal", async () => {
    // The legitimate path back in: a fresh re-invite reuses the existing row.
    const sessionId = await seedCaller();
    await getDb(env)
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
           VALUES ('mem_acceptance_removed', ?, ?, 'member', 'removed')`
      )
      .bind(INVITING_ORG_ID, CALLER_USER_ID)
      .run();
    await seedInvitation({ role: "admin" });

    expect((await accept(sessionId)).status).toBe(200);

    const memberships = await membershipsIn(INVITING_ORG_ID, CALLER_USER_ID);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.id).toBe("mem_acceptance_removed");
    expect(memberships[0]?.status).toBe("active");
    expect(memberships[0]?.role).toBe("admin");
  });

  it("does not let a removed member self-reinstate with an invitation that predates the removal", async () => {
    // Removal must take outstanding invitations down with it, or an unspent
    // token flips the removed row back to active — at the invited role.
    const sessionId = await seedCaller();
    await getDb(env)
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
           VALUES ('mem_acceptance_stale', ?, ?, 'member', 'active')`
      )
      .bind(INVITING_ORG_ID, CALLER_USER_ID)
      .run();
    // Unspent, at a higher role than they held — the escalation the attack buys.
    await seedInvitation({ role: "admin" });

    // An admin of the inviting organization removes them.
    await seedCachedApiKey(env, await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER), {
      ...TEST_CACHED_API_KEY,
      organizationId: INVITING_ORG_ID,
      permissions: ["*"],
    });
    const removal = await app.request(
      "/v1/members/mem_acceptance_stale",
      { method: "DELETE", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
    expect(removal.status).toBe(204);

    // The removal revoked the outstanding invitation…
    expect(await invitationStatus()).toBe("revoked");

    // …so the old token cannot resurrect the membership.
    const res = await accept(sessionId);
    expect(res.status).toBe(400);

    const memberships = await membershipsIn(INVITING_ORG_ID, CALLER_USER_ID);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.status).toBe("removed");
    expect(memberships[0]?.role).toBe("member");
  });

  it("applies the invited role when a membership already exists at a lower one", async () => {
    // A concurrent Clerk sign-in can win the membership insert at its own role;
    // the invitation is the explicit grant being consumed and must still deliver.
    const sessionId = await seedCaller();
    await getDb(env)
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
           VALUES ('mem_acceptance_lower', ?, ?, 'member', 'active')`
      )
      .bind(INVITING_ORG_ID, CALLER_USER_ID)
      .run();
    await seedInvitation({ role: "admin" });

    expect((await accept(sessionId)).status).toBe(200);
    expect(await invitationStatus()).toBe("accepted");

    const memberships = await membershipsIn(INVITING_ORG_ID, CALLER_USER_ID);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe("admin");
  });

  it("never demotes an existing admin over a member-role invitation", async () => {
    // The stray token case: silently reducing an admin — possibly the last
    // one — is not what accepting an invitation means.
    const sessionId = await seedCaller();
    await seedInvitation({ organizationId: HOME_ORG_ID, role: "member" });

    expect((await accept(sessionId)).status).toBe(200);
    expect(await invitationStatus()).toBe("accepted");

    const memberships = await membershipsIn(HOME_ORG_ID, CALLER_USER_ID);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe("admin");
  });

  it("spends the invitation without duplicating an existing membership", async () => {
    const sessionId = await seedCaller();
    await seedInvitation({ organizationId: HOME_ORG_ID });

    expect((await accept(sessionId)).status).toBe(200);
    expect(await invitationStatus()).toBe("accepted");
    expect(await membershipsIn(HOME_ORG_ID, CALLER_USER_ID)).toHaveLength(1);
  });

  it("fills in a missing name without overwriting one already set", async () => {
    const sessionId = await seedCaller();
    await seedInvitation();

    expect((await accept(sessionId, INVITATION_TOKEN, "Invited Person")).status).toBe(200);

    const named = await getDb(env)
      .prepare("SELECT name FROM users WHERE id = ?")
      .bind(CALLER_USER_ID)
      .first<{ name: string | null }>();
    expect(named?.name).toBe("Invited Person");

    await seedInvitation({ id: "inv_acceptance_second", token: "second-token" });
    expect((await accept(sessionId, "second-token", "Renamed")).status).toBe(200);

    const stillNamed = await getDb(env)
      .prepare("SELECT name FROM users WHERE id = ?")
      .bind(CALLER_USER_ID)
      .first<{ name: string | null }>();
    expect(stillNamed?.name).toBe("Invited Person");
  });
});
