import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { hashString } from "@sdp/payments/hash";
import {
  ACTIONS,
  API_KEY_FORBIDDEN_ACTIONS,
  COARSE_ACTION_MODULES,
  isAction,
  SDP_RAMP_PROVIDER_STAGES,
} from "@sdp/types";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "@/app";
import { getDb } from "@/db";
import { registeredRouteAuthorizations } from "@/routes/route-actions";
import { noopObservability } from "@/runtime/observability";
import { ALL_API_KEY_GRANTS, TEST_API_KEY, TEST_CACHED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { seedApiKeyRow } from "@/test/mocks/kv";

/**
 * Every route declares exactly one action, or is public with a reason
 * (HOO-2099). The list comes from the app itself, so a new route fails here
 * until it declares one.
 */
const app = createApp({
  observability: noopObservability,
  rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
});
const routes = registeredRouteAuthorizations(app);

function declared(kind: "action" | "public") {
  return routes.flatMap((route) =>
    route.declarations.length === 1 && route.declarations[0]?.kind === kind
      ? [{ route: `${route.method} ${route.path}`, declaration: route.declarations[0] }]
      : []
  );
}

describe("route actions", () => {
  it("finds the app's routes", () => {
    expect(routes.length).toBeGreaterThan(250);
  });

  it("declares exactly one action or public reason on every route", () => {
    const wrong = routes
      .filter((route) => route.declarations.length !== 1)
      .map((route) => `${route.method} ${route.path}: ${route.declarations.length} declarations`);
    expect(wrong).toEqual([]);
  });

  it("declares only registered actions", () => {
    const unknown = declared("action").filter(
      ({ declaration }) => declaration.kind === "action" && !isAction(declaration.action)
    );
    expect(unknown).toEqual([]);
  });

  it("pins every route without an action, with its reason", () => {
    expect(
      declared("public")
        .map(({ route, declaration }) =>
          declaration.kind === "public" ? `${route}: ${declaration.reason}` : route
        )
        .sort()
    ).toMatchSnapshot();
  });

  it("pins each route's action", () => {
    expect(
      declared("action")
        .map(({ route, declaration }) =>
          declaration.kind === "action" ? `${declaration.action} ${route}` : route
        )
        .sort()
    ).toMatchSnapshot();
  });

  it("uses every action somewhere, so the registry names nothing unenforced", () => {
    const used = new Set(
      declared("action").map(({ declaration }) =>
        declaration.kind === "action" ? declaration.action : ""
      )
    );
    expect(ACTIONS.filter((action) => !used.has(action))).toEqual([]);
  });

  it("marks the non-V1 modules coarse", () => {
    expect([...COARSE_ACTION_MODULES].sort()).toEqual([
      "dvp",
      "earn",
      "helius_rings",
      "issuance",
      "offramp",
      "onramp",
      "private_channels",
      "ramp_transfers",
      "rpc",
    ]);
  });
});

/** A concrete URL for a route pattern. */
function concretePath(routePath: string): string {
  return routePath
    .replace(":projectId", TEST_CACHED_API_KEY.projectId)
    .replace(":orgId", TEST_ORG.id)
    .replace(/:[A-Za-z0-9_]+(\{[^}]*\})?\??/g, "unused_id")
    .replace(/\*/g, "unused_id");
}

describe("actions no API key may hold", () => {
  const forbiddenRoutes = routes.filter((route) => {
    const [declaration] = route.declarations;
    return (
      declaration?.kind === "action" &&
      isAction(declaration.action) &&
      API_KEY_FORBIDDEN_ACTIONS.includes(declaration.action)
    );
  });

  beforeAll(async () => {
    await seedTestDatabase(env);
    await getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, TEST_ORG.status)
      .run();
    await seedApiKeyRow(env, await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER), {
      ...TEST_CACHED_API_KEY,
      grants: ALL_API_KEY_GRANTS,
    });
    // A stored row naming forbidden actions must still authorize none of them.
    await getDb(env)
      .prepare("UPDATE api_keys SET grants = ? WHERE id = ?")
      .bind([...ALL_API_KEY_GRANTS, ...API_KEY_FORBIDDEN_ACTIONS], TEST_CACHED_API_KEY.id)
      .run();
  });

  it("covers key, member, organization and project administration and every configure", () => {
    expect(forbiddenRoutes.length).toBeGreaterThan(30);
  });

  it.each(forbiddenRoutes.map((route) => [`${route.method} ${route.path}`, route]))(
    "refuses a key holding every action, forbidden ones included, on %s",
    async (_name, route) => {
      const method = route.method === "ALL" ? "GET" : route.method;
      const res = await app.request(
        concretePath(route.path),
        {
          method,
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `route-actions-${route.method}-${route.path}`,
          },
          body: method === "GET" ? undefined : "{}",
        },
        env
      );
      // 401 where the route admits only a Clerk session at all (the playground).
      expect([401, 403]).toContain(res.status);
    }
  );
});

/** Every non-test source file under a directory. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      return entry === "test" ? [] : sourceFiles(full);
    }
    return /\.ts$/.test(entry) && !/\.(test|spec)\.ts$/.test(entry) ? [full] : [];
  });
}

describe("caller authorization goes through actions only", () => {
  // Wallet bindings still carry permission strings until the wallet-scope
  // work replaces them; what is banned is judging the caller by them.
  const BANNED = [
    /\brequirePermissions(WhenAuthenticated)?\b/,
    /\bgrantedPermissions\b/,
    /\brequireAllowedOperation\b/,
    /\bassertOperationAllowed\b/,
    /\bhas(Any|All)?Permissions?\(/,
    /\b(auth|actor|clerk|apiKey)\.permissions\b/,
    /\bgetPermissionsFor(OrgRole|ApiKeyRole)\b/,
  ];
  const root = path.resolve(__dirname, "..");

  it("has no permission-string check of the caller in API source", () => {
    const offenders = sourceFiles(root).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          BANNED.some((pattern) => pattern.test(line))
            ? [`${path.relative(root, file)}:${index + 1}: ${line.trim()}`]
            : []
        )
    );
    expect(offenders).toEqual([]);
  });
});
