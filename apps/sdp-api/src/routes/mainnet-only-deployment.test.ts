import { ORGANIZATION_NOT_ADMITTED_REASON } from "@sdp/types/organizations";
import { SDP_RAMP_PROVIDER_MATURITY } from "@sdp/types/release-channels";
import { inspectRoutes } from "hono/dev";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "@/app";
import { getDb } from "@/db/client";
import { assertProjectEnvironmentsConfig } from "@/lib/production-entitlement";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import {
  authenticateTestClerkUser,
  clerkHeadersWithoutProject,
  ensureTestClerkIssuer,
} from "@/test/helpers/clerk";
import { env as baseEnv } from "@/test/helpers/env";
import {
  NO_PROJECT_ROUTES,
  probeMethod,
  projectRoutePath,
} from "@/test/helpers/project-route-probe";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

/**
 * A mainnet-only deployment (`SDP_ALLOW_SANDBOX_PROJECTS=false`): it refuses and hides every
 * sandbox project, and admits only an organization that holds the production entitlement.
 */

const SANDBOX_PROJECT_ID = `prj_${TEST_ORG.id}_sandbox`;
const PRODUCTION_PROJECT_ID = `prj_${TEST_ORG.id}_production`;

const app = createApp({ rampProviderMaturity: SDP_RAMP_PROVIDER_MATURITY });
const env = {
  ...baseEnv,
  SDP_RELEASE_CHANNEL: "experimental",
  PRIVATE_CHANNELS_ENABLED: "true",
  HELIUS_RINGS_ENABLED: "true",
  SDP_ALLOW_SANDBOX_PROJECTS: "false",
};

type Actor = Awaited<ReturnType<typeof authenticateTestClerkUser>>;

async function seedOrganization(productionEntitled: boolean): Promise<Actor> {
  await ensureTestClerkIssuer(env);
  await seedTestDatabase(env);
  await clearKVStores(env);
  const db = getDb(env);
  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "enterprise", TEST_ORG.status),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(TEST_USER.id, TEST_USER.email),
  ]);
  await seedDefaultProjects(db, {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    members: [TEST_USER.id],
    productionEntitled,
  });
  return authenticateTestClerkUser(env, db, {
    userId: TEST_USER.id,
    email: TEST_USER.email,
    clerkUserId: "clerk_user_mainnet_only",
    organizationId: TEST_ORG.id,
    clerkOrgId: "org_clerk_mainnet_only",
    orgSlug: TEST_ORG.slug,
    role: "admin",
  });
}

async function errorOf(response: Response) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string; details?: { reason?: string } };
  } | null;
  return { status: response.status, ...body?.error };
}

describe("a mainnet-only deployment, for an organization with mainnet access", () => {
  let actor: Actor;

  beforeAll(async () => {
    actor = await seedOrganization(true);
  });

  it("refuses its sandbox project on every project route", async () => {
    const reached: string[] = [];
    const headers = actor.headers(SANDBOX_PROJECT_ID);
    for (const { method, path, isMiddleware } of inspectRoutes(app)) {
      if (isMiddleware || NO_PROJECT_ROUTES.some(([pattern]) => pattern.test(path))) continue;
      const response = await app.request(
        projectRoutePath(path, SANDBOX_PROJECT_ID),
        { method: probeMethod(method), headers },
        env
      );
      const error = await errorOf(response);
      if (
        error.status !== 403 ||
        error.message !== "Sandbox projects are not available on this deployment"
      ) {
        reached.push(`${method} ${path} -> ${error.status} ${error.message ?? ""}`);
      }
    }
    expect(reached).toEqual([]);
  });

  it("lists its production project only", async () => {
    const list = await app.request(
      "/v1/projects",
      { headers: clerkHeadersWithoutProject(actor.token) },
      env
    );
    const listed = (await list.json()) as { data: { projects: { id: string }[] } };
    expect(listed.data.projects.map((project) => project.id)).toEqual([PRODUCTION_PROJECT_ID]);
  });

  it("serves its production project", async () => {
    const response = await app.request(
      `/v1/projects/${PRODUCTION_PROJECT_ID}`,
      { headers: actor.headers(PRODUCTION_PROJECT_ID) },
      env
    );
    expect(response.status).toBe(200);
  });
});

describe("a mainnet-only deployment, for an organization without mainnet access", () => {
  let actor: Actor;

  beforeAll(async () => {
    actor = await seedOrganization(false);
  });

  it("lists no project, and still serves its organization, members and mainnet status", async () => {
    const headers = clerkHeadersWithoutProject(actor.token);
    const list = await app.request("/v1/projects", { headers }, env);
    expect(((await list.json()) as { data: { projects: unknown[] } }).data.projects).toEqual([]);
    for (const path of [
      `/v1/organizations/${TEST_ORG.id}`,
      `/v1/organizations/${TEST_ORG.id}/mainnet-access`,
      "/v1/members",
    ]) {
      expect((await app.request(path, { headers }, env)).status, path).toBe(200);
    }
    const access = await app.request(
      `/v1/organizations/${TEST_ORG.id}/mainnet-access`,
      { headers },
      env
    );
    expect((await access.json()).data).toMatchObject({ mainnetOnly: true, sandboxOnly: false });
  });

  it("refuses an organization-level action, naming why", async () => {
    const response = await app.request(
      "/v1/members/x1/api-keys",
      { headers: clerkHeadersWithoutProject(actor.token) },
      env
    );
    expect(await errorOf(response)).toMatchObject({
      status: 403,
      details: { reason: ORGANIZATION_NOT_ADMITTED_REASON },
    });
  });

  it("refuses its production project, which it may not use yet", async () => {
    for (const path of [`/v1/projects/${PRODUCTION_PROJECT_ID}/api-keys`, "/v1/wallets"]) {
      const response = await app.request(
        path,
        { headers: actor.headers(PRODUCTION_PROJECT_ID) },
        env
      );
      expect(response.status, path).toBe(403);
    }
  });
});

describe("project environment settings", () => {
  it("refuses a deployment that admits neither environment", () => {
    expect(() =>
      assertProjectEnvironmentsConfig({
        SDP_ALLOW_PRODUCTION_PROJECTS: "false",
        SDP_ALLOW_SANDBOX_PROJECTS: "false",
      })
    ).toThrow("cannot both be false");
    expect(() => assertProjectEnvironmentsConfig({ SDP_ALLOW_SANDBOX_PROJECTS: "no" })).toThrow(
      "Invalid SDP_ALLOW_SANDBOX_PROJECTS"
    );
    expect(() =>
      assertProjectEnvironmentsConfig({ SDP_ALLOW_SANDBOX_PROJECTS: "false" })
    ).not.toThrow();
  });
});
