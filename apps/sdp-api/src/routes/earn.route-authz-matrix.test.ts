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
 * Three ratchets over the LIVE route inventory, so a new `/v1/earn` route
 * fails here until its author declares it:
 *
 * 1. **Scope conformance.** Every route's `requirePermissions` list is
 *    declared in `EARN_ROUTE_SCOPES`, and a key missing exactly one declared
 *    scope answers 403 `INSUFFICIENT_PERMISSIONS` — including the money-route
 *    guarantee that an `earn:read`-only key can never reach a write handler.
 *    Scope checks run before body validation, so the cells need no seeds.
 * 2. **`x-project-id` is inert for API-key callers**, per route: a header
 *    naming a sibling project changes nothing (the key pins project and
 *    environment; `middleware/project-context.ts`).
 * 3. **Session callers are membership-checked**, per route: a non-member
 *    project header is refused before any handler runs; a member project
 *    header is honored (whatever the route then answers, it is never the
 *    membership 403).
 *
 * Wallet BINDING enforcement (selected-scope keys) is deliberately not here:
 * bindings gate specific wallets, not routes, and live with the suites that
 * seed custody (`earn.vault.test.ts`, `earn.movements.test.ts`).
 */

const EARN_ROUTE_SCOPES: Record<string, readonly Permission[]> = {
  // Catalogue
  "GET /strategies": ["earn:read"],
  "GET /strategies/:strategyId": ["earn:read"],
  // External-wallet per-owner reads (no wallets:read: end-user wallets carry
  // no custody bindings — see the router comment)
  "GET /external-wallet/positions/summary": ["earn:read"],
  "GET /external-wallet/positions": ["earn:read"],
  "GET /external-wallet/movements": ["earn:read"],
  "GET /external-wallet/movements/:movementId": ["earn:read"],
  "GET /external-wallet/earnings": ["earn:read"],
  // Custody vault money + reads
  "POST /vault-deposits": ["earn:write", "wallets:read"],
  "POST /vault-deposit-previews": ["earn:read"],
  "GET /vault-deposits": ["earn:read", "wallets:read"],
  "GET /vault-deposits/:movementId": ["earn:read", "wallets:read"],
  "POST /vault-withdrawals": ["earn:write", "wallets:read"],
  "POST /vault-withdrawal-previews": ["earn:read", "wallets:read"],
  "GET /vault-withdrawals": ["earn:read", "wallets:read"],
  "GET /vault-withdrawals/:movementId": ["earn:read", "wallets:read"],
  "GET /vault-positions": ["earn:read", "wallets:read"],
  "GET /vault-share-reconciliation": ["earn:read", "wallets:read"],
  // External-wallet money (customer signs; the owner's signature is the final
  // authorization, so no wallets:read and no policy gate — router comment)
  "POST /external-wallet/deposit-transactions": ["earn:write"],
  "POST /external-wallet/deposits": ["earn:write"],
  "POST /external-wallet/withdrawal-previews": ["earn:read"],
  "POST /external-wallet/withdrawal-transactions": ["earn:write"],
  "POST /external-wallet/withdrawals": ["earn:write"],
  // Unified feed
  "GET /movements": ["earn:read", "wallets:read"],
  // Managed programs
  "GET /programs": ["earn:read"],
  "POST /programs": ["earn:write"],
  "GET /programs/:programId": ["earn:read"],
  "PUT /programs/:programId": ["earn:write"],
  "GET /programs/:programId/deposits": ["earn:read"],
  "POST /programs/:programId/withdrawal-preview": ["earn:read"],
  "POST /programs/:programId/withdrawals": ["earn:write"],
  "GET /programs/:programId/withdrawals": ["earn:read"],
  "GET /programs/:programId/withdrawals/:withdrawalRef": ["earn:read"],
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

const ROUTES = Object.keys(EARN_ROUTE_SCOPES).sort();

/** The declared scopes for a route in the table (routes come from its keys). */
function scopesFor(route: string): readonly Permission[] {
  const scopes = EARN_ROUTE_SCOPES[route];
  if (!scopes) throw new Error(`no scopes declared for ${route}`);
  return scopes;
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
for (const scopes of Object.values(EARN_ROUTE_SCOPES)) {
  PERMISSION_SETS.set(permissionSetId(scopes), scopes);
  for (const dropped of scopes) {
    const subset = scopes.filter((scope) => scope !== dropped);
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

describe("x-project-id is inert for API-key callers, per route (EARN-027)", () => {
  it("a sibling-project header changes nothing", async () => {
    const raw = rawKeyBySet.get(permissionSetId(ALL_EARN_SCOPES));
    if (!raw) throw new Error("missing key");

    for (const route of ROUTES) {
      const withoutHeader = await requestAsKey(route, raw);
      const withHeader = await requestAsKey(route, raw, {
        "x-project-id": tenant.siblingProject.id,
      });
      expect(withHeader.status, route).toBe(withoutHeader.status);
    }
  });
});

describe("session callers are membership-checked, per route (EARN-027)", () => {
  it("a non-member project header is refused before any handler runs", async () => {
    for (const route of ROUTES) {
      const res = await requestAsSession(route, tenant.sessionId, tenant.nonMemberProject.id);
      expect(res.status, route).toBe(403);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.message, route).toContain("not accessible");
    }
  });

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
