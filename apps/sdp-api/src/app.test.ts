import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type SdpPlugin } from "@/app";
import { AppError } from "@/lib/errors";
import type { MonitorOptions, Observability, ObservabilityScope } from "@/runtime/observability";
import { FeePaymentError, SigningError } from "@/services/ports";
import { env as baseEnv } from "@/test/helpers/env";
import type { Env } from "@/types/env";

const THROW_PATH = "/__internal_error_test_throw";
const SECRET_APP_ERROR_PATH = "/__secret_app_error_test_throw";
const SECRET_SIGNING_ERROR_PATH = "/__secret_signing_error_test_throw";
const SECRET_UNEXPECTED_ERROR_PATH = "/__secret_unexpected_error_test_throw";
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
  app.all(SECRET_APP_ERROR_PATH, () => {
    throw new AppError("BAD_REQUEST", "Invalid appSecret=privy-secret", {
      appSecret: "privy-secret",
      tokenId: "tok_public",
    });
  });
  app.all(SECRET_SIGNING_ERROR_PATH, () => {
    throw new SigningError(
      'Privy API error: 401 - {"appSecret":"privy-secret"}',
      "PROVIDER_NOT_CONFIGURED"
    );
  });
  app.all(SECRET_UNEXPECTED_ERROR_PATH, () => {
    throw Object.assign(new Error("privateKey=raw-private-key"), {
      context: { authorization: "Bearer raw-token" },
      cause: { password: "pw" },
    });
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

  it("redacts app error messages and details", async () => {
    const { obs } = makeObservability();
    const app = buildApp(obs);

    const res = await app.request(SECRET_APP_ERROR_PATH, {}, baseEnv);

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; details: Record<string, unknown> };
    };
    expect(JSON.stringify(body)).not.toContain("privy-secret");
    expect(body.error.message).toBe("Invalid appSecret=[REDACTED]");
    expect(body.error.details).toEqual({
      appSecret: "[REDACTED]",
      tokenId: "tok_public",
    });
  });

  it("uses safe signing provider messages", async () => {
    const { obs } = makeObservability();
    const app = buildApp(obs);

    const res = await app.request(SECRET_SIGNING_ERROR_PATH, {}, baseEnv);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe(
      "The signing provider is not configured. Check provider configuration and try again."
    );
    expect(JSON.stringify(body)).not.toContain("privy-secret");
  });

  it("redacts unexpected error log context", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { obs, captureException } = makeObservability();
    const app = buildApp(obs);

    await app.request(
      SECRET_UNEXPECTED_ERROR_PATH,
      {},
      { ...baseEnv, SENTRY_DSN: "https://x@y/1" }
    );

    const logged = JSON.stringify(consoleError.mock.calls);
    const captured = JSON.stringify(captureException.mock.calls);
    expect(logged).not.toContain("raw-private-key");
    expect(logged).not.toContain("raw-token");
    expect(logged).not.toContain("pw");
    expect(captured).not.toContain("raw-private-key");
    expect(captured).not.toContain("raw-token");
    expect(captured).not.toContain("pw");
    expect(logged).toContain("[REDACTED]");
    expect(captured).toContain("[REDACTED]");
    consoleError.mockRestore();
  });
});
