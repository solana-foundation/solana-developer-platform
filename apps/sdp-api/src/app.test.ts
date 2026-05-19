import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@/app";
import type { MonitorOptions, Observability, ObservabilityScope } from "@/runtime/observability";
import { env as baseEnv } from "@/test/helpers/env";
import type { Env } from "@/types/env";

const THROW_PATH = "/__internal_error_test_throw";

function makeObservability(): {
  obs: Observability;
  captureException: ReturnType<typeof vi.fn>;
  withScope: ReturnType<typeof vi.fn>;
} {
  const captureException = vi.fn();
  const withScope = vi.fn((cb: (scope: ObservabilityScope) => void) => {
    cb({ setTag: () => {}, setUser: () => {} });
  });
  // Plain async function rather than vi.fn so the generic survives type
  // inference; these tests exercise the onError path, not scheduled, so we
  // don't need to spy on withMonitor calls.
  const withMonitor = async <T>(
    _slug: string,
    fn: () => Promise<T>,
    _opts: MonitorOptions
  ): Promise<T> => fn();
  return {
    obs: { captureException, withScope, withMonitor },
    captureException,
    withScope,
  };
}

function buildApp(observability: Observability) {
  const app = createApp({ observability });
  // Mount a route that throws after createApp returns, so we exercise the
  // onError path without modifying the production createApp surface.
  app.all(THROW_PATH, () => {
    throw new Error("test trigger for onError");
  });
  return app;
}

describe("createApp onError SENTRY_DSN guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls observability.captureException when SENTRY_DSN is set", async () => {
    const { obs, captureException, withScope } = makeObservability();
    const app = buildApp(obs);
    const env: Env = { ...baseEnv, SENTRY_DSN: "https://test@sentry.example/1" };

    const res = await app.request(THROW_PATH, {}, env);

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(withScope).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("does not invoke observability when SENTRY_DSN is unset", async () => {
    const { obs, captureException, withScope } = makeObservability();
    const app = buildApp(obs);
    const env: Env = { ...baseEnv, SENTRY_DSN: undefined };

    const res = await app.request(THROW_PATH, {}, env);

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(withScope).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });
});
