import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ getDb: () => ({}) }));
vi.mock("@/services/provider-availability.service", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadProjectProviderVerdict: vi.fn(),
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

import { estimateNotAvailable } from "@sdp/payments";
import {
  COMPLIANCE_PROVIDERS,
  CUSTODY_PROVIDERS,
  EARN_PROVIDERS,
  type OrganizationProviderAvailabilityResponse,
  type PaymentRampEstimate,
  type ProviderAvailabilityEntry,
  RAMP_PROVIDERS,
  STAGED_PROVIDER_REFUSAL_REASONS,
} from "@sdp/types";
import { AppError, forbidden } from "@/lib/errors";
import { logEvent } from "@/runtime/money-path-events";
import type { Observability } from "@/runtime/observability";
import {
  loadProjectProviderVerdict,
  type ProjectProviderRefusal,
} from "@/services/provider-availability.service";
import type { AppContext } from "../context";
import { estimateAcrossProviders } from "./shared";

function buildContext(options?: { sentryDsn?: string; observability?: Observability }) {
  const vars = new Map<string, unknown>([["observability", options?.observability]]);
  return {
    env: options?.sentryDsn ? { SENTRY_DSN: options.sentryDsn } : {},
    get: (key: string) => vars.get(key),
  } as unknown as AppContext;
}

function unavailableEntries<Provider extends string>(
  providers: readonly Provider[]
): Record<Provider, ProviderAvailabilityEntry> {
  return Object.fromEntries(
    providers.map((provider) => [provider, { entitled: false, configured: false, enabled: false }])
  ) as Record<Provider, ProviderAvailabilityEntry>;
}

const FANOUT_AVAILABILITY: OrganizationProviderAvailabilityResponse = {
  tier: "individual",
  providers: {
    custody: unavailableEntries(CUSTODY_PROVIDERS),
    compliance: unavailableEntries(COMPLIANCE_PROVIDERS),
    ramps: unavailableEntries(RAMP_PROVIDERS),
    earn: unavailableEntries(EARN_PROVIDERS),
  },
};

const MOONPAY_NOT_CONFIGURED: ProjectProviderRefusal = {
  admitted: false,
  scope: { organizationId: "org_fanout_test", projectId: "prj_fanout_test" },
  environment: "sandbox",
  request: { family: "ramps", provider: "moonpay" },
  reason: "provider_not_configured",
  error: new AppError(
    "PROVIDER_NOT_CONFIGURED",
    "MoonPay is not configured for sandbox projects in this deployment.",
    { reason: "provider_not_configured" }
  ),
};

describe("estimateAcrossProviders", () => {
  beforeEach(() => {
    vi.mocked(loadProjectProviderVerdict).mockResolvedValue({
      decide: () => ({ admitted: true }),
      availability: FANOUT_AVAILABILITY,
    });
  });

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

  it("keeps a provider the deployment cannot run on the error log, without calling it", async () => {
    vi.mocked(loadProjectProviderVerdict).mockResolvedValue({
      decide: () => MOONPAY_NOT_CONFIGURED,
      availability: FANOUT_AVAILABILITY,
    });
    const runProvider = vi.fn();

    const results = await estimateAcrossProviders(buildContext(), ["moonpay"], runProvider);

    expect(results).toEqual([
      {
        provider: "moonpay",
        status: "error",
        error: "MoonPay is not configured for sandbox projects in this deployment.",
      },
    ]);
    expect(runProvider).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledExactlyOnceWith(
      "error",
      expect.objectContaining({
        event: "sdp_api_ramp_provider_error",
        provider: "moonpay",
        organization_id: "org_fanout_test",
        error_code: "PROVIDER_NOT_CONFIGURED",
      })
    );
  });

  it.each(STAGED_PROVIDER_REFUSAL_REASONS)(
    "answers a %s refusal with its reason, logged at info, without calling the provider",
    async (reason) => {
      const refusal: ProjectProviderRefusal = {
        ...MOONPAY_NOT_CONFIGURED,
        reason,
        error: forbidden("MoonPay is refused for this project.", { reason }),
      };
      vi.mocked(loadProjectProviderVerdict).mockResolvedValue({
        decide: () => refusal,
        availability: FANOUT_AVAILABILITY,
      });
      const runProvider = vi.fn();

      const results = await estimateAcrossProviders(buildContext(), ["moonpay"], runProvider);

      expect(results).toEqual([
        {
          provider: "moonpay",
          status: "error",
          error: "MoonPay is refused for this project.",
          reason,
        },
      ]);
      expect(runProvider).not.toHaveBeenCalled();
      expect(logEvent).toHaveBeenCalledExactlyOnceWith("info", {
        event: "sdp_api_ramp_provider_refused",
        provider: "moonpay",
        organization_id: "org_fanout_test",
        reason,
      });
    }
  );

  it("answers an entitlement refusal beside an admitted provider from one verdict load, logging only the refusal at info", async () => {
    const refusal: ProjectProviderRefusal = {
      ...MOONPAY_NOT_CONFIGURED,
      reason: "provider_not_entitled",
      error: forbidden("MoonPay requires manual activation for this organization.", {
        reason: "provider_not_entitled",
      }),
    };
    vi.mocked(loadProjectProviderVerdict).mockResolvedValue({
      decide: (request) => (request.provider === "moonpay" ? refusal : { admitted: true }),
      availability: FANOUT_AVAILABILITY,
    });
    const runProvider = vi.fn().mockRejectedValue(estimateNotAvailable());

    const results = await estimateAcrossProviders(
      buildContext(),
      ["moonpay", "stripe"],
      runProvider
    );

    expect(results).toEqual([
      {
        provider: "moonpay",
        status: "error",
        error: "MoonPay requires manual activation for this organization.",
        reason: "provider_not_entitled",
      },
      { provider: "stripe", status: "unsupported" },
    ]);
    expect(loadProjectProviderVerdict).toHaveBeenCalledTimes(1);
    expect(runProvider).toHaveBeenCalledExactlyOnceWith("stripe", {});
    expect(logEvent).toHaveBeenCalledExactlyOnceWith("info", {
      event: "sdp_api_ramp_provider_refused",
      provider: "moonpay",
      organization_id: "org_fanout_test",
      reason: "provider_not_entitled",
    });
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
