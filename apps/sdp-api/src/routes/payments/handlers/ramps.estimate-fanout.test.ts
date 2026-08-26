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
import type { AppContext } from "../context";
import { estimateAcrossProviders } from "./ramps";

const c = { env: {} } as unknown as AppContext;

describe("estimateAcrossProviders", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the per-provider error contract but emits a structured log event", async () => {
    const results = await estimateAcrossProviders(c, ["moonpay"], async () => {
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
    const results = await estimateAcrossProviders(c, ["moonpay"], async () => estimate);

    expect(results).toEqual([{ provider: "moonpay", status: "ok", estimate }]);
    expect(logEvent).not.toHaveBeenCalled();
  });
});
