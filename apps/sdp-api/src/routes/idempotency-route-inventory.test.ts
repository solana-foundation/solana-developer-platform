import { IDEMPOTENCY_REQUIRED_ROUTES } from "@sdp/types/idempotency-required-routes";
import { describe, expect, it } from "vitest";
import { declaredAuthorization } from "@/middleware/authorize";
import { declaredIdempotency, declaredIdempotencyRecovery } from "@/middleware/idempotency";
import { declaresRecordReplay } from "@/middleware/movement-steps";
import { declaredValidation } from "@/middleware/validate";
import { stableMutatingRouteSteps } from "@/test/helpers/route-owners";

/**
 * The Idempotency-Key standard as a build gate (HOO-1918, ADR 0009).
 *
 * Every POST, PATCH, PUT and DELETE route of a module at `stable`:
 * - declares `idempotent()`, or is exempt below with a reason;
 * - runs `authorize(fn)` or `authorizeNone(reason)` before it, so a replay
 *   passes exactly the access checks a new request does; every
 *   `authorizeNone` is pinned below with its reason;
 * - validates its params, query and body before `authorize`, which reads them
 *   as validated, so an invalid request claims nothing;
 * - declares `recovery: "record"` exactly when it mounts `replayFromRecord`,
 *   so a lapsed claim is taken over only where the domain row answers it;
 * - runs under project context, because every key is scoped to a project
 *   (`idempotency_keys.project_id` is NOT NULL; the step 500s without one).
 *
 * The module comes from the route-ownership table and the stage from the
 * `stable` release channel, so promoting a module to `stable` fails this test
 * until its routes adopt both steps. The routes that require the key are the
 * shared `IDEMPOTENCY_REQUIRED_ROUTES`, which the dashboard also reads.
 */
const CREDENTIALS =
  "dashboard-internal credential lifecycle: carries credential material, so it must never store a response; it keeps its own provider_credentials key (0034)";
const PREPARE =
  "returns an unsigned transaction bound to a fresh blockhash, which a stored replay would hand back after it expired; it moves nothing and only records addresses derived deterministically from the request";
const CONNECTION =
  "dashboard-internal custody connection lifecycle; not part of the public API contract yet";

const EXEMPT = {
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
  "POST /internal/dashboard/wallets/:walletId/faucet":
    "dashboard-internal devnet faucet: airdrops free devnet SOL and stores nothing, so each press is a new airdrop",
  "POST /pay/:token/tx":
    "public and unauthenticated (no organization to scope a key to); the payment request token is the unit of retry",
  "POST /v1/payments/transfer-batches/estimate": "read-only estimate; moves and stores nothing",
  "POST /v1/payments/subscription-plans/:planId/prepare-create": PREPARE,
  "POST /v1/payments/subscriptions/:subscriptionId/prepare-authorization": PREPARE,
  "POST /v1/payments/subscriptions/:subscriptionId/prepare-cancel": PREPARE,
  "POST /v1/payments/subscriptions/:subscriptionId/prepare-collection": PREPARE,
  "POST /v1/payments/subscriptions/:subscriptionId/prepare-resume": PREPARE,
} as const satisfies Record<string, string>;

/**
 * Routes whose access check is `authorizeNone`: they name no resource beyond
 * the caller's own scope. Adding one is a reviewed decision; check the handler
 * first.
 */
const NAMES_NOTHING = {
  "POST /v1/counterparties":
    "creates a counterparty in the caller's own project; it names no existing resource",
  "POST /v1/wallets/initialize": "connects a provider in the caller's own project",
} as const satisfies Record<string, string>;

interface RouteSteps {
  idempotency: ReturnType<typeof declaredIdempotency>;
  /** Positions in the route's chain. */
  idempotentAt: number;
  authorizeAt: number;
  authorization: ReturnType<typeof declaredAuthorization>;
  /** Positions of the route-level validators. */
  validateAt: number[];
  recovery: ReturnType<typeof declaredIdempotencyRecovery>;
  replaysFromRecord: boolean;
  /** Position of the `projectContext` step that covers the route, -1 if none. */
  projectContextAt: number;
}

function stableMutatingRoutes(): Map<string, RouteSteps> {
  const routes = new Map<string, RouteSteps>();
  for (const { route, position, handler } of stableMutatingRouteSteps()) {
    const steps = routes.get(route) ?? {
      idempotency: undefined,
      idempotentAt: -1,
      authorizeAt: -1,
      authorization: undefined,
      validateAt: [],
      recovery: undefined,
      replaysFromRecord: false,
      projectContextAt: -1,
    };
    const idempotency = declaredIdempotency(handler);
    if (idempotency !== undefined) {
      steps.idempotency = idempotency;
      steps.idempotentAt = position;
      steps.recovery = declaredIdempotencyRecovery(handler);
    }
    if (declaresRecordReplay(handler)) {
      steps.replaysFromRecord = true;
    }
    if (handler.name === "projectContext") {
      steps.projectContextAt = position;
    }
    const authorization = declaredAuthorization(handler);
    if (authorization !== undefined) {
      steps.authorization = authorization;
      steps.authorizeAt = position;
    }
    if (declaredValidation(handler) !== undefined) {
      steps.validateAt.push(position);
    }
    routes.set(route, steps);
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

  it("validates the request before the access check on every idempotent route", () => {
    const lateValidation = idempotent
      .filter(([, steps]) => steps.validateAt.some((at) => at > steps.authorizeAt))
      .map(([route]) => route)
      .sort();
    expect(lateValidation).toEqual([]);
  });

  it("declares recovery from the record exactly on the routes that replay from it", () => {
    const mismatched = [...routes]
      .filter(([, steps]) => steps.replaysFromRecord !== (steps.recovery === "record"))
      .map(([route]) => route)
      .sort();
    expect(mismatched).toEqual([]);
    expect(idempotent.filter(([, steps]) => steps.replaysFromRecord).length).toBeGreaterThan(0);
  });

  it("runs project context before the idempotency step on every idempotent route", () => {
    const unscoped = idempotent
      .filter(
        ([, steps]) => steps.projectContextAt === -1 || steps.projectContextAt > steps.idempotentAt
      )
      .map(([route]) => route)
      .sort();
    expect(unscoped).toEqual([]);
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
