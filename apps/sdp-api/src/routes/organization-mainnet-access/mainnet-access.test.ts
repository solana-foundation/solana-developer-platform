import { hashString } from "@sdp/payments/hash";
import { SDP_TERMS } from "@sdp/types/mainnet-access";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { correctMainnetAccess } from "@/services/mainnet-access.service";
import { syncProviderAccessFromClerk } from "@/services/provider-availability.service";
import { ALL_API_KEY_GRANTS, TEST_API_KEY, TEST_SEEDED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const ORGANIZATION_ID = TEST_SEEDED_API_KEY.organizationId;
const PATH = `/v1/organizations/${ORGANIZATION_ID}/mainnet-access`;
const MEMBER_USER = { id: "usr_mainnet_member", email: "member@example.com" };
const RESEND_API_URL = "https://api.resend.com";
const RESEND_URL = `${RESEND_API_URL}/emails`;
const SUBMISSION = { countryCode: "SG", termsVersion: SDP_TERMS.version, acceptTerms: true };

let adminToken: string;
let memberToken: string;
let resend: MockInstance<typeof fetch>;

async function seedOrganization(): Promise<void> {
  const db = getDb(env);
  await db
    .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
    .bind(ORGANIZATION_ID, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, TEST_ORG.status)
    .run();
  for (const [user, role] of [
    [{ id: TEST_USER.id, email: TEST_USER.email }, "admin"],
    [MEMBER_USER, "member"],
  ] as const) {
    await db
      .prepare("INSERT INTO users (id, email, name, status) VALUES (?, ?, ?, 'active')")
      .bind(user.id, user.email, role === "admin" ? "Ada Admin" : null)
      .run();
    await db
      .prepare(
        "INSERT INTO organization_members (id, organization_id, user_id, role, status) VALUES (?, ?, ?, ?, 'active')"
      )
      .bind(`mem_${user.id}`, ORGANIZATION_ID, user.id, role)
      .run();
  }
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: TEST_USER.id,
    members: [TEST_USER.id, MEMBER_USER.id],
    productionEntitled: false,
  });
  await seedApiKeyRow(env, await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER), {
    ...TEST_SEEDED_API_KEY,
    grants: ALL_API_KEY_GRANTS,
  });
  adminToken = await signSeededClerkMember(env, db, TEST_USER.id, ORGANIZATION_ID);
  memberToken = await signSeededClerkMember(env, db, MEMBER_USER.id, ORGANIZATION_ID);
}

function get(token = adminToken) {
  return app.request(PATH, { headers: { Authorization: `Bearer ${token}` } }, env);
}

