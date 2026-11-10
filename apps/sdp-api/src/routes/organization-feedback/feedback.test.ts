import { hashString } from "@sdp/payments/hash";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { ALL_API_KEY_GRANTS, TEST_API_KEY, TEST_SEEDED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG } from "@/test/fixtures/organizations";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const ORGANIZATION_ID = TEST_SEEDED_API_KEY.organizationId;
const PATH = `/v1/organizations/${ORGANIZATION_ID}/feedback`;
const MEMBER = { id: "usr_feedback_member", email: "member@example.com", name: "Mo Member" };
const VIEWER = { id: "usr_feedback_viewer", email: "viewer@example.com", name: "Vera Viewer" };
const ITERABLE_API_URL = "https://api.iterable.com";
const ITERABLE_SEND_URL = `${ITERABLE_API_URL}/api/email/target`;
const FEEDBACK = {
  category: "idea",
  message: "  I expected the payout to show the fee before I sent it.  ",
  pageUrl: "https://platform.solana.com/dashboard/proj_1/payments/pay",
  attachmentCount: 2,
  sentryEventId: "0123456789abcdef0123456789abcdef",
};

let memberToken: string;
let viewerToken: string;
let iterable: MockInstance<typeof fetch>;

async function seedOrganization(): Promise<void> {
  const db = getDb(env);
  await db
    .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
    .bind(ORGANIZATION_ID, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, TEST_ORG.status)
    .run();
  for (const [user, role] of [
    [MEMBER, "member"],
    [VIEWER, "viewer"],
  ] as const) {
    await db
      .prepare("INSERT INTO users (id, email, name, status) VALUES (?, ?, ?, 'active')")
      .bind(user.id, user.email, user.name)
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
    createdBy: MEMBER.id,
    members: [MEMBER.id, VIEWER.id],
    productionEntitled: false,
  });
  await seedApiKeyRow(env, await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER), {
    ...TEST_SEEDED_API_KEY,
    grants: ALL_API_KEY_GRANTS,
  });
  memberToken = await signSeededClerkMember(env, db, MEMBER.id, ORGANIZATION_ID);
  viewerToken = await signSeededClerkMember(env, db, VIEWER.id, ORGANIZATION_ID);
}

function post(body: unknown, authorization = `Bearer ${memberToken}`, path = PATH) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env
  );
}

function sentEmails(): Array<{ recipientEmail: string; dataFields: Record<string, string> }> {
  return iterable.mock.calls
    .filter(([input]) => String(input) === ITERABLE_SEND_URL)
    .map(([, init]) => JSON.parse(String(init?.body)));
}

describe("POST /v1/organizations/:orgId/feedback", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedOrganization();
    env.ITERABLE_API_URL = ITERABLE_API_URL;
    env.ITERABLE_API_KEY = "0123456789abcdef0123456789abcdef";
    env.ITERABLE_TRANSACTIONAL_CAMPAIGN_ID = "4242";
    env.SDP_OPERATOR_EMAIL = "team@example.org";
    const realFetch = globalThis.fetch;
    iterable = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) =>
        String(input) === ITERABLE_SEND_URL
          ? Response.json({ msg: "", code: "Success", params: null })
          : realFetch(input, init)
      );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    env.ITERABLE_API_URL = undefined;
    env.ITERABLE_API_KEY = undefined;
    env.ITERABLE_TRANSACTIONAL_CAMPAIGN_ID = undefined;
    env.SDP_OPERATOR_EMAIL = undefined;
    await clearKVStores(env);
  });

  it("emails the SDP alias for a member, replying to the sender", async () => {
    const response = await post(FEEDBACK);

    expect(response.status).toBe(201);
    expect((await response.json()).data).toEqual({ sent: true });
    const [email] = sentEmails();
    expect(email?.recipientEmail).toBe("team@example.org");
    expect(email?.dataFields.subject).toBe(`An idea: ${TEST_ORG.name}`);
    expect(email?.dataFields.replyTo).toBe(MEMBER.email);
    expect(email?.dataFields.body).toContain(
      "I expected the payout to show the fee before I sent it."
    );
    expect(email?.dataFields.body).toContain(`${MEMBER.name} (${MEMBER.email})`);
    expect(email?.dataFields.body).toContain(FEEDBACK.pageUrl);
    expect(email?.dataFields.body).toContain(FEEDBACK.sentryEventId);
  });

  it("escapes what the sender typed in the HTML part", async () => {
    await post({ message: "<img src=x onerror=alert(1)>" });

    const [email] = sentEmails();
    expect(email?.dataFields.bodyHtml).not.toContain("<img");
    expect(email?.dataFields.subject).toBe(`Feedback: ${TEST_ORG.name}`);
  });

  it.each([
    ["an empty message", { message: "   " }],
    ["an unknown category", { message: "Hi", category: "rant" }],
    ["too many files", { message: "Hi", attachmentCount: 6 }],
    ["a page that is not a web address", { message: "Hi", pageUrl: "javascript:alert(1)" }],
    ["a malformed Sentry event", { message: "Hi", sentryEventId: "not-an-id" }],
    ["an unknown field", { message: "Hi", email: "someone@example.com" }],
  ])("refuses %s without sending", async (_name, body) => {
    const response = await post(body);

    expect(response.status).toBe(400);
    expect(sentEmails()).toHaveLength(0);
  });

  it("refuses a viewer, who does not hold feedback.execute", async () => {
    const response = await post(FEEDBACK, `Bearer ${viewerToken}`);

    expect(response.status).toBe(403);
    expect((await response.json()).error.details.action).toBe("feedback.execute");
    expect(sentEmails()).toHaveLength(0);
  });

  it("refuses an API key, even one holding every grant", async () => {
    const response = await post(FEEDBACK, `Bearer ${TEST_API_KEY.raw}`);

    expect(response.status).toBe(403);
    expect((await response.json()).error.details.reason).toBe("human_session_required");
    expect(sentEmails()).toHaveLength(0);
  });

  it("refuses another organization's path", async () => {
    const response = await post(FEEDBACK, undefined, "/v1/organizations/org_other/feedback");

    expect(response.status).toBe(403);
    expect(sentEmails()).toHaveLength(0);
  });

  it("answers 503 when the deployment sends no email", async () => {
    env.SDP_OPERATOR_EMAIL = "placeholder";

    const response = await post(FEEDBACK);

    expect(response.status).toBe(503);
    expect(sentEmails()).toHaveLength(0);
  });
});
