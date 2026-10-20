import { hashString } from "@sdp/payments/hash";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { HUMAN_SESSION_REQUIRED_MESSAGE } from "@/middleware/human-session";
import { TEST_API_KEY, TEST_SEEDED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";

/**
 * API keys are credentials, not administrators (HOO-2099): key management,
 * organization administration, members and invitations, and project members
 * answer only a signed-in person. This inventory enumerates every route the
 * app registers under those groups, so a new one is refused too or fails
 * here, and proves each refuses an API key that holds every grant.
 */
const HUMAN_ONLY_PATHS = [
  /^\/v1\/api-keys(\/|$)/,
  /^\/v1\/members(\/|$)/,
  /^\/v1\/projects\/:projectId\/(members|api-keys)(\/|$)/,
];
const HUMAN_ONLY_ROUTES = new Set([
  "PATCH /v1/organizations/:orgId",
  "DELETE /v1/organizations/:orgId",
]);

function humanOnlyRoutes(): string[] {
  const routes = new Set<string>();
  for (const route of app.routes) {
    if (route.method === "ALL") continue;
    const key = `${route.method} ${route.path}`;
    if (HUMAN_ONLY_ROUTES.has(key) || HUMAN_ONLY_PATHS.some((path) => path.test(route.path))) {
      routes.add(key);
    }
  }
  return [...routes].sort();
}

describe("human-only routes", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, TEST_ORG.status)
      .run();
    await seedApiKeyRow(
      env,
      await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER),
      TEST_SEEDED_API_KEY
    );
  });

  it("pins the routes an API key can never reach", () => {
    expect(humanOnlyRoutes()).toEqual([
      "DELETE /v1/api-keys/:keyId",
      "DELETE /v1/members/:memberId",
      "DELETE /v1/members/invitations/:invitationId",
      "DELETE /v1/organizations/:orgId",
      "DELETE /v1/projects/:projectId/members/:memberId",
      "GET /v1/api-keys",
      "GET /v1/api-keys/:keyId",
      "GET /v1/members",
      "GET /v1/projects/:projectId/api-keys",
      "GET /v1/projects/:projectId/members",
      "PATCH /v1/api-keys/:keyId",
      "PATCH /v1/organizations/:orgId",
      "PATCH /v1/projects/:projectId/members/:memberId",
      "POST /v1/api-keys",
      "POST /v1/api-keys/:keyId/rotate",
      "POST /v1/members/accept",
      "POST /v1/members/invite",
      "POST /v1/projects/:projectId/api-keys",
      "POST /v1/projects/:projectId/members",
    ]);
  });

  it.each(humanOnlyRoutes())("refuses an API key holding every grant on %s", async (route) => {
    const [method, path] = route.split(" ");
    const url = path
      .replace(":projectId", TEST_SEEDED_API_KEY.projectId)
      .replace(":orgId", TEST_ORG.id)
      .replace(/:[A-Za-z]+/g, "unused_id");

    const res = await app.request(
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: method === "GET" ? undefined : "{}",
      },
      env
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: {
        code: "FORBIDDEN",
        message: HUMAN_SESSION_REQUIRED_MESSAGE,
        details: { reason: "human_session_required" },
      },
    });
  });
});
