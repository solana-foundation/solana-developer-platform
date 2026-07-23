import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";
import { completeOnboarding, getOnboardingStatus } from "./handlers";

const ORGANIZATION_ID = "org_onboarding_test";
const CLERK_ORGANIZATION_ID = "org_clerk_onboarding_test";
const USER_ID = "user_onboarding_test";
const PROJECT_ID = "project_onboarding_test";

function completeRequest(custodyProvider = "privy") {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ custodyProvider }),
  };
}

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(error.toResponse(), error.statusCode as ContentfulStatusCode);
    }
    return c.json({ error: { code: "INTERNAL_ERROR", message: error.message } }, 500);
  });
  app.use("*", async (c, next) => {
    c.set("clerkOnboarding", {
      clerkUserId: "user_clerk_onboarding_test",
      clerkOrgId: CLERK_ORGANIZATION_ID,
      orgSlug: "onboarding-test",
      orgRole: "org:admin",
      email: "onboarding@example.com",
    });
    await next();
  });
  app.get("/status", getOnboardingStatus);
  app.post("/complete", completeOnboarding);
  return app;
}

async function seedOrganization() {
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, 'Onboarding test', 'onboarding-test', 'enterprise', 'active')`
      )
      .bind(ORGANIZATION_ID),
    getDb(env)
      .prepare(
        `INSERT INTO users (id, email, email_verified, name, status)
         VALUES (?, 'onboarding@example.com', 1, 'Onboarding user', 'active')`
      )
      .bind(USER_ID),
    getDb(env)
      .prepare(
        `INSERT INTO projects
           (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Default Sandbox Project', 'default-sandbox', 'sandbox', 'active', ?)`
      )
      .bind(PROJECT_ID, ORGANIZATION_ID, USER_ID),
    getDb(env)
      .prepare(
        `INSERT INTO auth_organization_identities
           (id, provider, provider_org_id, organization_id, slug)
         VALUES ('aoi_onboarding_test', 'clerk', ?, ?, 'onboarding-test')`
      )
      .bind(CLERK_ORGANIZATION_ID, ORGANIZATION_ID),
  ]);
}

describe("organization onboarding handlers", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedOrganization();
  });

  it("returns resumable setup state for a newly created organization", async () => {
    const response = await createApp().request("/status", {}, env);
    const body = (await response.json()) as {
      data: { setup: { status: string; currentStep: string; canManage: boolean } };
    };

    expect(response.status).toBe(200);
    expect(body.data.setup).toMatchObject({
      status: "not_started",
      currentStep: "rpc",
      canManage: true,
    });
  });

  it("only completes after an RPC choice and active custody wallet exist", async () => {
    const app = createApp();
    expect((await app.request("/complete", completeRequest(), env)).status).toBe(400);

    await getDb(env)
      .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ rpcProvider: "default" }), ORGANIZATION_ID)
      .run();
    expect((await app.request("/complete", completeRequest(), env)).status).toBe(400);

    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs
             (id, organization_id, project_id, provider, config_encrypted,
              default_wallet_id, status)
           VALUES
             ('cfg_onboarding_test', ?, ?, 'privy', 'encrypted',
              'wallet_onboarding_test', 'active')`
        )
        .bind(ORGANIZATION_ID, PROJECT_ID),
      getDb(env).prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, status)
         VALUES
           ('cw_onboarding_test', 'cfg_onboarding_test', 'wallet_onboarding_test',
            '11111111111111111111111111111111', 'Default wallet', 'active')`
      ),
      getDb(env)
        .prepare(
          `INSERT INTO custody_scope_defaults
             (id, organization_id, project_id, default_custody_config_id)
           VALUES ('csd_onboarding_test', ?, ?, 'cfg_onboarding_test')`
        )
        .bind(ORGANIZATION_ID, PROJECT_ID),
    ]);

    expect((await app.request("/complete", completeRequest("turnkey"), env)).status).toBe(400);

    const response = await app.request("/complete", completeRequest(), env);
    const body = (await response.json()) as {
      data: { setup: { status: string; currentStep: string; custodyProvider: string } };
    };
    expect(response.status).toBe(200);
    expect(body.data.setup).toMatchObject({
      status: "complete",
      currentStep: "complete",
      custodyProvider: "privy",
    });
  });
});
