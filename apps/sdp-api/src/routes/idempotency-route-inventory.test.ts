import {
  IDEMPOTENCY_REQUIRED_ROUTES,
  SDP_RAMP_PROVIDER_STAGES,
  SDP_RELEASE_CHANNELS,
  type SdpModule,
} from "@sdp/types";
import { describe, expect, it } from "vitest";
import { createApp } from "@/app";
import { declaredAuthorization } from "@/middleware/authorize";
import { declaredIdempotency } from "@/middleware/idempotency";
import { noopObservability } from "@/runtime/observability";
import { ownerOf } from "@/test/helpers/route-owners";

/**
 * The Idempotency-Key standard as a build gate (HOO-1918, ADR 0008).
 *
 * Every POST, PATCH, PUT and DELETE route of a module at `stable`:
 * - declares `idempotent()`, or is exempt below with a reason;
 * - runs `authorize(fn)` or `authorizeNone(reason)` before it, so a replay
 *   passes exactly the access checks a new request does; every
 *   `authorizeNone` is pinned below with its reason.
 *
 * The module comes from the route-ownership table and the stage from the
 * `stable` release channel, so promoting a module to `stable` fails this test
 * until its routes adopt both steps. The routes that require the key are the
 * shared `IDEMPOTENCY_REQUIRED_ROUTES`, which the dashboard also reads.
 */
const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const STABLE_MODULES: ReadonlySet<SdpModule> = new Set(SDP_RELEASE_CHANNELS.stable);

const CREDENTIALS =
  "dashboard-internal credential lifecycle: carries credential material, so it must never store a response; it keeps its own provider_credentials key (0034)";
const PREPARE =
  "returns an unsigned transaction bound to a fresh blockhash, which a stored replay would hand back after it expired; it moves nothing and only records addresses derived deterministically from the request";
const CONNECTION =
  "dashboard-internal custody connection lifecycle; not part of the public API contract yet";

const EXEMPT: Record<string, string> = {
  "POST /internal/dashboard/custody/provider-credentials": CREDENTIALS,
  "POST /internal/dashboard/custody/connections/:connectionId/provider-credentials": CREDENTIALS,
  "POST /internal/dashboard/custody/provider-credentials/:credentialId/rotate": CREDENTIALS,
  "POST /internal/dashboard/custody/provider-credentials/:credentialId/complete-rotation":
    CREDENTIALS,
  "POST /internal/dashboard/custody/provider-credentials/:credentialId/rollback": CREDENTIALS,
  "POST /internal/dashboard/custody/provider-credentials/:credentialId/deactivate": CREDENTIALS,
  "POST /internal/dashboard/custody/connections/:connectionId/cancel": CONNECTION,
  "POST /internal/dashboard/custody/connections/:connectionId/complete": CONNECTION,
  "POST /internal/dashboard/custody/connections/:connectionId/deactivate": CONNECTION,
  "POST /pay/:token/tx":
    "public and unauthenticated (no organization to scope a key to); the payment request token is the unit of retry",
  "POST /v1/payments/transfer-batches/estimate": "read-only estimate; moves and stores nothing",
  "POST /v1/payments/subscription-plans/:planId/prepare-create": PREPARE,
  "POST /v1/payments/subscriptions/:subscriptionId/prepare-authorization": PREPARE,
  "POST /v1/payments/subscriptions/:subscriptionId/prepare-cancel": PREPARE,
  "POST /v1/payments/subscriptions/:subscriptionId/prepare-collection": PREPARE,
  "POST /v1/payments/subscriptions/:subscriptionId/prepare-resume": PREPARE,
};

/**
 * Routes whose access check is `authorizeNone`: they name no resource beyond
 * the caller's own scope. Adding one is a reviewed decision; check the handler
 * first.
 */
const NAMES_NOTHING: Record<string, string> = {
  "POST /v1/compliance/address-screenings":
    "screens an on-chain address the caller supplies; it names no resource of any project",
  "POST /v1/counterparties":
    "creates a counterparty in the caller's own project; it names no existing resource",
};

interface RouteSteps {
  idempotency: ReturnType<typeof declaredIdempotency>;
  /** Positions in the route's chain. */
  idempotentAt: number;
  authorizeAt: number;
  authorization: ReturnType<typeof declaredAuthorization>;
}

function stableMutatingRoutes(): Map<string, RouteSteps> {
  const app = createApp({
    observability: noopObservability,
    rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
  });
  const routes = new Map<string, RouteSteps>();
  let position = 0;
  for (const route of app.routes) {
    position += 1;
    const method = route.method.toUpperCase();
    if (!MUTATING_METHODS.has(method)) continue;
    const owner = ownerOf(route.path);
    if (owner === undefined || owner === "core" || !STABLE_MODULES.has(owner)) continue;
    const key = `${method} ${route.path}`;
    const steps = routes.get(key) ?? {
      idempotency: undefined,
      idempotentAt: -1,
      authorizeAt: -1,
      authorization: undefined,
    };
    const idempotency = declaredIdempotency(route.handler);
    if (idempotency !== undefined) {
      steps.idempotency = idempotency;
      steps.idempotentAt = position;
    }
    const authorization = declaredAuthorization(route.handler);
    if (authorization !== undefined) {
      steps.authorization = authorization;
      steps.authorizeAt = position;
    }
    routes.set(key, steps);
  }
  return routes;
}

describe("idempotency route inventory", () => {
  const routes = stableMutatingRoutes();
  const idempotent = [...routes].filter(([, steps]) => steps.idempotency !== undefined);

  it("declares an Idempotency-Key mode on every stable mutating route", () => {
    const undeclared = [...routes]
      .filter(([route, steps]) => steps.idempotency === undefined && !(route in EXEMPT))
      .map(([route]) => route)
      .sort();
    expect(undeclared).toEqual([]);
  });

  it("requires the key on exactly the shared list of routes that move money", () => {
    const required = idempotent
      .filter(([, steps]) => steps.idempotency === "required")
      .map(([route]) => route)
      .sort();
    expect(required).toEqual([...IDEMPOTENCY_REQUIRED_ROUTES].sort());
  });

  it("runs an access check before the idempotency step on every idempotent route", () => {
    const unchecked = idempotent
      .filter(([, steps]) => steps.authorizeAt === -1 || steps.authorizeAt > steps.idempotentAt)
      .map(([route]) => route)
      .sort();
    expect(unchecked).toEqual([]);
  });

  it("pins every route that names no resource, with its reason", () => {
    const namesNothing = Object.fromEntries(
      idempotent.flatMap(([route, steps]) =>
        steps.authorization?.kind === "none" ? [[route, steps.authorization.reason]] : []
      )
    );
    expect(namesNothing).toEqual(NAMES_NOTHING);
  });

  it("keeps every exemption current", () => {
    const stale = Object.keys(EXEMPT).filter(
      (route) => !routes.has(route) || routes.get(route)?.idempotency !== undefined
    );
    expect(stale).toEqual([]);
  });
});
