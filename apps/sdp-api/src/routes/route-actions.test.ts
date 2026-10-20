import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { hashString } from "@sdp/payments/hash";
import {
  ACTIONS,
  type Action,
  API_KEY_FORBIDDEN_ACTIONS,
  actionModuleOf,
  actionVerbOf,
  COARSE_ACTION_MODULES,
  isAction,
  isActionInReleaseChannel,
} from "@sdp/types/actions";
import {
  isModuleInReleaseChannel,
  SDP_RAMP_PROVIDER_STAGES,
  SDP_RELEASE_CHANNEL_NAMES,
} from "@sdp/types/release-channels";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp, type SdpPlugin } from "@/app";
import { getDb } from "@/db/client";
import { publicRoute, requireAction } from "@/middleware/require-action";
import routeActionsJson from "@/openapi/route-actions.generated.json";
import type { RegisteredRouteAuthorization } from "@/routes/route-actions";
import { registeredRouteAuthorizations, routeActionsByOperation } from "@/routes/route-actions";
import { type RouteOwner, routeOwnerOf } from "@/routes/route-modules";
import { ALL_API_KEY_GRANTS, TEST_API_KEY, TEST_SEEDED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

/**
 * Every route declares exactly one action, or is public with a reason
 * (HOO-2099). The list comes from the app itself, so a new route fails here
 * until it declares one.
 */
const app = createApp({
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

  // The OpenAPI document reads each route's action from this file, so it never
  // imports the app that mounts it. A route or action change regenerates it.
  it("matches the generated route-action map (pnpm -C apps/sdp-api route-actions:generate)", () => {
    expect(routeActionsJson).toEqual(routeActionsByOperation(app));
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

  it.each(SDP_RELEASE_CHANNEL_NAMES)(
    "lets a %s key hold the action of every route that channel runs",
    (channel) => {
      const inChannel = (owner: RouteOwner) =>
        owner === "core" || isModuleInReleaseChannel(channel, owner, SDP_RAMP_PROVIDER_STAGES);
      const unreachable = declared("action").flatMap(({ route, declaration }) => {
        if (declaration.kind !== "action" || !isAction(declaration.action)) return [];
        const routeOwner = routeOwnerOf(route.slice(route.indexOf(" ") + 1));
        if (!routeOwner || !inChannel(routeOwner)) return [];
        return isActionInReleaseChannel(declaration.action, inChannel)
          ? []
          : [`${declaration.action} ${route}`];
      });
      expect(unreachable).toEqual([]);
    }
  );

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
    ]);
  });
});

/** A concrete URL for a route pattern. */
function concretePath(routePath: string): string {
  return routePath
    .replace(":projectId", TEST_SEEDED_API_KEY.projectId)
    .replace(":orgId", TEST_ORG.id)
    .replace(/:[A-Za-z0-9_]+(\{[^}]*\})?\??/g, "unused_id")
    .replace(/\*/g, "unused_id");
}

/** Every flag-gated module on, so each route reaches its action check. */
const ALL_MODULES_ENV = {
  ...env,
  PRIVATE_CHANNELS_ENABLED: "true",
  HELIUS_RINGS_ENABLED: "true",
  MARKETS_ENABLED: "true",
  EARN_ENABLED: "true",
};

/** A request to a route as the test key, with a body for non-GET methods. */
function requestRoute(route: RegisteredRouteAuthorization, attempt: string) {
  const method = route.method === "ALL" ? "GET" : route.method;
  return app.request(
    concretePath(route.path),
    {
      method,
      headers: {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `route-actions-${attempt}-${route.method}-${route.path}`,
      },
      body: method === "GET" ? undefined : "{}",
    },
    ALL_MODULES_ENV
  );
}

const refusalSchema = z.object({
  error: z.object({ message: z.string(), details: z.object({ action: z.string() }) }),
});

/** The action a 403 names, or null for any other answer. */
async function refusedAction(res: Response): Promise<string | null> {
  if (res.status !== 403) return null;
  const body = refusalSchema.safeParse(await res.json());
  return body.success ? body.data.error.details.action : null;
}

async function seedTestKey(): Promise<void> {
  await seedTestDatabase(env);
  await getDb(env)
    .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
    .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, TEST_ORG.status)
    .run();
  await seedApiKeyRow(env, await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER), {
    ...TEST_SEEDED_API_KEY,
    grants: ALL_API_KEY_GRANTS,
    rateLimitTier: "unlimited",
  });
}

async function setTestKeyGrants(grants: readonly string[]): Promise<void> {
  await getDb(env)
    .prepare("UPDATE api_keys SET grants = ? WHERE id = ?")
    .bind([...grants], TEST_SEEDED_API_KEY.id)
    .run();
}

function declaredAction(route: RegisteredRouteAuthorization): Action | null {
  const [declaration] = route.declarations;
  return declaration?.kind === "action" && isAction(declaration.action) ? declaration.action : null;
}

/**
 * Routes on which a key holding every action, the forbidden ones included, is
 * refused before its action is checked: they admit a signed-in person only
 * (`requireHumanSession`), or a Clerk session only (the playground). Each is
 * still refused; the test pins that it never answers 2xx.
 */
const REFUSED_BEFORE_THE_ACTION =
  /^(\/v1\/(api-keys|members|organizations)|\/v1\/projects\/:projectId\/(api-keys|members)|\/internal\/(playground|dashboard\/custody|dashboard\/helius-rings|dashboard\/wallets))(\/|$)/;

/** The mounts above that refuse a key on every route, whatever its action. */
const KEYLESS_MOUNTS = /^\/internal\/(playground|dashboard\/(custody|helius-rings|wallets))(\/|$)/;

