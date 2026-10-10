import { SDP_RAMP_PROVIDER_STAGES } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { createApp } from "@/app";
import { declaredIdempotency } from "@/middleware/idempotency";
import { noopObservability } from "@/runtime/observability";

/**
 * The Idempotency-Key step stores response bodies for 24 hours (HOO-1918,
 * ADR 0008), so a route whose response carries a secret must never use it:
 * API key creation and rotation return the plaintext key, and provider
 * credential routes take or return credential material.
 */
const SECRET_ROUTES: readonly RegExp[] = [
  /^\/v1\/api-keys(\/|$)/,
  /^\/v1\/projects\/[^/]+\/api-keys(\/|$)/,
  /^\/internal\/dashboard\/custody\/(connections\/[^/]+\/)?provider-credentials(\/|$)/,
];

describe("idempotency route exclusions", () => {
  it("keeps the Idempotency-Key step off every route that returns a secret", () => {
    const app = createApp({
      observability: noopObservability,
      rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
    });
    const secretRoutes = app.routes.filter((route) =>
      SECRET_ROUTES.some((pattern) => pattern.test(route.path))
    );

    expect(secretRoutes.length).toBeGreaterThan(0);
    expect(
      secretRoutes
        .filter((route) => declaredIdempotency(route.handler) !== undefined)
        .map((route) => `${route.method} ${route.path}`)
    ).toEqual([]);
  });
});
