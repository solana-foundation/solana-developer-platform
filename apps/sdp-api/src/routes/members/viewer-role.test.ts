import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { clerkHeaders } from "@/test/helpers/clerk";
import { stubClerkBackend } from "@/test/helpers/clerk-backend";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { env } from "@/test/helpers/env";
import {
  organizationMember,
  type SeededOrganizationMember,
  seedOrganizationMembers,
} from "@/test/helpers/organization-members";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const ORGANIZATION = { id: "org_viewer_role", slug: "viewer-role" };
const ADMIN = organizationMember("viewer_role_admin", "admin");
const VIEWER = organizationMember("viewer_role_viewer", "viewer");
const MEMBER = organizationMember("viewer_role_member", "member");
let sandboxProjectId: string;

async function requestAs(
  actor: SeededOrganizationMember,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: Record<string, string>
): Promise<Response> {
  const token = await signSeededClerkMember(env, getDb(env), actor.userId, ORGANIZATION.id);
  const headers = clerkHeaders(token, sandboxProjectId);
  if (method !== "GET") {
    headers["Idempotency-Key"] = crypto.randomUUID();
  }
  return app.request(
    path,
    {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    },
    env
  );
}

describe("read-only organization role", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await seedOrganizationMembers(db, {
      organization: ORGANIZATION,
      members: [ADMIN, VIEWER, MEMBER],
    });
    const projects = await seedDefaultProjects(db, {
      organizationId: ORGANIZATION.id,
      createdBy: ADMIN.userId,
      members: [ADMIN.userId, VIEWER.userId, MEMBER.userId],
    });
    sandboxProjectId = projects.sandbox.id;
    stubClerkBackend(env);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearKVStores(env);
    env.CLERK_SECRET_KEY = undefined;
    env.CLERK_API_URL = undefined;
  });

  it("reads its own role and the organization's records", async () => {
    const me = await requestAs(VIEWER, "GET", "/v1/members/me");
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ data: { role: "viewer" } });

    for (const path of ["/v1/members", "/v1/api-keys", "/v1/counterparties"]) {
      expect((await requestAs(VIEWER, "GET", path)).status, path).toBe(200);
    }
  });

  it.each([
    ["mints an API key", "POST", "/v1/api-keys", { name: "viewer key" }],
    ["invites a member", "POST", "/v1/members/invite", { email: "x@example.com", role: "viewer" }],
    ["changes a role", "PATCH", `/v1/members/${MEMBER.memberId}`, { role: "admin" }],
    ["adds a counterparty", "POST", "/v1/counterparties", { name: "Acme" }],
    ["sends a transfer", "POST", "/v1/payments/transfers", {}],
    ["creates a wallet", "POST", "/v1/wallets", {}],
    ["creates a token", "POST", "/v1/issuance/tokens", {}],
    ["mints a token", "POST", "/v1/issuance/tokens/tok_viewer/mint", {}],
  ] as const)("refuses a viewer that %s", async (_label, method, path, body) => {
    const response = await requestAs(VIEWER, method, path, body);
    expect(response.status, path).toBe(403);
  });

  it("lets an admin make a member read-only, and the member loses every write", async () => {
    const changed = await requestAs(ADMIN, "PATCH", `/v1/members/${MEMBER.memberId}`, {
      role: "viewer",
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ data: { role: "viewer" } });

    expect((await requestAs(MEMBER, "POST", "/v1/counterparties", { name: "Acme" })).status).toBe(
      403
    );
  });
});
