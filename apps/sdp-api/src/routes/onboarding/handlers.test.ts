import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import { validateBody } from "@/middleware/validate";
import { seedTestCustodySetup } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";
import { completeOnboarding, getOnboardingStatus } from "./handlers";
import { completeOnboardingSchema } from "./schemas";

const ORGANIZATION_ID = "org_onboarding_test";
const CLERK_ORGANIZATION_ID = "org_clerk_onboarding_test";
const USER_ID = "user_onboarding_test";
const PROJECT_ID = "project_onboarding_test";

function completeRequest(custodyProvider: string) {
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
  app.post("/complete", validateBody(completeOnboardingSchema), completeOnboarding);
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
        `INSERT INTO auth_organization_identities
           (id, provider, provider_org_id, organization_id, slug)
         VALUES ('aoi_onboarding_test', 'clerk', ?, ?, 'onboarding-test')`
      )
      .bind(CLERK_ORGANIZATION_ID, ORGANIZATION_ID),
  ]);
  await seedDefaultProjects(getDb(env), {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [],
    ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
  });
}

async function seedDefaultSandboxCustodyWallet() {
  await seedTestCustodySetup(
    env,
    {
      id: "cfg_onboarding_test",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "privy",
      config: "encrypted",
      encryptionVersion: "sdp-custody-encryption-v1",
      defaultWalletId: "wallet_onboarding_test",
      status: "active",
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    },
    {
      id: "cw_onboarding_test",
      custodyConfigId: "cfg_onboarding_test",
      walletId: "wallet_onboarding_test",
      publicKey: "11111111111111111111111111111111",
      label: "Default wallet",
      purpose: null,
      status: "active",
      createdAt: "2026-07-21T00:00:00.000Z",
    }
  );
}

async function getSetup() {
  const response = await createApp().request("/status", {}, env);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: {
      setup: {
        status: string;
        currentStep: string;
        custodyProvider: string | null;
        canManage: boolean;
      };
    };
  };
  return body.data.setup;
}

describe("organization onboarding handlers", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedOrganization();
  });

  it("starts a newly created organization at custody", async () => {
    expect(await getSetup()).toMatchObject({
      status: "not_started",
      currentStep: "custody",
      custodyProvider: null,
      canManage: true,
    });
  });

  it("moves to in progress once the default sandbox custody wallet exists", async () => {
    await seedDefaultSandboxCustodyWallet();

    expect(await getSetup()).toMatchObject({
      status: "in_progress",
      currentStep: "custody",
      custodyProvider: "privy",
    });
  });

  it("completes once the active custody wallet exists", async () => {
    const app = createApp();
    expect((await app.request("/complete", completeRequest("privy"), env)).status).toBe(400);

    await seedDefaultSandboxCustodyWallet();

    expect((await app.request("/complete", completeRequest("turnkey"), env)).status).toBe(400);

    const response = await app.request("/complete", completeRequest("privy"), env);
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
