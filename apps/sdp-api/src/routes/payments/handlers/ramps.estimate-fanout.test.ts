import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ getDb: () => ({}) }));
vi.mock("@/services/provider-availability.service", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertProviderAvailable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/runtime/money-path-events", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  logEvent: vi.fn(),
}));
vi.mock("../context", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  rampRuntime: () => ({}),
  resolveSdpEnvironment: () => "sandbox",
}));
vi.mock("../wallets", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveScope: vi.fn().mockResolvedValue({ auth: { organizationId: "org_fanout_test" } }),
}));

import type { PaymentRampEstimate } from "@sdp/types";
import { logEvent } from "@/runtime/money-path-events";
import type { Observability } from "@/runtime/observability";
import type { AppContext } from "../context";
import { estimateAcrossProviders } from "./ramps";

function buildContext(options?: { sentryDsn?: string; observability?: Observability }) {
  const vars = new Map<string, unknown>([["observability", options?.observability]]);
  return {
    env: options?.sentryDsn ? { SENTRY_DSN: options.sentryDsn } : {},
    get: (key: string) => vars.get(key),
  } as unknown as AppContext;
}

describe("estimateAcrossProviders", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps the per-provider error contract but emits a structured log event", async () => {
    const results = await estimateAcrossProviders(buildContext(), ["moonpay"], async () => {
      throw new Error("provider exploded");
    });

    expect(results).toEqual([{ provider: "moonpay", status: "error", error: "provider exploded" }]);
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({
        event: "sdp_api_ramp_provider_error",
        provider: "moonpay",
        organization_id: "org_fanout_test",
        error_name: "Error",
        error_message: "provider exploded",
      })
    );
  });

  it("does not log when a provider succeeds or is merely unsupported", async () => {
    const estimate = { provider: "moonpay" } as unknown as PaymentRampEstimate;
    const results = await estimateAcrossProviders(
      buildContext(),
      ["moonpay"],
      async () => estimate
    );

    expect(results).toEqual([{ provider: "moonpay", status: "ok", estimate }]);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("captures through the injected observability when Sentry is enabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const captureException = vi.fn();
    const observability: Observability = {
      captureException,
      withScope: (cb) => cb({ setTag: vi.fn(), setUser: vi.fn() }),
      withMonitor: (_slug, fn) => fn(),
    };

    const results = await estimateAcrossProviders(
      buildContext({ sentryDsn: "https://sentry.example/1", observability }),
      ["moonpay"],
      async () => {
        throw new Error("provider exploded");
      }
    );

    expect(results).toEqual([{ provider: "moonpay", status: "error", error: "provider exploded" }]);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("keeps the error contract when the observability capture itself throws", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const observability: Observability = {
      captureException: vi.fn(),
      withScope: () => {
        throw new Error("sentry not initialized");
      },
      withMonitor: (_slug, fn) => fn(),
    };

    const results = await estimateAcrossProviders(
      buildContext({ sentryDsn: "https://sentry.example/1", observability }),
      ["moonpay"],
      async () => {
        throw new Error("provider exploded");
      }
    );

    expect(results).toEqual([{ provider: "moonpay", status: "error", error: "provider exploded" }]);
  });
});
