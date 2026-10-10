import { SDP_RAMP_PROVIDER_STAGES, SDP_RELEASE_CHANNELS, type SdpModule } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { createApp } from "@/app";
import { declaredIdempotency } from "@/middleware/idempotency";
import { noopObservability } from "@/runtime/observability";
import { ownerOf } from "@/test/helpers/route-owners";

/**
 * The Idempotency-Key standard as a build gate (HOO-1918, ADR 0008).
 *
 * Every POST, PATCH and PUT route of a module at `stable` declares
 * `idempotent()`, or is exempt below with a reason. The module comes from the
 * route-ownership table and the stage from the `stable` release channel, so promoting a
 * module to `stable` fails this test until its routes adopt the step.
 *
 * Routes that move money require the key; that list is pinned, so changing a
 * route's mode is a reviewed change.
 */
const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PATCH", "PUT"]);
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

const REQUIRED = [
  "POST /v1/payments/transfers",
  "POST /v1/payments/transfer-batches",
  "POST /v1/payments/recurring-payments",
  "POST /v1/payments/recurring-payments/:id/activate",
  "POST /v1/payments/recurring-payments/:id/cancel",
  "POST /v1/payments/recurring-payments/:id/collect",
  "POST /v1/payments/recurring-payments/:id/resume",
  "POST /v1/wallets/approval-requests/:approvalRequestId/approve",
];

function stableMutatingRoutes() {
  const app = createApp({
    observability: noopObservability,
    rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
  });
  const modes = new Map<string, ReturnType<typeof declaredIdempotency>>();
  for (const route of app.routes) {
    const method = route.method.toUpperCase();
    if (!MUTATING_METHODS.has(method)) continue;
    const owner = ownerOf(route.path);
    if (owner === undefined || owner === "core" || !STABLE_MODULES.has(owner)) continue;
    const key = `${method} ${route.path}`;
    const declared = declaredIdempotency(route.handler);
    if (!modes.has(key) || declared !== undefined) modes.set(key, declared ?? modes.get(key));
  }
  return modes;
}

describe("idempotency route inventory", () => {
  const modes = stableMutatingRoutes();

  it("declares an Idempotency-Key mode on every stable mutating route", () => {
    const undeclared = [...modes]
      .filter(([route, mode]) => mode === undefined && !(route in EXEMPT))
      .map(([route]) => route)
      .sort();
    expect(undeclared).toEqual([]);
  });

  it("requires the key on exactly the routes that move money", () => {
    const required = [...modes]
      .filter(([, mode]) => mode === "required")
      .map(([route]) => route)
      .sort();
    expect(required).toEqual([...REQUIRED].sort());
  });

  it("keeps every exemption current", () => {
    const stale = Object.keys(EXEMPT).filter(
      (route) => !modes.has(route) || modes.get(route) !== undefined
    );
    expect(stale).toEqual([]);
  });
});
