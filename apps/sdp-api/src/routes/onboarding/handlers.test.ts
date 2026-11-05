import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { AppError } from "@/lib/errors";
import { authorize } from "@/middleware/authorize";
import { requestIdMiddleware } from "@/middleware/request-id";
import { successResponseSchema } from "@/openapi/schemas/base";
import { organizationOnboardingSetupSchema } from "@/openapi/schemas/onboarding";
import { seedClerkIdentity } from "@/test/helpers/clerk";
import { seedTestCustodyRows, type TestCustodyConfigRow } from "@/test/helpers/custody";
import { seedTestPrivyConnection } from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import { organizationCreator, seedOrganization } from "@/test/helpers/organizations";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";
import { authorizeOnboardingSession } from "./access";
import { getOnboardingStatus } from "./handlers";

const ORGANIZATION_ID = "org_onboarding_test";
const CLERK_ORGANIZATION_ID = "org_clerk_onboarding_test";
const CLERK_USER_ID = "user_clerk_onboarding_test";
const USER_ID = "user_onboarding_test";
const PROJECT_ID = "project_onboarding_test";

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
      clerkUserId: CLERK_USER_ID,
      clerkOrgId: CLERK_ORGANIZATION_ID,
      orgSlug: "onboarding-test",
      email: "onboarding@example.com",
      organizationId: ORGANIZATION_ID,
    });
    await next();
  });
  app.get("/status", authorize(authorizeOnboardingSession), getOnboardingStatus);
  return app;
}

async function seedOnboardingOrganization() {
  await getDb(env)
    .prepare(
      `INSERT INTO users (id, email, email_verified, name, status)
       VALUES (?, 'onboarding@example.com', 1, 'Onboarding user', 'active')`
    )
    .bind(USER_ID)
    .run();
  await seedOrganization(getDb(env), {
    id: ORGANIZATION_ID,
    name: "Onboarding test",
    slug: "onboarding-test",
    status: "active",
    creator: { id: USER_ID, email: "onboarding@example.com" },
  });
  await seedClerkIdentity(getDb(env), {
    userId: USER_ID,
    email: "onboarding@example.com",
    clerkUserId: CLERK_USER_ID,
    organizationId: ORGANIZATION_ID,
    clerkOrgId: CLERK_ORGANIZATION_ID,
    orgSlug: "onboarding-test",
    role: "admin",
  });
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

function custodyConfig(
  overrides: Pick<TestCustodyConfigRow, "id" | "projectId" | "provider" | "status">
): TestCustodyConfigRow {
  return {
    ...overrides,
    organizationId: ORGANIZATION_ID,
    configEncrypted: "encrypted",
  };
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
    await seedOnboardingOrganization();
  });

  it("lists the provider of an active BYOK connection alone", async () => {
    await seedPrivyConnection({
      connectionId: "cconn_onboarding_active",
      lastCheckStatus: "success",
    });

    expect(await getSetup()).toEqual({ custodyProviders: ["privy"], canManage: true });
  });

  it("lists distinct active sandbox providers in catalog order", async () => {
    await seedOrganization(getDb(env), {
      id: "org_onboarding_other",
      name: "Onboarding other",
      slug: "onboarding-other",
      status: "active",
      creator: organizationCreator("org_onboarding_other"),
    });
    await seedDefaultProjects(getDb(env), {
      organizationId: "org_onboarding_other",
      createdBy: USER_ID,
      members: [],
      ids: {
        sandbox: "project_onboarding_other_sandbox",
        production: "project_onboarding_other_production",
      },
    });
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
        {
          id: "cfg_onboarding_other_organization_dfns",
          organizationId: "org_onboarding_other",
          projectId: "project_onboarding_other_sandbox",
          provider: "dfns",
          configEncrypted: "encrypted",
          status: "active",
        },
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

    expect(await getSetup()).toEqual({ custodyProviders: [], canManage: true });
  });
});
