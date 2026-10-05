import assert from "node:assert/strict";
import type { Permission } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "@/index";
import earnRoutes from "@/routes/earn";
import { type EarnAuthzTenant, seedEarnApiKey, seedEarnAuthzTenant } from "@/test/helpers/earn";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

type EarnRouteDeclaration =
  | {
      readonly tier: "keyless";
      readonly scopes: readonly Permission[];
    }
  | {
      readonly tier: "keyed";
      readonly scopes: readonly Permission[];
    };

const keyless = (...scopes: Permission[]) =>
  ({ tier: "keyless", scopes }) as const satisfies EarnRouteDeclaration;

const keyed = (...scopes: Permission[]) =>
  ({ tier: "keyed", scopes }) as const satisfies EarnRouteDeclaration;

const EARN_ROUTE_SCOPES: Record<string, EarnRouteDeclaration> = {
  "GET /strategies": keyless("earn:read"),
  "GET /strategies/:strategyId": keyless("earn:read"),
  "GET /external-wallet/positions/summary": keyed("earn:read"),
  "GET /external-wallet/positions": keyed("earn:read"),
  "GET /external-wallet/movements": keyed("earn:read"),
  "GET /external-wallet/movements/:movementId": keyed("earn:read"),
  "GET /external-wallet/earnings": keyed("earn:read"),
  "POST /vault-deposits": keyed("earn:write", "wallets:read"),
  "POST /vault-deposit-previews": keyless("earn:read"),
  "GET /vault-deposits": keyed("earn:read", "wallets:read"),
  "GET /vault-deposits/:movementId": keyed("earn:read", "wallets:read"),
  "POST /vault-withdrawals": keyed("earn:write", "wallets:read"),
  "POST /vault-withdrawal-previews": keyed("earn:read", "wallets:read"),
  "POST /vault-withdrawal-options": keyed("earn:read", "wallets:read"),
  "POST /vault-queued-withdrawal-previews": keyed("earn:read", "wallets:read"),
  "GET /vault-withdrawals": keyed("earn:read", "wallets:read"),
  "GET /vault-withdrawals/:movementId": keyed("earn:read", "wallets:read"),
  "POST /vault-withdrawal-requests": keyed("earn:write", "wallets:read"),
  "GET /vault-withdrawal-requests": keyed("earn:read", "wallets:read"),
  "GET /vault-withdrawal-requests/:withdrawalRequestId": keyed("earn:read", "wallets:read"),
  "POST /vault-withdrawal-requests/:withdrawalRequestId/cancel": keyed(
    "earn:write",
    "wallets:read"
  ),
  "GET /vault-positions": keyed("earn:read", "wallets:read"),
  "GET /vault-share-reconciliation": keyed("earn:read", "wallets:read"),
  "POST /external-wallet/deposit-transactions": keyless("earn:write"),
  "POST /external-wallet/deposits": keyed("earn:write"),
  "POST /external-wallet/withdrawal-previews": keyless("earn:read"),
  "POST /external-wallet/withdrawal-transactions": keyless("earn:write"),
  "POST /external-wallet/withdrawal-options": keyless("earn:read"),
  "POST /external-wallet/queued-withdrawal-previews": keyless("earn:read"),
  "POST /external-wallet/withdrawal-request-transactions": keyed("earn:write"),
  "POST /external-wallet/withdrawal-request-cancel-transactions": keyed("earn:write"),
  "POST /external-wallet/withdrawals": keyed("earn:write"),
  "POST /external-wallet/withdrawal-requests": keyed("earn:write"),
  "POST /external-wallet/withdrawal-request-cancellations": keyed("earn:write"),
  "GET /external-wallet/withdrawal-requests": keyed("earn:read"),
  "GET /external-wallet/withdrawal-requests/:withdrawalRequestId": keyed("earn:read"),
  "GET /movements": keyed("earn:read", "wallets:read"),
  "GET /programs": keyed("earn:read"),
  "POST /programs": keyed("earn:write"),
  "GET /programs/:programId": keyed("earn:read"),
  "PUT /programs/:programId": keyed("earn:write"),
  "GET /programs/:programId/deposits": keyed("earn:read"),
  "POST /programs/:programId/withdrawal-preview": keyed("earn:read"),
  "POST /programs/:programId/withdrawals": keyed("earn:write"),
  "GET /programs/:programId/withdrawals": keyed("earn:read"),
  "GET /programs/:programId/withdrawals/:withdrawalRef": keyed("earn:read"),
};

const ALL_EARN_SCOPES = ["earn:read", "earn:write", "wallets:read"] as const satisfies Permission[];

interface ErrorBody {
  error: {
    code: string;
    message: string;
  };
}

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

const ROUTES = Object.keys(EARN_ROUTE_SCOPES).sort();

const KEYLESS_ROUTES = ROUTES.filter((route) => EARN_ROUTE_SCOPES[route].tier === "keyless");

const KEYED_ROUTES = ROUTES.filter((route) => EARN_ROUTE_SCOPES[route].tier === "keyed");

