import assert from "node:assert/strict";
import { type Action, actionsInModule, grantsCoverAction } from "@sdp/types/actions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { app } from "@/index";
import { earnRoutes } from "@/routes/earn";
import { type EarnAuthzTenant, seedEarnApiKey, seedEarnAuthzTenant } from "@/test/helpers/earn";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

/**
 * Each Earn route's one action (coarse until Earn is promoted: reads `read`,
 * cancels and program setup `manage`, builds, submits and movements `execute`).
 */
const EARN_ROUTE_ACTIONS = {
  "GET /strategies": "earn.read",
  "GET /strategies/:strategyId": "earn.read",
  "GET /external-wallet/positions/summary": "earn.read",
  "GET /external-wallet/positions": "earn.read",
  "GET /external-wallet/movements": "earn.read",
  "GET /external-wallet/movements/:movementId": "earn.read",
  "GET /external-wallet/earnings": "earn.read",
  "POST /vault-deposits": "earn.execute",
  "POST /vault-deposit-previews": "earn.read",
  "GET /vault-deposits": "earn.read",
  "GET /vault-deposits/:movementId": "earn.read",
  "POST /vault-withdrawals": "earn.execute",
  "POST /vault-withdrawal-previews": "earn.read",
  "POST /vault-withdrawal-options": "earn.read",
  "POST /vault-queued-withdrawal-previews": "earn.read",
  "GET /vault-withdrawals": "earn.read",
  "GET /vault-withdrawals/:movementId": "earn.read",
  "POST /vault-withdrawal-requests": "earn.execute",
  "GET /vault-withdrawal-requests": "earn.read",
  "GET /vault-withdrawal-requests/:withdrawalRequestId": "earn.read",
  "POST /vault-withdrawal-requests/:withdrawalRequestId/cancel": "earn.manage",
  "GET /vault-positions": "earn.read",
  "GET /vault-share-reconciliation": "earn.read",
  "POST /external-wallet/deposit-transactions": "earn.execute",
  "POST /external-wallet/deposits": "earn.execute",
  "POST /external-wallet/withdrawal-previews": "earn.read",
  "POST /external-wallet/withdrawal-transactions": "earn.execute",
  "POST /external-wallet/withdrawal-options": "earn.read",
  "POST /external-wallet/queued-withdrawal-previews": "earn.read",
  "POST /external-wallet/withdrawal-request-transactions": "earn.execute",
  "POST /external-wallet/withdrawal-request-cancel-transactions": "earn.manage",
  "POST /external-wallet/withdrawals": "earn.execute",
  "POST /external-wallet/withdrawal-requests": "earn.execute",
  "POST /external-wallet/withdrawal-request-cancellations": "earn.execute",
  "GET /external-wallet/withdrawal-requests": "earn.read",
  "GET /external-wallet/withdrawal-requests/:withdrawalRequestId": "earn.read",
  "GET /movements": "earn.read",
  "GET /programs": "earn.read",
  "POST /programs": "earn.manage",
  "GET /programs/:programId": "earn.read",
  "PUT /programs/:programId": "earn.manage",
  "GET /programs/:programId/deposits": "earn.read",
  "POST /programs/:programId/withdrawal-preview": "earn.read",
  "POST /programs/:programId/withdrawals": "earn.execute",
  "GET /programs/:programId/withdrawals": "earn.read",
  "GET /programs/:programId/withdrawals/:withdrawalRef": "earn.read",
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

let originalMarketsEnabled: string | undefined;

let originalEarnEnabled: string | undefined;

beforeEach(async () => {
  originalMarketsEnabled = env.MARKETS_ENABLED;
  originalEarnEnabled = env.EARN_ENABLED;
  env.MARKETS_ENABLED = "true";
  env.EARN_ENABLED = "true";
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
});

afterEach(() => {
  env.MARKETS_ENABLED = originalMarketsEnabled;
  env.EARN_ENABLED = originalEarnEnabled;
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
  it("a member project header is honored (never the membership 403)", async () => {
    for (const route of ROUTES) {
      const res = await requestAsClerk(route, tenant.token, tenant.project.id);
      if (res.status !== 403) continue;
      const body = errorBodySchema.parse(await res.json());
      expect(
        body.error.message,
        `${route} answered the membership 403 for a project the user belongs to`
      ).not.toContain("not accessible");
    }
  });
});

describe("feature gate", () => {
  it("EARN_ENABLED off darkens every route with 403", async () => {
    env.EARN_ENABLED = "false";
    const raw = rawKeyBySet.get(grantSetId(EARN_ACTIONS));
    assert(raw, "Expected seeded API key");
    for (const route of ROUTES) {
      const res = await requestAsKey(route, raw, {});
      expect(res.status, route).toBe(403);
    }
  });
});
