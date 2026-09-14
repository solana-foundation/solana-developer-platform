import type { Permission } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "@/index";
import earnRoutes from "@/routes/earn";
import { type EarnAuthzTenant, seedEarnApiKey, seedEarnAuthzTenant } from "@/test/helpers/earn";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

/**
 * The earn authz matrix (PRO-1860, threat model EARN-019/027).
 *
 * Two ratchets over the LIVE route inventory, so a new `/v1/earn` route
 * fails here until its author declares it:
 *
 * 1. **Scope conformance.** Every route's `requirePermissions` list is
 *    declared in `EARN_ROUTE_SCOPES`, and a key missing exactly one declared
 *    scope answers 403 `INSUFFICIENT_PERMISSIONS` — including the money-route
 *    guarantee that an `earn:read`-only key can never reach a write handler.
 *    Scope checks run before body validation, so the cells need no seeds.
 * 2. **Session callers are membership-checked**, per route: a member project
 *    header is honored (whatever the route then answers, it is never the
 *    membership 403).
 *
 * Wallet BINDING enforcement (selected-scope keys) is deliberately not here:
 * bindings gate specific wallets, not routes, and live with the suites that
 * seed custody (`earn.vault.test.ts`, `earn.movements.test.ts`).
 */

type EarnRouteDeclaration =
  | { readonly tier: "keyless"; readonly scopes: readonly Permission[] }
  | { readonly tier: "keyed"; readonly scopes: readonly Permission[] };

const keyless = (...scopes: Permission[]) =>
  ({ tier: "keyless", scopes }) as const satisfies EarnRouteDeclaration;
const keyed = (...scopes: Permission[]) =>
  ({ tier: "keyed", scopes }) as const satisfies EarnRouteDeclaration;

const EARN_ROUTE_SCOPES: Record<string, EarnRouteDeclaration> = {
  // Catalogue
  "GET /strategies": keyless("earn:read"),
  "GET /strategies/:strategyId": keyless("earn:read"),
  // External-wallet per-owner reads (no wallets:read: end-user wallets carry
  // no custody bindings — see the router comment)
  "GET /external-wallet/positions/summary": keyed("earn:read"),
  "GET /external-wallet/positions": keyed("earn:read"),
  "GET /external-wallet/movements": keyed("earn:read"),
  "GET /external-wallet/movements/:movementId": keyed("earn:read"),
  "GET /external-wallet/earnings": keyed("earn:read"),
  // Custody vault money + reads
  "POST /vault-deposits": keyed("earn:write", "wallets:read"),
  "POST /vault-deposit-previews": keyless("earn:read"),
  "GET /vault-deposits": keyed("earn:read", "wallets:read"),
  "GET /vault-deposits/:movementId": keyed("earn:read", "wallets:read"),
  "POST /vault-withdrawals": keyed("earn:write", "wallets:read"),
  "POST /vault-withdrawal-previews": keyed("earn:read", "wallets:read"),
  "GET /vault-withdrawals": keyed("earn:read", "wallets:read"),
  "GET /vault-withdrawals/:movementId": keyed("earn:read", "wallets:read"),
  "GET /vault-positions": keyed("earn:read", "wallets:read"),
  "GET /vault-share-reconciliation": keyed("earn:read", "wallets:read"),
  // External-wallet money (customer signs; the owner's signature is the final
  // authorization, so no wallets:read and no policy gate — router comment)
  "POST /external-wallet/deposit-transactions": keyless("earn:write"),
  "POST /external-wallet/deposits": keyed("earn:write"),
  "POST /external-wallet/withdrawal-previews": keyless("earn:read"),
  "POST /external-wallet/withdrawal-transactions": keyless("earn:write"),
  "POST /external-wallet/withdrawals": keyed("earn:write"),
  // Unified feed
  "GET /movements": keyed("earn:read", "wallets:read"),
  // Managed programs
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
  error: { code: string; message: string };
}

/**
 * A distinct client IP per request. The matrix fires far more than the
 * anonymous per-IP ceiling (`ANONYMOUS_MAX_REQUESTS`) within one rate-limit
 * window, and session-cookie requests present no `sk_` credential so they meet
 * that ceiling — a 429 would mask the authz answer under test. A unique
 * `x-forwarded-for` keys each request to its own counter; rate limiting is not
 * what these cells verify.
 */