function scopesFor(route: string): readonly Permission[] {
  const declaration = EARN_ROUTE_SCOPES[route];
  assert(declaration);
  return declaration.scopes;
}

function permissionSetId(permissions: readonly Permission[]): string {
  return permissions.length === 0
    ? "none"
    : permissions
        .map((scope) => scope.replace(":", "_"))
        .sort()
        .join("__");
}

const PERMISSION_SETS = new Map<string, readonly Permission[]>();

PERMISSION_SETS.set(permissionSetId(ALL_EARN_SCOPES), ALL_EARN_SCOPES);

for (const declaration of Object.values(EARN_ROUTE_SCOPES)) {
  PERMISSION_SETS.set(permissionSetId(declaration.scopes), declaration.scopes);
  for (const dropped of declaration.scopes) {
    const subset = declaration.scopes.filter((scope) => scope !== dropped);
    PERMISSION_SETS.set(permissionSetId(subset), subset);
  }
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
  for (const [setId, permissions] of PERMISSION_SETS) {
    const key = await seedEarnApiKey(env, tenant, {
      id: `key_matrix_${setId}`,
      environment: "sandbox",
      permissions: [...permissions],
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

describe("route tier conformance", () => {
  it.each(KEYLESS_ROUTES.map((route) => ({ route })))(
    "$route admits an anonymous caller",
    async ({ route }) => {
      const res = await requestAnonymously(route);
      expect(res.status, `${route} unexpectedly required authentication`).not.toBe(401);
      expect(res.status, `${route} unexpectedly required permissions`).not.toBe(403);
    }
  );
  it.each(KEYLESS_ROUTES.map((route) => ({ route })))(
    "$route rejects an invalid presented API key instead of silently downgrading",
    async ({ route }) => {
      const res = await requestAsKey(route, "sk_test_unknown_key", {});
      expect(res.status, route).toBe(401);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code, route).toBe("INVALID_API_KEY");
    }
  );
  it.each(KEYLESS_ROUTES.map((route) => ({ route })))(
    "$route rejects a malformed bearer token instead of returning an internal error",
    async ({ route }) => {
      const res = await requestAsKey(route, "invalid", {});
      expect(res.status, route).toBe(401);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code, route).toBe("UNAUTHORIZED");
      expect(body.error.message, route).toBe("Invalid Clerk token");
    }
  );
  it.each(KEYED_ROUTES.map((route) => ({ route })))(
    "$route refuses an anonymous caller before its handler",
    async ({ route }) => {
      const res = await requestAnonymously(route);
      expect(res.status, route).toBe(401);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code, route).toBe("UNAUTHORIZED");
      expect(body.error.message.toLowerCase(), route).toContain("api key");
    }
  );
});

describe("scope conformance: a key missing exactly one declared scope is refused", () => {
  const cells = ROUTES.flatMap((route) =>
    scopesFor(route).map((dropped) => ({
      route,
      dropped,
      granted: scopesFor(route).filter((scope) => scope !== dropped),
    }))
  );
  it.each(cells)("$route answers 403 without $dropped", async ({ route, granted }) => {
    const raw = rawKeyBySet.get(permissionSetId(granted));
    assert(raw);
    const res = await requestAsKey(route, raw, {});
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("INSUFFICIENT_PERMISSIONS");
  });
  it.each(ROUTES.map((route) => ({ route })))(
    "$route accepts its declared scopes (the table is exact, not merely sufficient)",
    async ({ route }) => {
      const raw = rawKeyBySet.get(permissionSetId(scopesFor(route)));
      assert(raw, "Expected seeded API key");
      const res = await requestAsKey(route, raw, {});
      expect(res.status, `${route} still refused with its declared scopes`).not.toBe(403);
    }
  );
  it("an earn:read-only key cannot reach any money route", async () => {
    const raw = rawKeyBySet.get(permissionSetId(["earn:read"]));
    assert(raw, "Expected seeded API key");
    const moneyRoutes = ROUTES.filter((route) => scopesFor(route).includes("earn:write"));
    expect(moneyRoutes.length).toBeGreaterThan(0);
    for (const route of moneyRoutes) {
      const res = await requestAsKey(route, raw, {});
      expect(res.status, route).toBe(403);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code, route).toBe("INSUFFICIENT_PERMISSIONS");
    }
  });
});

describe("Clerk callers are membership-checked, per route (EARN-027)", () => {
  it("a member project header is honored (never the membership 403)", async () => {
    for (const route of ROUTES) {
      const res = await requestAsClerk(route, tenant.token, tenant.project.id);
      if (res.status !== 403) continue;
      const body = (await res.json()) as ErrorBody;
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
    const raw = rawKeyBySet.get(permissionSetId(ALL_EARN_SCOPES));
    assert(raw, "Expected seeded API key");
    for (const route of ROUTES) {
      const res = await requestAsKey(route, raw, {});
      expect(res.status, route).toBe(403);
    }
  });
});
