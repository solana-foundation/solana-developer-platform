import * as Sentry from "@sentry/node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SentryOptions } from "./observability";
import { initNodeSentry, nodeObservability } from "./observability-node";

vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  withScope: vi.fn((cb: (scope: unknown) => void) => cb({ setTag: vi.fn(), setUser: vi.fn() })),
  withMonitor: vi.fn(async (_slug: string, fn: () => Promise<unknown>) => fn()),
}));

const baseOpts = (overrides: Partial<SentryOptions> = {}): SentryOptions => ({
  enabled: true,
  environment: "test",
  tracesSampleRate: 1,
  sendDefaultPii: false,
  ...overrides,
});

// IMPORTANT: keep this describe FIRST in the file. The init-guard tests below
// rely on `initNodeSentry` not having been called yet for this module — within
// a vitest file, module state is shared, and the `initNodeSentry` describe
// below flips the `_initialized` flag for the rest of the file.
describe("nodeObservability — guards before init", () => {
  it("captureException throws if called before initNodeSentry", () => {
    expect(() => nodeObservability.captureException(new Error("boom"))).toThrow(
      /before initNodeSentry/
    );
  });

  it("withScope throws if called before initNodeSentry", () => {
    expect(() => nodeObservability.withScope(() => {})).toThrow(/before initNodeSentry/);
  });

  it("withMonitor throws if called before initNodeSentry", () => {
    expect(() =>
      nodeObservability.withMonitor("slug", async () => "x", {
        schedule: { type: "crontab", value: "* * * * *" },
      })
    ).toThrow(/before initNodeSentry/);
  });
});

describe("initNodeSentry", () => {
  beforeEach(() => {
    vi.mocked(Sentry.init).mockClear();
  });

  it("calls Sentry.init with the provided options when enabled", () => {
    const opts = baseOpts({ dsn: "https://x", enabled: true });
    initNodeSentry(opts);
    expect(Sentry.init).toHaveBeenCalledWith(opts);
  });

  it("does not call Sentry.init when disabled (no DSN)", () => {
    initNodeSentry(baseOpts({ enabled: false }));
    expect(Sentry.init).not.toHaveBeenCalled();
  });
});

describe("nodeObservability — after init", () => {
  it("captureException delegates to Sentry.captureException", () => {
    const err = new Error("boom");
    nodeObservability.captureException(err);
    expect(Sentry.captureException).toHaveBeenCalledWith(err);
  });

  it("withScope passes a scope to the callback", () => {
    const cb = vi.fn();
    nodeObservability.withScope(cb);
    expect(Sentry.withScope).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledTimes(1);
    const scope = cb.mock.calls[0][0];
    expect(typeof scope.setTag).toBe("function");
    expect(typeof scope.setUser).toBe("function");
  });

  it("withMonitor forwards slug, fn, and opts to Sentry and resolves with the fn's value", async () => {
    const fn = vi.fn(async () => "result");
    const opts = { schedule: { type: "crontab" as const, value: "* * * * *" } };

    const result = await nodeObservability.withMonitor("my-slug", fn, opts);

    expect(Sentry.withMonitor).toHaveBeenCalledWith("my-slug", fn, opts);
    expect(result).toBe("result");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
