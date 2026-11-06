import { SDP_RAMP_PROVIDER_MATURITY } from "@sdp/types/release-channels";
import { inspectRoutes } from "hono/dev";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "@/app";
import { getDb } from "@/db/client";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { authenticateTestClerkUser, ensureTestClerkIssuer } from "@/test/helpers/clerk";
import { env as baseEnv } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import { isEarnExitOrRead } from "./earn/exits";

/**
 * Routes that act on no project, so the production entitlement has nothing
 * to refuse. Every other route must refuse a production project without the
 * entitlement (APE-351). Each entry says why; a new route lands in this list
 * only on purpose.
 */
const NO_PROJECT_ROUTES: readonly (readonly [RegExp, string])[] = [
  [/^\/(health|docs|openapi\.json|llms\.txt)?(\/|$)/, "public metadata"],
  [/^\/webhooks\//, "provider- or Clerk-signed inbound events; they finish money already moving"],
  [/^\/pay(\/|$)/, "public payment page; admits its own money movement (lib/money-admission.ts)"],
  [/^\/admin\//, "operator routes behind their own credential"],
  [/^\/v1\/(organizations|onboarding|places)(\/|$)/, "organization-scoped, no project"],
  [/^\/v1\/members(\/me)?$/, "membership reads and leaving, no project (ADR 0012)"],
  [
    /^\/v1\/members\/:memberId\/api-keys$/,
    "reads one member's keys across every project, so no single project (HOO-2301)",
  ],
  [/^\/internal\/dashboard\/network(\/|$)/, "chain-wide public figures; reads no tenant data"],
  [/^\/v1\/projects$/, "lists projects; hides production without the entitlement"],
  [
    /^\/v1\/issuance\/tokens\/:tokenId\/metadata\.json$/,
    "public token metadata that issued tokens point to on chain; serves, never acts",
  ],
];

const PRODUCTION_PROJECT_ID = `prj_${TEST_ORG.id}_production`;

function probeMethod(method: string): string {
  return method === "ALL" ? "GET" : method;
}

/** A concrete URL: `:projectId` is the production project, every other param a placeholder. */
function concretePath(path: string): string {
  return path
    .replace(/:projectId(\{[^}]*\})?\??/g, PRODUCTION_PROJECT_ID)
    .replace(/:[A-Za-z0-9_]+(\{[^}]*\})?\??/g, "x1")
    .replace(/\*/g, "x1");
}

function exemption(method: string, path: string): string | undefined {
  const reason = NO_PROJECT_ROUTES.find(([pattern]) => pattern.test(path))?.[1];
  if (reason) return reason;
  if (path.startsWith("/v1/earn/") && isEarnExitOrRead(probeMethod(method), concretePath(path))) {
    return "Earn read or exit (ADR 0002)";
  }
  return undefined;
}

describe.each([
  {
    label: "without the entitlement",
    productionEntitled: false,
    allowProductionProjects: undefined,
  },
  {
    label: "with the entitlement, on a deployment that admits no production project",
    productionEntitled: true,
    allowProductionProjects: "false",
  },
])(
  "production refusal covers every project route $label (APE-351)",
  ({ label, productionEntitled, allowProductionProjects }) => {
    const app = createApp({
      rampProviderMaturity: SDP_RAMP_PROVIDER_MATURITY,
    });
    const routes = new Map<string, { method: string; path: string }>();
    for (const { method, path, isMiddleware } of inspectRoutes(app)) {
      if (!isMiddleware) routes.set(`${method} ${path}`, { method, path });
    }
    const env = {
      ...baseEnv,
      SDP_RELEASE_CHANNEL: "experimental",
      PRIVATE_CHANNELS_ENABLED: "true",
      HELIUS_RINGS_ENABLED: "true",
      SDP_ALLOW_PRODUCTION_PROJECTS: allowProductionProjects,
    };
    let headers: Record<string, string>;

    beforeAll(async () => {
      await ensureTestClerkIssuer(env);
      await seedTestDatabase(env);
      // Both cases probe every route as one actor; each starts under no rate limit.
      await clearKVStores(env);
      const db = getDb(env);
      await db.batch([
        db
          .prepare(
            "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)"
          )
          .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "enterprise", TEST_ORG.status),
        db
          .prepare(
            "INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
          )
          .bind(TEST_USER.id, TEST_USER.email),
      ]);
      await seedDefaultProjects(db, {
        organizationId: TEST_ORG.id,
        createdBy: TEST_USER.id,
        members: [TEST_USER.id],
        productionEntitled,
      });
      const actor = await authenticateTestClerkUser(env, db, {
        userId: TEST_USER.id,
        email: TEST_USER.email,
        clerkUserId: "clerk_user_entitlement_routes",
        organizationId: TEST_ORG.id,
        clerkOrgId: "org_clerk_entitlement_routes",
        orgSlug: TEST_ORG.slug,
        role: "admin",
      });
      headers = actor.headers(PRODUCTION_PROJECT_ID);
    });

    it(`refuses a production project ${label} on every non-exempt route`, async () => {
      const reached: string[] = [];
      for (const { method, path } of routes.values()) {
        if (exemption(method, path)) continue;
        const response = await app.request(
          concretePath(path),
          { method: probeMethod(method), headers },
          env
        );
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        if (
          response.status !== 403 ||
          body?.error?.message !== "Production is not enabled for this organization"
        ) {
          reached.push(`${method} ${path} -> ${response.status} ${body?.error?.message ?? ""}`);
        }
      }
      expect(reached).toEqual([]);
    });

    it("lists no production project", async () => {
      const list = await app.request("/v1/projects", { headers }, env);
      const listed = (await list.json()) as { data: { projects: { environment: string }[] } };
      expect(listed.data.projects.map((project) => project.environment)).toEqual(["sandbox"]);
    });

    it("files every exemption pattern against a route that exists", () => {
      const paths = [...routes.values()].map(({ path }) => path);
      const unused = NO_PROJECT_ROUTES.filter(([pattern]) => !paths.some((p) => pattern.test(p)));
      expect(unused.map(([pattern]) => String(pattern))).toEqual([]);
    });
  }
);