function post(body: unknown, authorization = `Bearer ${adminToken}`) {
  return app.request(
    PATH,
    {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env
  );
}

function notify(authorization = `Bearer ${adminToken}`) {
  return app.request(
    `${PATH}/notify`,
    { method: "POST", headers: { Authorization: authorization } },
    env
  );
}

/** Fails Resend until the returned function restores it. */
function failResend(): () => void {
  const answer = resend.getMockImplementation();
  if (!answer) throw new Error("the Resend stub is installed in beforeEach");
  resend.mockImplementation(async (input, init) =>
    String(input) === RESEND_URL ? new Response("down", { status: 500 }) : answer(input, init)
  );
  return () => resend.mockImplementation(answer);
}

/** The organization's request columns, or null while it has not asked. */
async function storedRow() {
  const row = await getDb(env)
    .prepare(
      `SELECT jurisdiction_country_code AS country_code, terms_accepted_version AS terms_version,
              mainnet_requested_at AS requested_at,
              mainnet_requested_by_user_id AS requested_by_user_id,
              mainnet_request_notified_at AS notified_at
       FROM organizations WHERE id = ?`
    )
    .bind(ORGANIZATION_ID)
    .first<Record<string, string | null>>();
  return row?.requested_at ? row : null;
}

function sentEmails(): Array<{ headers: Record<string, string>; body: Record<string, unknown> }> {
  return resend.mock.calls
    .filter(([url]) => String(url) === RESEND_URL)
    .map(([, init]) => ({
      headers: z.record(z.string(), z.string()).parse(init?.headers),
      body: z.record(z.string(), z.unknown()).parse(JSON.parse(String(init?.body))),
    }));
}

describe("Organization mainnet access (HOO-2427)", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedOrganization();
    env.RESEND_API_URL = RESEND_API_URL;
    env.RESEND_API_KEY = "re_test";
    env.MAINNET_ACCESS_EMAIL_FROM = "SDP <noreply@platform.solana.com>";
    env.MAINNET_ACCESS_EMAIL_TO = "mainnet@example.org";
    const realFetch = globalThis.fetch;
    resend = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) =>
        String(input) === RESEND_URL ? Response.json({ id: "email_1" }) : realFetch(input, init)
      );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    env.RESEND_API_URL = undefined;
    env.RESEND_API_KEY = undefined;
    env.MAINNET_ACCESS_EMAIL_FROM = undefined;
    env.MAINNET_ACCESS_EMAIL_TO = undefined;
    await clearKVStores(env);
  });

  it("starts not requested and available, with the alias to contact", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({
      state: "not_requested",
      available: true,
      countryCode: null,
      request: null,
      contactEmail: "mainnet@example.org",
    });
  });

  it.each([
    ["no jurisdiction", { termsVersion: SDP_TERMS.version, acceptTerms: true }],
    ["an unknown country", { ...SUBMISSION, countryCode: "XX" }],
    ["the terms not accepted", { countryCode: "SG", termsVersion: SDP_TERMS.version }],
    ["the terms declined", { ...SUBMISSION, acceptTerms: false }],
  ])("refuses a request with %s, recording and sending nothing", async (_, body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(await storedRow()).toBeNull();
    expect(sentEmails()).toHaveLength(0);
  });

  it("refuses acceptance of a terms version that is not the current one", async () => {
    const response = await post({ ...SUBMISSION, termsVersion: "2020-01-old" });
    expect(response.status).toBe(409);
    expect(await storedRow()).toBeNull();
    expect(sentEmails()).toHaveLength(0);
  });

  it("records jurisdiction and terms acceptance, emails the alias, and reads pending", async () => {
    const response = await post(SUBMISSION);
    expect(response.status).toBe(201);
    const data = (await response.json()).data;
    expect(data).toMatchObject({
      state: "pending",
      countryCode: "SG",
      request: {
        requestedByUserId: TEST_USER.id,
        termsVersion: SDP_TERMS.version,
        notified: true,
      },
    });

    const row = await storedRow();
    expect(row).toMatchObject({
      country_code: "SG",
      terms_version: SDP_TERMS.version,
      requested_by_user_id: TEST_USER.id,
    });
    expect(row?.notified_at).not.toBeNull();

    const [email, ...others] = sentEmails();
    expect(others).toHaveLength(0);
    expect(email?.headers.authorization).toBe("Bearer re_test");
    expect(email?.headers["idempotency-key"]).toBe(
      `mainnet-access/${ORGANIZATION_ID}/${row?.requested_at}`
    );
    expect(email?.body).toMatchObject({
      from: "SDP <noreply@platform.solana.com>",
      to: ["mainnet@example.org"],
      reply_to: TEST_USER.email,
    });
    const text = String(email?.body.text);
    for (const field of [
      `Organization: ${TEST_ORG.name}`,
      `Organization id: ${ORGANIZATION_ID}`,
      `Requested by: Ada Admin ${TEST_USER.email} (${TEST_USER.id})`,
      "Jurisdiction (self-declared): Singapore (SG)",
      `Requested at: ${row?.requested_at}`,
      `Terms and Conditions: version ${SDP_TERMS.version}, accepted with the request`,
    ]) {
      expect(text).toContain(field);
    }

    expect((await (await get()).json()).data.state).toBe("pending");
  });

  it("is a one-time request: a second submit is refused and sends nothing", async () => {
    expect((await post(SUBMISSION)).status).toBe(201);
    const again = await post({ ...SUBMISSION, countryCode: "US" });
    expect(again.status).toBe(409);
    expect((await storedRow())?.country_code).toBe("SG");
    expect(sentEmails()).toHaveLength(1);
  });

  it("records one request when two admins submit at once", async () => {
    const statuses = await Promise.all([
      post(SUBMISSION),
      post({ ...SUBMISSION, countryCode: "US" }),
    ]).then((responses) => responses.map((response) => response.status));
    expect([...statuses].sort()).toEqual([201, 409]);
    const winner = statuses[0] === 201 ? "SG" : "US";
    expect((await storedRow())?.country_code).toBe(winner);
    expect(sentEmails()).toHaveLength(1);
  });

  it("keeps a request whose email failed, for notify to send", async () => {
    const restore = failResend();
    expect((await post(SUBMISSION)).status).toBe(503);
    expect((await storedRow())?.notified_at).toBeNull();
    expect((await (await get()).json()).data.request).toMatchObject({ notified: false });
    restore();

    expect((await post({ ...SUBMISSION, countryCode: "US" })).status).toBe(409);
    const sent = await notify();
    expect(sent.status).toBe(200);
    expect((await sent.json()).data).toMatchObject({
      countryCode: "SG",
      request: { notified: true },
    });
    const emails = sentEmails();
    expect(emails).toHaveLength(2);
    expect(emails[0]?.headers["idempotency-key"]).toBe(emails[1]?.headers["idempotency-key"]);
  });

  it("notifies an unsent request accepted under terms that have since changed", async () => {
    const restore = failResend();
    expect((await post(SUBMISSION)).status).toBe(503);
    restore();
    // The acceptance on record predates the current terms, as after a terms update.
    await getDb(env)
      .prepare("UPDATE organizations SET terms_accepted_version = ? WHERE id = ?")
      .bind("2026-09-previous", ORGANIZATION_ID)
      .run();

    const sent = await notify();
    expect(sent.status).toBe(200);
    expect((await sent.json()).data).toMatchObject({
      request: { termsVersion: "2026-09-previous", notified: true },
    });
    expect(sentEmails().at(-1)?.body.text).toContain("version 2026-09-previous");
  });

  it("refuses to notify before a request, or once it was sent", async () => {
    expect((await notify()).status).toBe(409);
    expect((await post(SUBMISSION)).status).toBe(201);
    expect((await notify()).status).toBe(409);
    expect(sentEmails()).toHaveLength(1);
  });

  it("meters submits and notifies together, since each may call Resend", async () => {
    const statuses = [(await post(SUBMISSION)).status, (await post(SUBMISSION)).status];
    for (let attempt = 0; attempt < 4; attempt += 1) statuses.push((await notify()).status);
    expect(statuses).toEqual([201, 409, 409, 409, 409, 429]);
  });

  it("rejects a half-written request at the database", async () => {
    await expect(
      getDb(env)
        .prepare("UPDATE organizations SET mainnet_requested_at = sdp_iso_now() WHERE id = ?")
        .bind(ORGANIZATION_ID)
        .run()
    ).rejects.toThrow(/organizations_mainnet_request_whole/);
  });

  it.each([
    ["no alias", "MAINNET_ACCESS_EMAIL_TO"],
    ["no Resend API URL", "RESEND_API_URL"],
  ] as const)("reads unavailable and refuses before recording anything with %s", async (_, key) => {
    env[key] = undefined;
    expect((await (await get()).json()).data).toMatchObject({ available: false });
    expect((await post(SUBMISSION)).status).toBe(503);
    expect((await notify()).status).toBe(503);
    expect(await storedRow()).toBeNull();
    expect(sentEmails()).toHaveLength(0);
  });

  it("reads approved once an operator sets enableProductionProject in Clerk", async () => {
    expect((await post(SUBMISSION)).status).toBe(201);
    await syncProviderAccessFromClerk(getDb(env), {
      organizationId: ORGANIZATION_ID,
      clerkOrganization: {
        id: "org_clerk",
        private_metadata: { sdp: { enableProductionProject: true } },
      },
    });
    const data = (await (await get()).json()).data;
    expect(data).toMatchObject({ state: "approved", countryCode: "SG" });
    expect((await post(SUBMISSION)).status).toBe(409);
  });

  it("reads approved for an organization enabled without ever asking", async () => {
    await syncProviderAccessFromClerk(getDb(env), {
      organizationId: ORGANIZATION_ID,
      clerkOrganization: {
        id: "org_clerk",
        private_metadata: { sdp: { enableProductionProject: true } },
      },
    });
    expect((await (await get()).json()).data).toMatchObject({ state: "approved", request: null });
    expect((await post(SUBMISSION)).status).toBe(409);
    expect(sentEmails()).toHaveLength(0);
  });

  it("refuses an admin naming another organization, recording nothing on either", async () => {
    const foreign = "org_mainnet_foreign";
    await getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(foreign, "Foreign", "foreign-org", TEST_ORG.tier, TEST_ORG.status)
      .run();
    const path = `/v1/organizations/${foreign}/mainnet-access`;
    const headers = { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" };

    expect((await app.request(path, { headers }, env)).status).toBe(403);
    const write = await app.request(
      path,
      { method: "POST", headers, body: JSON.stringify(SUBMISSION) },
      env
    );
    expect(write.status).toBe(403);
    expect((await app.request(`${path}/notify`, { method: "POST", headers }, env)).status).toBe(
      403
    );
    const requested = await getDb(env)
      .prepare("SELECT id FROM organizations WHERE mainnet_requested_at IS NOT NULL")
      .all();
    expect(requested.results).toEqual([]);
    expect(sentEmails()).toHaveLength(0);
  });

  it("refuses a member who is not an admin", async () => {
    expect((await get(memberToken)).status).toBe(403);
    expect((await post(SUBMISSION, `Bearer ${memberToken}`)).status).toBe(403);
    expect((await notify(`Bearer ${memberToken}`)).status).toBe(403);
    expect(await storedRow()).toBeNull();
  });

  it("refuses an API key, even one holding every grant", async () => {
    const authorization = `Bearer ${TEST_API_KEY.raw}`;
    const read = await app.request(PATH, { headers: { Authorization: authorization } }, env);
    expect(read.status).toBe(403);
    expect((await post(SUBMISSION, authorization)).status).toBe(403);
    expect((await notify(authorization)).status).toBe(403);
    expect(await storedRow()).toBeNull();
  });

  describe("operator corrections", () => {
    const operator = { operator: "ops@example.org", reason: "customer asked", ticket: "HOO-2427" };

    it("corrects the jurisdiction, keeping the terms acceptance and the request", async () => {
      expect((await post(SUBMISSION)).status).toBe(201);
      await correctMainnetAccess(env, {
        organizationId: ORGANIZATION_ID,
        operation: "set-country",
        countryCode: "GB",
        ...operator,
      });
      expect((await (await get()).json()).data).toMatchObject({
        state: "pending",
        countryCode: "GB",
        request: { termsVersion: SDP_TERMS.version },
      });
    });

    it("resets a request so the organization can ask again", async () => {
      expect((await post(SUBMISSION)).status).toBe(201);
      await correctMainnetAccess(env, {
        organizationId: ORGANIZATION_ID,
        operation: "reset",
        ...operator,
      });
      expect((await (await get()).json()).data.state).toBe("not_requested");
      expect((await post({ ...SUBMISSION, countryCode: "US" })).status).toBe(201);
      expect(sentEmails()).toHaveLength(2);
    });

    it("refuses to correct an organization that never asked", async () => {
      await expect(
        correctMainnetAccess(env, {
          organizationId: ORGANIZATION_ID,
          operation: "reset",
          ...operator,
        })
      ).rejects.toThrow("has not requested");
    });
  });
});
