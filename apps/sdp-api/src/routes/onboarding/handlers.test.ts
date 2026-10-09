import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import { requestIdMiddleware } from "@/middleware/request-id";
import { validateBody } from "@/middleware/validate";
import { successResponseSchema } from "@/openapi/schemas/base";
import {
  onboardingCompleteResponseSchema,
  organizationOnboardingSetupSchema,
} from "@/openapi/schemas/onboarding";
import { seedTestCustodyRows, type TestCustodyConfigRow } from "@/test/helpers/custody";
import { seedTestPrivyConnection } from "@/test/helpers/custody-connections";
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
  app.use("*", requestIdMiddleware());
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

const statusResponseSchema = successResponseSchema(
  z.object({ setup: organizationOnboardingSetupSchema })
);

const completeResponseSchema = successResponseSchema(onboardingCompleteResponseSchema);

function custodyConfig(
  overrides: Pick<TestCustodyConfigRow, "id" | "projectId" | "provider" | "status">
): TestCustodyConfigRow {
  return {
    ...overrides,
    organizationId: ORGANIZATION_ID,
    configEncrypted: "encrypted",
  };
}

async function seedDefaultSandboxCustodyWallet() {
  await seedTestCustodyRows(env, {
    configs: [
      custodyConfig({
        id: "cfg_onboarding_test",
        projectId: PROJECT_ID,
        provider: "privy",
        status: "active",
      }),
    ],
    wallets: [
      {
        id: "cw_onboarding_test",
        owner: { kind: "config", custodyConfigId: "cfg_onboarding_test" },
        walletId: "wallet_onboarding_test",
        publicKey: "11111111111111111111111111111111",
        label: "Onboarding wallet",
        purpose: null,
        status: "active",
      },
    ],
  });
}

async function seedPrivyConnection(params: {
  connectionId: string;
  lastCheckStatus: "success" | "retry_unknown";
}) {
  const walletRecordId = `cw_${params.connectionId}`;
  const shared = {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    connectionId: params.connectionId,
    credentialId: `pcred_${params.connectionId}`,
    createdBy: USER_ID,
    stored: { storageBackend: "encrypted_db" as const, encryptedSecretPayload: "test-ciphertext" },
    providerAccountFingerprint: `sha256:${params.connectionId}`,
    wallets: [
      {
        id: walletRecordId,
        walletId: `privy_${params.connectionId}`,
        publicKey: "11111111111111111111111111111111",
        label: null,
        purpose: null,
        status: "active" as const,
      },
    ],
  };
  await getDb(env).transaction(async (tx) => {
    if (params.lastCheckStatus === "success") {
      await seedTestPrivyConnection(tx, {
        ...shared,
        lastCheckStatus: "success",
        defaultCustodyWalletId: walletRecordId,
      });
    } else {
      await seedTestPrivyConnection(tx, { ...shared, lastCheckStatus: "retry_unknown" });
    }
  });
}

async function getSetup() {
  const response = await createApp().request("/status", {}, env);
  expect(response.status).toBe(200);
  return statusResponseSchema.parse(await response.json()).data.setup;
}

describe("organization onboarding handlers", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedOrganization();
  });

  it("starts a newly created organization at custody", async () => {
    expect(await getSetup()).toEqual({
      status: "not_started",
      currentStep: "custody",
      custodyProviders: [],
      completedAt: null,
      version: 1,
      canManage: true,
    });
  });

  it("moves to in progress once the default sandbox custody config exists", async () => {
    await seedDefaultSandboxCustodyWallet();

    expect(await getSetup()).toEqual({
      status: "in_progress",
      currentStep: "custody",
      custodyProviders: ["privy"],
      completedAt: null,
      version: 1,
      canManage: true,
    });
  });

  it("moves to in progress on an active BYOK connection alone", async () => {
    await seedPrivyConnection({
      connectionId: "cconn_onboarding_active",
      lastCheckStatus: "success",
    });

    expect(await getSetup()).toEqual({
      status: "in_progress",
      currentStep: "custody",
      custodyProviders: ["privy"],
      completedAt: null,
      version: 1,
      canManage: true,
    });
  });

  it("lists distinct active sandbox providers in catalog order", async () => {
    await seedTestCustodyRows(env, {
      configs: [
        custodyConfig({
          id: "cfg_onboarding_turnkey",
          projectId: PROJECT_ID,
          provider: "turnkey",
          status: "active",
        }),
        custodyConfig({
          id: "cfg_onboarding_para",
          projectId: PROJECT_ID,
          provider: "para",
          status: "active",
        }),
        custodyConfig({
          id: "cfg_onboarding_privy",
          projectId: PROJECT_ID,
          provider: "privy",
          status: "active",
        }),
        custodyConfig({
          id: "cfg_onboarding_anchorage",
          projectId: PROJECT_ID,
          provider: "anchorage",
          status: "inactive",
        }),
        custodyConfig({
          id: "cfg_onboarding_production_dfns",
          projectId: `${PROJECT_ID}_production`,
          provider: "dfns",
          status: "active",
        }),
      ],
      wallets: [],
    });
    await seedPrivyConnection({
      connectionId: "cconn_onboarding_active",
      lastCheckStatus: "success",
    });

    expect((await getSetup()).custodyProviders).toEqual(["privy", "para", "turnkey"]);
  });

  it("leaves out inactive configs and connections that are not active", async () => {
    await seedTestCustodyRows(env, {
      configs: [
        custodyConfig({
          id: "cfg_onboarding_inactive",
          projectId: PROJECT_ID,
          provider: "turnkey",
          status: "inactive",
        }),
      ],
      wallets: [],
    });
    await seedPrivyConnection({
      connectionId: "cconn_onboarding_pending",
      lastCheckStatus: "retry_unknown",
    });

    expect(await getSetup()).toEqual({
      status: "not_started",
      currentStep: "custody",
      custodyProviders: [],
      completedAt: null,
      version: 1,
      canManage: true,
    });
  });

  it("completes once the requested provider backs the default sandbox project", async () => {
    const app = createApp();
    expect((await app.request("/complete", completeRequest("privy"), env)).status).toBe(400);

    await seedDefaultSandboxCustodyWallet();

    expect((await app.request("/complete", completeRequest("turnkey"), env)).status).toBe(400);

    const response = await app.request("/complete", completeRequest("privy"), env);
    expect(response.status).toBe(200);
    const { setup } = completeResponseSchema.parse(await response.json()).data;
    expect(setup).toEqual({
      status: "complete",
      currentStep: "complete",
      custodyProviders: ["privy"],
      completedAt: expect.any(String),
      version: 1,
      canManage: true,
    });
  });
});
