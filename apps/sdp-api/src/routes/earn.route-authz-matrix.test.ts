import assert from "node:assert/strict";
import { type Action, actionsInModule, grantsCoverAction } from "@sdp/types/actions";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { earnRoutes } from "@/routes/earn";
import { type EarnAuthzTenant, seedEarnApiKey, seedEarnAuthzTenant } from "@/test/helpers/earn";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

/** Every mounted Earn route declares its one action. */
const EARN_ROUTE_ACTIONS = {
  "GET /discovery": "earn.read",
  "GET /positions": "earn.read",
  "GET /positions/:positionId": "earn.read",
  "POST /deposit": "earn.execute",
  "POST /withdraw": "earn.execute",
  "GET /onboarding/wisdomtree/forms/:entityType": "earn.read",
  "GET /onboarding/wisdomtree/:counterpartyId": "earn.read",
  "POST /onboarding/wisdomtree/:counterpartyId": "earn.execute",
  "POST /onboarding/wisdomtree/:counterpartyId/corrections/:reasonId": "earn.execute",
  "POST /onboarding/wisdomtree/:counterpartyId/documents": "earn.execute",
  "POST /onboarding/wisdomtree/:counterpartyId/wallets": "earn.execute",
} as const satisfies Record<string, Action>;

const EARN_ACTIONS = actionsInModule("earn");

const errorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

let ipCounter = 0;

function uniqueClientIp(): string {
  ipCounter += 1;
  return `10.0.${Math.floor(ipCounter / 256) % 256}.${ipCounter % 256}`;
}

function extractRoutes(router: typeof earnRoutes): string[] {
  const routes = router.routes
    .map((route) => `${route.method.toUpperCase()} ${route.path}`)
    .filter((route) => !route.startsWith("ALL "));
  return Array.from(new Set(routes)).sort();
}

function requestPath(route: string): {
  method: string;
  path: string;
} {
  const [method, path] = route.split(" ") as [string, string];
  return {
    method,
    path: `/v1/earn${path.replace(/:[A-Za-z]+/g, "id-probe")}`,
  };
}

function requestAsKey(route: string, rawKey: string, extraHeaders: Record<string, string>) {
  const { method, path } = requestPath(route);
  return app.request(
    path,
    {
      method,
      headers: {
        Authorization: `Bearer ${rawKey}`,
        "x-forwarded-for": uniqueClientIp(),
        ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
        ...extraHeaders,
      },
      ...(method === "GET" ? {} : { body: "{}" }),
    },
    env
  );
}

function requestAsClerk(route: string, token: string, projectId: string) {
  const { method, path } = requestPath(route);
  return app.request(
    path,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "x-project-id": projectId,
        "x-forwarded-for": uniqueClientIp(),
        ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
      },
      ...(method === "GET" ? {} : { body: "{}" }),
    },
    env
  );
}

function requestAnonymously(route: string) {
  const { method, path } = requestPath(route);
  return app.request(
    path,
    {
      method,
      headers: {
        "x-forwarded-for": uniqueClientIp(),
        ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
      },
      ...(method === "GET" ? {} : { body: "{}" }),
    },
    env
  );
}

const ROUTES = Object.keys(EARN_ROUTE_ACTIONS).sort();

/**
 * A project of another organization that no matrix user is a member of: the
 * membership 403 every route must answer it with (EARN-027).
 */
const FOREIGN_PROJECT_ID = "prj_matrix_foreign_sandbox";

const ACTION_BY_ROUTE: ReadonlyMap<string, Action> = new Map(Object.entries(EARN_ROUTE_ACTIONS));

function actionFor(route: string): Action {
  const action = ACTION_BY_ROUTE.get(route);
  assert(action);
  return action;
}

function grantSetId(grants: readonly Action[]): string {
  return grants.length === 0
    ? "none"
    : grants
        .map((grant) => grant.replace(".", "_"))
        .sort()
        .join("__");
}

/** Every Earn action except the ones that would cover `action`. */
function earnGrantsWithout(action: Action): Action[] {
  return EARN_ACTIONS.filter((grant) => !grantsCoverAction([grant], action));
}

const GRANT_SETS = new Map<string, readonly Action[]>();

GRANT_SETS.set(grantSetId(EARN_ACTIONS), EARN_ACTIONS);
for (const action of EARN_ACTIONS) {
  GRANT_SETS.set(grantSetId([action]), [action]);
  GRANT_SETS.set(grantSetId(earnGrantsWithout(action)), earnGrantsWithout(action));
}

let tenant: EarnAuthzTenant;

const rawKeyBySet = new Map<string, string>();

