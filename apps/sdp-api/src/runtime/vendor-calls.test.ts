import { beforeEach, describe, expect, it, vi } from "vitest";
import * as events from "./money-path-events";
import { instrumentVendorPort, withVendorCall } from "./vendor-calls";

const logEvent = vi.spyOn(events, "logEvent").mockImplementation(() => {});

beforeEach(() => {
  logEvent.mockClear();
});

function vendorEvents() {
  return logEvent.mock.calls.filter(([, payload]) => payload.event === "sdp_api_vendor_call");
}

function failureEvents() {
  return vendorEvents().filter(([, payload]) => payload.outcome === "failed");
}

describe("logVendorCallFailure", () => {
  it("logs the error's name and code only, never a provider body or its details", async () => {
    // EARN-025: a provider error routinely echoes the request, the owner and
    // whatever the provider felt like saying. The failure event is the one log
    // line every vendor call shares, so it carries facts about the FAILURE, not
    // the payload that failed.
    const failure = Object.assign(new Error("kamino request failed with status 400"), {
      name: "SdpEarnError",
      code: "BAD_REQUEST",
      details: {
        provider: "kamino",
        providerStatus: 400,
        providerBody: '{"owner":"7Yq3nRbFkMd2pXcLwT9vZs4HaJ1uE6gQoB8iVtNrK5mD","reason":"nope"}',
        ownerAddress: "7Yq3nRbFkMd2pXcLwT9vZs4HaJ1uE6gQoB8iVtNrK5mD",
      },
    });

    await expect(
      withVendorCall("kamino", "quoteVaultDeposit", () => Promise.reject(failure))
    ).rejects.toBe(failure);

    const emitted = failureEvents();
    expect(emitted).toHaveLength(1);
    const payload = emitted[0][1];
    expect(payload).toMatchObject({
      vendor: "kamino",
      operation: "quoteVaultDeposit",
      outcome: "failed",
      error_name: "SdpEarnError",
      error_code: "BAD_REQUEST",
    });
    expect(Object.keys(payload).sort()).toEqual([
      "boundary",
      "duration_ms",
      "error_code",
      "error_name",
      "event",
      "operation",
      "outcome",
      "vendor",
    ]);
    expect(JSON.stringify(payload)).not.toContain("7Yq3nRbFkMd2pXcLwT9vZs4HaJ1uE6gQoB8iVtNrK5mD");
    expect(JSON.stringify(payload)).not.toContain("nope");
  });
});

describe("instrumentVendorPort", () => {
  it("returns sync results unchanged and emits success telemetry", () => {
    const port = instrumentVendorPort("kora", { double: (n: number) => n * 2 });
    expect(port.double(21)).toBe(42);
    expect(failureEvents()).toHaveLength(0);
    expect(vendorEvents()[0]?.[1]).toMatchObject({
      vendor: "kora",
      operation: "double",
      outcome: "succeeded",
      boundary: "adapter_operation",
    });
  });

  it("resolves async results unchanged and emits success telemetry", async () => {
    const port = instrumentVendorPort("kora", { fetch: async () => "ok" });
    await expect(port.fetch()).resolves.toBe("ok");
    expect(failureEvents()).toHaveLength(0);
    expect(vendorEvents()).toHaveLength(1);
    expect(vendorEvents()[0]?.[1]).toMatchObject({
      vendor: "kora",
      operation: "fetch",
      outcome: "succeeded",
      boundary: "adapter_operation",
    });
  });

  it("rethrows sync errors unchanged and emits one failed event", () => {
    const boom = new Error("sync boom");
    const port = instrumentVendorPort("kora", {
      explode: () => {
        throw boom;
      },
    });
    expect(() => port.explode()).toThrow(boom);
    const emitted = failureEvents();
    expect(emitted).toHaveLength(1);
    expect(emitted[0][1]).toMatchObject({
      vendor: "kora",
      operation: "explode",
      outcome: "failed",
    });
    expect(emitted[0][1].duration_ms).toBeTypeOf("number");
  });

  it("rethrows rejections unchanged and emits exactly one failed event", async () => {
    const boom = new Error("async boom");
    const port = instrumentVendorPort("moonpay", { send: async () => Promise.reject(boom) });
    await expect(port.send()).rejects.toBe(boom);
    const emitted = failureEvents();
    expect(emitted).toHaveLength(1);
    expect(emitted[0][1]).toMatchObject({
      vendor: "moonpay",
      operation: "send",
      outcome: "failed",
    });
    expect(emitted[0][1].duration_ms).toBeTypeOf("number");
  });

  it("passes non-function properties through untouched", () => {
    const port = instrumentVendorPort("kora", { limit: 7, name: "adapter" });
    expect(port.limit).toBe(7);
    expect(port.name).toBe("adapter");
    expect(failureEvents()).toHaveLength(0);
  });

  it("preserves this binding for methods reading instance state", () => {
    class Adapter {
      base = 40;
      add(n: number) {
        return this.base + n;
      }
    }
    const port = instrumentVendorPort("kora", new Adapter());
    expect(port.add(2)).toBe(42);
  });

  it("does not block an adapter when telemetry source lookup fails", () => {
    const port = instrumentVendorPort("kora", { getFeePayer: () => "address" }, () => {
      throw new Error("telemetry unavailable");
    });

    expect(port.getFeePayer()).toBe("address");
    expect(vendorEvents()[0]?.[1]).toMatchObject({
      boundary: "adapter_operation",
      outcome: "succeeded",
    });
  });
});

describe("withVendorCall", () => {
  it("emits a timed success without logging the vendor response", async () => {
    const result = await withVendorCall("tokens-xyz", "market-snapshots", async () => ({
      secret: "x",
    }));
    expect(result).toEqual({ secret: "x" });
    expect(vendorEvents()).toHaveLength(1);
    expect(vendorEvents()[0]?.[1]).toMatchObject({
      vendor: "tokens-xyz",
      operation: "market-snapshots",
      outcome: "succeeded",
      boundary: "call_site",
    });
    expect(JSON.stringify(vendorEvents()[0]?.[1])).not.toContain("secret");
  });
});
