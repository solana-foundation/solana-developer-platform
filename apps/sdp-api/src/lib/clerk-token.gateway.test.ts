import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { verifyClerkJwtForRequest } from "@/lib/clerk-token";
import type { GatewayIdentity } from "@/lib/gateway-identity";
import { ensureTestClerkIssuer, signTestClerkJwt } from "@/test/helpers/clerk";
import { env } from "@/test/helpers/env";
import type { Env } from "@/types/env";

const SESSION = {
  clerkUserId: "user_gateway",
  clerkOrgId: "org_gateway",
  orgRole: "admin",
  orgSlug: "gateway",
  email: "gateway@example.test",
  expiresInSeconds: 60,
} as const;

function identity(overrides: Partial<GatewayIdentity>): GatewayIdentity {
  return {
    projectId: null,
    orgId: SESSION.clerkOrgId,
    keyId: null,
    clerkUserId: SESSION.clerkUserId,
    plan: null,
    clientIp: "203.0.113.5",
    requestId: null,
    ...overrides,
  };
}

async function verifyUnder(gatewayIdentity: GatewayIdentity): Promise<number> {
  await ensureTestClerkIssuer(env);
  const token = await signTestClerkJwt(SESSION);
  const app = new Hono<{ Bindings: Env }>();
  app.get("/", async (c) => {
    c.set("gatewayIdentity", gatewayIdentity);
    try {
      await verifyClerkJwtForRequest(c, token);
      return c.text("ok");
    } catch {
      return c.text("refused", 401);
    }
  });
  return (await app.request("/", {}, env)).status;
}

describe("a Clerk session forwarded with a gateway identity (HOO-2256)", () => {
  it("verifies when the identity names the same user and organization", async () => {
    expect(await verifyUnder(identity({}))).toBe(200);
  });

  it("refuses a session for another user", async () => {
    expect(await verifyUnder(identity({ clerkUserId: "user_other" }))).toBe(401);
  });

  it("refuses a session for another organization", async () => {
    expect(await verifyUnder(identity({ orgId: "org_other" }))).toBe(401);
  });

  it("refuses a session for an organization when the identity names none", async () => {
    expect(await verifyUnder(identity({ orgId: null }))).toBe(401);
  });

  it("refuses a session when the identity names a key", async () => {
    expect(await verifyUnder(identity({ clerkUserId: null, keyId: "0123456789abcdef" }))).toBe(401);
  });
});