beforeEach(async () => {
  await seedTestDatabase(env);
  await clearKVStores(env);
  tenant = await seedEarnAuthzTenant(env, "matrix", { environment: "sandbox" });
  rawKeyBySet.clear();
  for (const [setId, grants] of GRANT_SETS) {
    const key = await seedEarnApiKey(env, tenant, {
      id: `key_matrix_${setId}`,
      environment: "sandbox",
      grants: [...grants],
    });
    rawKeyBySet.set(setId, key.raw);
  }
  // The foreign organization and its sandbox project exist for the EARN-027
  // membership refusals; nobody holds a project_members row for them.
  await getDb(env)
    .prepare(
      "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'enterprise', 'active')"
    )
    .bind("org_test_matrix_foreign", "Earn Authz Foreign", "earn-authz-foreign")
    .run();
  await seedDefaultProjects(getDb(env), {
    organizationId: "org_test_matrix_foreign",
    createdBy: tenant.user.id,
    members: [],
    ids: { sandbox: FOREIGN_PROJECT_ID, production: "prj_matrix_foreign_production" },
  });
});

describe("earn route inventory", () => {
  it("declares every live route in the scope table (a new route fails until added)", () => {
    expect(extractRoutes(earnRoutes)).toEqual(ROUTES);
  });
});

describe("credential conformance", () => {
  it.each(ROUTES.map((route) => ({ route })))(
    "$route refuses an anonymous caller before its handler",
    async ({ route }) => {
      const res = await requestAnonymously(route);
      expect(res.status, route).toBe(401);
      const body = errorBodySchema.parse(await res.json());
      expect(body.error.code, route).toBe("UNAUTHORIZED");
      expect(body.error.message.toLowerCase(), route).toContain("api key");
    }
  );
});

describe("action conformance: each route needs exactly its declared action", () => {
  it.each(ROUTES.map((route) => ({ route, action: actionFor(route) })))(
    "$route answers 403 naming $action to a key holding every other Earn action",
    async ({ route, action }) => {
      const raw = rawKeyBySet.get(grantSetId(earnGrantsWithout(action)));
      assert(raw);
      const res = await requestAsKey(route, raw, {});
      expect(res.status).toBe(403);
      const body = errorBodySchema.parse(await res.json());
      expect(body.error.code).toBe("INSUFFICIENT_PERMISSIONS");
      expect(body.error.message).toBe(`Missing action: ${action}`);
    }
  );
  it.each(ROUTES.map((route) => ({ route })))(
    "$route accepts its declared action alone (the table is exact, not merely sufficient)",
    async ({ route }) => {
      const raw = rawKeyBySet.get(grantSetId([actionFor(route)]));
      assert(raw, "Expected seeded API key");
      const res = await requestAsKey(route, raw, {});
      expect(res.status, `${route} still refused with its declared action`).not.toBe(403);
    }
  );
  it("an earn.read-only key cannot reach any money route", async () => {
    const raw = rawKeyBySet.get(grantSetId(["earn.read"]));
    assert(raw, "Expected seeded API key");
    const moneyRoutes = ROUTES.filter((route) => actionFor(route) === "earn.execute");
    expect(moneyRoutes.length).toBeGreaterThan(0);
    for (const route of moneyRoutes) {
      const res = await requestAsKey(route, raw, {});
      expect(res.status, route).toBe(403);
      const body = errorBodySchema.parse(await res.json());
      expect(body.error.code, route).toBe("INSUFFICIENT_PERMISSIONS");
    }
  });
});

describe("Clerk callers are membership-checked, per route (EARN-027)", () => {
  // The refusal is pinned positively on every route, so a router that stops
  // running the membership check (dropped project-context middleware, a new
  // route mounted without it) fails here instead of leaving the member test
  // below nothing to discriminate.
  it.each(ROUTES.map((route) => ({ route })))(
    "$route refuses another organization's project with the membership 403",
    async ({ route }) => {
      const res = await requestAsClerk(route, tenant.token, FOREIGN_PROJECT_ID);
      expect(res.status, `${route} admitted a project header the caller has no membership in`).toBe(
        403
      );
      const body = errorBodySchema.parse(await res.json());
      expect(body.error.code, route).toBe("FORBIDDEN");
      expect(body.error.message, route).toBe("Requested project is not accessible");
    }
  );

  it("a member project header is honored (never the membership 403)", async () => {
    for (const route of ROUTES) {
      const res = await requestAsClerk(route, tenant.token, tenant.project.id);
      if (res.status !== 403) continue; // past the membership gate; the handler's answer is its own test's concern
      const body = errorBodySchema.parse(await res.json());
      expect(
        body.error.message,
        `${route} answered the membership 403 for a project the user belongs to`
      ).not.toContain("not accessible");
    }
  });
});
