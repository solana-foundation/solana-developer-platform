import { afterEach, describe, expect, it, vi } from "vitest";
import { startEgressGate } from "@/runtime/egress-gate";
import { getLogger } from "@/runtime/logger";

describe("startEgressGate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays pending until a probe succeeds, then reports ok", async () => {
    const info = vi.spyOn(getLogger(), "info").mockImplementation(() => undefined);
    let calls = 0;
    const gate = startEgressGate({
      probe: async () => {
        calls += 1;
        if (calls < 3) throw new TypeError("fetch failed");
      },
      deadlineMs: 10_000,
      intervalMs: 0,
    });

    expect(gate.state()).toBe("pending");
    await gate.settled;

    expect(gate.state()).toBe("ok");
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "sdp_api_egress_ready", attempts: 3 }),
      "egress ready"
    );
  });

  it("reports unverified and logs an error once the deadline passes without a success", async () => {
    const error = vi.spyOn(getLogger(), "error").mockImplementation(() => undefined);
    const gate = startEgressGate({
      probe: async () => {
        throw new TypeError("fetch failed");
      },
      deadlineMs: 20,
      intervalMs: 5,
    });

    await gate.settled;

    expect(gate.state()).toBe("unverified");
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "sdp_api_egress_unverified" }),
      "egress warmup deadline reached, serving anyway"
    );
  });

  it("reports unverified at the deadline while a probe is still in flight", async () => {
    vi.spyOn(getLogger(), "error").mockImplementation(() => undefined);
    const gate = startEgressGate({
      probe: () => new Promise<void>(() => undefined),
      deadlineMs: 20,
      intervalMs: 0,
    });

    await gate.settled;

    expect(gate.state()).toBe("unverified");
  });

  it("reports ok when the probe in flight at the deadline succeeds later", async () => {
    vi.spyOn(getLogger(), "error").mockImplementation(() => undefined);
    const info = vi.spyOn(getLogger(), "info").mockImplementation(() => undefined);
    let succeed: () => void = () => undefined;
    const gate = startEgressGate({
      probe: () =>
        new Promise<void>((resolve) => {
          succeed = resolve;
        }),
      deadlineMs: 20,
      intervalMs: 0,
    });

    await gate.settled;
    expect(gate.state()).toBe("unverified");

    succeed();
    await vi.waitFor(() => expect(gate.state()).toBe("ok"));
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "sdp_api_egress_ready", attempts: 1 }),
      "egress ready"
    );
  });

  it("settles when the probe throws synchronously", async () => {
    vi.spyOn(getLogger(), "error").mockImplementation(() => undefined);
    const gate = startEgressGate({
      probe: () => {
        throw new Error("not configured");
      },
      deadlineMs: 0,
      intervalMs: 0,
    });

    await expect(gate.settled).resolves.toBeUndefined();
    expect(gate.state()).toBe("unverified");
  });
});