let ipCounter = 0;
function uniqueClientIp(): string {
  ipCounter += 1;
  return `10.0.${Math.floor(ipCounter / 256) % 256}.${ipCounter % 256}`;
}

function extractRoutes(router: unknown): string[] {
  const routes = ((router as { routes?: Array<{ method: string; path: string }> }).routes ?? [])
    .map((route) => `${route.method.toUpperCase()} ${route.path}`)
    .filter((route) => !route.startsWith("ALL "));
  return Array.from(new Set(routes)).sort();
}

/** "GET /programs/:programId" → a requestable path with placeholder ids. */
function requestPath(route: string): { method: string; path: string } {
  const [method, path] = route.split(" ") as [string, string];
  return {
    method,
    path: `/v1/earn${path.replace(/:[A-Za-z]+/g, "id-probe")}`,
  };
}

function requestAsKey(route: string, rawKey: string, extraHeaders: Record<string, string> = {}) {
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

function requestAsSession(route: string, sessionId: string, projectId: string) {
  const { method, path } = requestPath(route);
  return app.request(
    path,
    {
      method,
      headers: {
        Cookie: `sdp_session=${sessionId}`,
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
const KEYLESS_ROUTES = ROUTES.filter((route) => EARN_ROUTE_SCOPES[route]?.tier === "keyless");
const KEYED_ROUTES = ROUTES.filter((route) => EARN_ROUTE_SCOPES[route]?.tier === "keyed");

/** The declared scopes for a route in the table (routes come from its keys). */
function scopesFor(route: string): readonly Permission[] {
  const declaration = EARN_ROUTE_SCOPES[route];
  if (!declaration) throw new Error(`no tier declared for ${route}`);
  return declaration.scopes;
}

/** One key per distinct permission set the matrix exercises. */
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
  tenant = await seedEarnAuthzTenant(env, "matrix");
  rawKeyBySet.clear();
  for (const [setId, permissions] of PERMISSION_SETS) {
    const key = await seedEarnApiKey(env, tenant, {
      id: `key_matrix_${setId}`,
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
      const res = await requestAsKey(route, "sk_test_unknown_key");

      expect(res.status, route).toBe(401);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code, route).toBe("INVALID_API_KEY");
    }
  );

  it.each(KEYLESS_ROUTES.map((route) => ({ route })))(
    "$route rejects a stale session cookie instead of silently downgrading",
    async ({ route }) => {
      const res = await requestAsSession(route, "ses_stale_earn_keyless", tenant.project.id);

      expect(res.status, route).toBe(401);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code, route).toBe("UNAUTHORIZED");
      expect(body.error.message, route).toContain("Invalid or expired session");
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
    if (!raw) throw new Error(`no key seeded for permission set [${granted.join(", ")}]`);

    const res = await requestAsKey(route, raw);

    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("INSUFFICIENT_PERMISSIONS");
  });

  it.each(ROUTES.map((route) => ({ route })))(
    "$route accepts its declared scopes (the table is exact, not merely sufficient)",
    async ({ route }) => {
      const raw = rawKeyBySet.get(permissionSetId(scopesFor(route)));
      if (!raw) throw new Error("missing key");

      const res = await requestAsKey(route, raw);

      // Whatever the empty-bodied, unseeded request earns (400/404/200/501…),
      // it must get PAST authorization: a 403 here means the declared list is
      // missing a scope the route actually demands.
      expect(res.status, `${route} still refused with its declared scopes`).not.toBe(403);
    }
  );

  it("an earn:read-only key cannot reach any money route", async () => {
    const raw = rawKeyBySet.get(permissionSetId(["earn:read"]));
    if (!raw) throw new Error("missing key");
    const moneyRoutes = ROUTES.filter((route) => scopesFor(route).includes("earn:write"));
    expect(moneyRoutes.length).toBeGreaterThan(0);

    for (const route of moneyRoutes) {
      const res = await requestAsKey(route, raw);
      expect(res.status, route).toBe(403);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code, route).toBe("INSUFFICIENT_PERMISSIONS");
    }
  });
});

describe("session callers are membership-checked, per route (EARN-027)", () => {
  it("a member project header is honored (never the membership 403)", async () => {
    for (const route of ROUTES) {
      const res = await requestAsSession(route, tenant.sessionId, tenant.project.id);
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
    if (!raw) throw new Error("missing key");

    for (const route of ROUTES) {
      const res = await requestAsKey(route, raw);
      expect(res.status, route).toBe(403);
    }
  });
});
