import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type SdpPlugin } from "@/app";
import type { MonitorOptions, Observability, ObservabilityScope } from "@/runtime/observability";
import { FeePaymentError } from "@/services/ports";
import { env as baseEnv } from "@/test/helpers/env";
import type { Env } from "@/types/env";

const THROW_PATH = "/__internal_error_test_throw";
const FEE_ERROR_PATH = "/__fee_error_test_throw";

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
  app.all(FEE_ERROR_PATH, () => {
    throw new FeePaymentError(
      "Failed to sign and send transaction: RPC Error -32000: Invalid transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1",
      "SIGNING_FAILED"
    );
  });
  return app;
}

describe("createApp plugin registration", () => {
  it("registers plugin routes under /v1", async () => {
    const { obs } = makeObservability();
    const plugin: SdpPlugin = {
      name: "test-plugin",
      register(v1) {
        v1.get("/test-plugin", (c) => c.json({ ok: true }));
      },
    };
    const app = createApp({ observability: obs, plugins: [plugin] });

    const res = await app.request("/v1/test-plugin", {}, baseEnv);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("returns 404 for an unregistered route when no plugins are passed", async () => {
    const { obs } = makeObservability();
    const app = createApp({ observability: obs });

    const res = await app.request("/v1/test-plugin", {}, baseEnv);

    expect(res.status).toBe(404);
  });

  it("throws when two plugins share the same name", () => {
    const { obs } = makeObservability();
    const make = (name: string): SdpPlugin => ({ name, register: () => {} });

    expect(() => createApp({ observability: obs, plugins: [make("dup"), make("dup")] })).toThrow(
      /dup/
    );
  });
});

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

  it("maps fee payment program errors to product-safe messages", async () => {
    const { obs, captureException, withScope } = makeObservability();
    const app = buildApp(obs);

    const res = await app.request(FEE_ERROR_PATH, {}, baseEnv);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("TRANSACTION_FAILED");
    expect(body.error.message).toBe(
      "The wallet used for this payment does not have enough funds. Add funds and try again."
    );
    expect(body.error.message).not.toContain("custom program error");
    expect(withScope).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });
});
