import { describe, expect, it } from "vitest";
import type { Observability } from "./observability";
import { cloudflareObservability, withSentry } from "./observability-cf";

// Suite-level note: under vitest's `isolate: false` config the Workers
// module cache is shared across test files, so module-level vi.mock of
// @sentry/cloudflare leaks into every other suite that transitively
// imports it via src/index.ts (default export becomes undefined). The
// delegations here are one-line passthroughs; verifying their shape is
// enough — end-to-end Sentry behaviour is checked manually against the
// CF managed deploy.

describe("cloudflareObservability", () => {
  it("conforms to the Observability interface", () => {
    const obs: Observability = cloudflareObservability;
    expect(typeof obs.captureException).toBe("function");
    expect(typeof obs.withScope).toBe("function");
    expect(typeof obs.withMonitor).toBe("function");
  });
});

describe("withSentry", () => {
  it("is exported as a function", () => {
    expect(typeof withSentry).toBe("function");
  });
});
