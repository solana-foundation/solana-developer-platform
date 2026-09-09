import { beforeEach, describe, expect, it, vi } from "vitest";
import * as events from "./money-path-events";
import { instrumentVendorPort, signFailedResult, withVendorCall } from "./vendor-calls";

const logEvent = vi.spyOn(events, "logEvent").mockImplementation(() => {});

beforeEach(() => {
  logEvent.mockClear();
});

function failureEvents() {
  return logEvent.mock.calls.filter(([, payload]) => payload.event === "sdp_api_vendor_call");
}

describe("instrumentVendorPort", () => {
  it("returns sync results unchanged and emits nothing", () => {
    const port = instrumentVendorPort("kora", { double: (n: number) => n * 2 });
    expect(port.double(21)).toBe(42);
    expect(failureEvents()).toHaveLength(0);
  });

  it("resolves async results unchanged and emits nothing", async () => {
    const port = instrumentVendorPort("kora", { fetch: async () => "ok" });
    await expect(port.fetch()).resolves.toBe("ok");
    expect(failureEvents()).toHaveLength(0);
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
    const port = instrumentVendorPort("bvnk", { send: async () => Promise.reject(boom) });
    await expect(port.send()).rejects.toBe(boom);
    const emitted = failureEvents();
    expect(emitted).toHaveLength(1);
    expect(emitted[0][1]).toMatchObject({
      vendor: "bvnk",
      operation: "send",
      outcome: "failed",
    });
    expect(emitted[0][1].duration_ms).toBeTypeOf("number");
  });

  it("emits through the isFailureResult hook on soft failures and passes the result through", async () => {
    const port = instrumentVendorPort(
      "kora",
      { sign: async () => ({ status: "failed", error: "nope" }) },
      signFailedResult
    );
    await expect(port.sign()).resolves.toEqual({ status: "failed", error: "nope" });
    const emitted = failureEvents();
    expect(emitted).toHaveLength(1);
    expect(emitted[0][1]).toMatchObject({ vendor: "kora", operation: "sign", outcome: "failed" });
  });

  it("stays silent when the hook accepts the result", async () => {
    const port = instrumentVendorPort(
      "kora",
      { sign: async () => ({ status: "confirmed" }) },
      signFailedResult
    );
    await expect(port.sign()).resolves.toEqual({ status: "confirmed" });
    expect(failureEvents()).toHaveLength(0);
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
});

describe("signFailedResult", () => {
  it("reports the error for sign results with status failed", () => {
    expect(signFailedResult("sign", { status: "failed", error: "denied" })).toBe("denied");
    expect(signFailedResult("sign", { status: "failed" })).toBe("signing returned status failed");
  });

  it("stays null for other methods, statuses, and shapes", () => {
    expect(signFailedResult("send", { status: "failed" })).toBeNull();
    expect(signFailedResult("sign", { status: "confirmed" })).toBeNull();
    expect(signFailedResult("sign", null)).toBeNull();
    expect(signFailedResult("sign", "failed")).toBeNull();
  });
});

describe("withVendorCall", () => {
  it("returns the result and emits nothing on success", async () => {
    await expect(withVendorCall("kora", "estimate", async () => 5)).resolves.toBe(5);
    expect(failureEvents()).toHaveLength(0);
  });

  it("rethrows and emits one failed event with duration on rejection", async () => {
    const boom = new Error("down");
    await expect(
      withVendorCall("kora", "estimate", async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
    const emitted = failureEvents();
    expect(emitted).toHaveLength(1);
    expect(emitted[0][1]).toMatchObject({
      vendor: "kora",
      operation: "estimate",
      outcome: "failed",
    });
    expect(emitted[0][1].duration_ms).toBeTypeOf("number");
  });
});