describe("actions no API key may hold", () => {
  const forbiddenRoutes = routes.filter((route) => {
    const action = declaredAction(route);
    return action !== null && API_KEY_FORBIDDEN_ACTIONS.includes(action);
  });

  beforeAll(async () => {
    await seedTestKey();
    // A stored row naming forbidden actions must still authorize none of them.
    await setTestKeyGrants([...ALL_API_KEY_GRANTS, ...API_KEY_FORBIDDEN_ACTIONS]);
  });

  it("covers key, member, organization and project administration and every configure", () => {
    expect(forbiddenRoutes.length).toBeGreaterThan(30);
  });

  it.each(forbiddenRoutes.map((route) => [`${route.method} ${route.path}`, route]))(
    "refuses a key holding every action, forbidden ones included, on %s",
    async (_name, route) => {
      const res = await requestRoute(route, "forbidden");
      if (REFUSED_BEFORE_THE_ACTION.test(route.path)) {
        expect([401, 403]).toContain(res.status);
        return;
      }
      expect(res.status).toBe(403);
      const body = refusalSchema.parse(await res.json());
      expect(body.error.details.action).toBe(declaredAction(route));
      expect(body.error.message).toBe(`API keys cannot perform ${declaredAction(route)}`);
    }
  );
});

/**
 * Every grant except the route's action: for a `read`, its module's `manage`
 * and `execute` go too, since each covers the read.
 */
function grantsWithout(action: Action): Action[] {
  const module = actionModuleOf(action);
  const covering =
    actionVerbOf(action) === "read"
      ? (grant: Action) =>
          grant === action ||
          (actionModuleOf(grant) === module &&
            (actionVerbOf(grant) === "manage" || actionVerbOf(grant) === "execute"))
      : (grant: Action) => grant === action;
  return ALL_API_KEY_GRANTS.filter((grant) => !covering(grant));
}

describe("each route enforces its own action", () => {
  const actionRoutes = routes.filter((route) => {
    const action = declaredAction(route);
    return action !== null && !API_KEY_FORBIDDEN_ACTIONS.includes(action);
  });

  beforeAll(seedTestKey);

  it("covers every route a key may call", () => {
    expect(actionRoutes.length).toBeGreaterThan(200);
  });

  it.each(
    actionRoutes.map((route) => [`${declaredAction(route)} ${route.method} ${route.path}`, route])
  )(
    "%s: refuses a key holding every other grant, and lets one holding it past the check",
    async (_name, route) => {
      const action = declaredAction(route);
      if (!action) throw new Error("filtered to action routes");
      await clearKVStores(env);

      if (KEYLESS_MOUNTS.test(route.path)) {
        await setTestKeyGrants([...grantsWithout(action), action]);
        expect([401, 403]).toContain((await requestRoute(route, "with")).status);
        return;
      }

      await setTestKeyGrants(grantsWithout(action));
      expect(await refusedAction(await requestRoute(route, "without"))).toBe(action);

      await setTestKeyGrants([...grantsWithout(action), action]);
      expect(await refusedAction(await requestRoute(route, "with"))).not.toBe(action);
    }
  );
});

describe("plugin routes", () => {
  // The repository registers no plugin: an embedder passes them to createApp.
  // The inventory reads whatever app it is handed, so a plugin's routes are
  // checked by the same rules wherever that app is built.
  it("inventories a plugin's routes with their declarations", () => {
    const plugin: SdpPlugin = {
      name: "route-actions-test",
      register: (v1) => {
        v1.get("/plugin-test/declared", requireAction("wallets.read"), (c) => c.json({}));
        v1.get("/plugin-test/public", publicRoute("plugin test"), (c) => c.json({}));
        v1.get("/plugin-test/undeclared", (c) => c.json({}));
      },
    };
    const withPlugin = registeredRouteAuthorizations(
      createApp({
        rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
        plugins: [plugin],
      })
    );
    const byPath = new Map(withPlugin.map((route) => [route.path, route.declarations]));
    expect(byPath.get("/v1/plugin-test/declared")).toEqual([
      { kind: "action", action: "wallets.read" },
    ]);
    expect(byPath.get("/v1/plugin-test/public")).toEqual([
      { kind: "public", reason: "plugin test" },
    ]);
    expect(byPath.get("/v1/plugin-test/undeclared")).toEqual([]);
  });
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
  // Route code judges the caller only through callerMayPerform or its route's
  // declaration: never its role, and never the decision functions behind them.
  const BANNED_IN_ROUTES = [
    /\bauthMayPerform\(/,
    /\borganizationRoleMayPerform\(/,
    /\bapiKeyMayPerform\(/,
    /\bgrantsCoverAction\(/,
    /\b(auth|actor|clerk|apiKey|caller|member)\.role\s*(===|!==|==|!=)/,
  ];
  // Checks that are not a tenant's authorization at all.
  const ROUTE_EXEMPTIONS = {
    "routes/allowlist/middleware.ts":
      "operator: an admin of the platform's own admin organization, not a tenant grant",
  } as const satisfies Record<string, string>;
  const root = path.resolve(__dirname, "..");

  function offendersOf(files: string[], patterns: RegExp[]): string[] {
    return files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          patterns.some((pattern) => pattern.test(line))
            ? [`${path.relative(root, file)}:${index + 1}: ${line.trim()}`]
            : []
        )
    );
  }

  it("has no permission-string check of the caller in API source", () => {
    expect(offendersOf(sourceFiles(root), BANNED)).toEqual([]);
  });

  it("has no role or decision-function check of the caller in route code", () => {
    const files = sourceFiles(path.join(root, "routes")).filter(
      (file) => !(path.relative(root, file) in ROUTE_EXEMPTIONS)
    );
    expect(offendersOf(files, BANNED_IN_ROUTES)).toEqual([]);
  });
});
