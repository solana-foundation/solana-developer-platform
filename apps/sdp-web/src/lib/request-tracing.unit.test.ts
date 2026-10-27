import { afterEach, describe, expect, it, vi } from "vitest";
import { createTimedTrace, getTraceHeaders } from "./request-tracing";

afterEach(() => vi.restoreAllMocks());

describe("request tracing", () => {
  it("replaces inbound trace IDs before logging or forwarding", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const request = new Request("https://web.example.test/api/playground", {
      headers: { "X-SDP-Trace-ID": "sk_live_exposed" },
    });

    const trace = createTimedTrace("route.playground.proxy", request);
    trace.log();

    expect(trace.traceId).toMatch(/^web_[0-9a-f]{32}$/);
    expect(getTraceHeaders(trace)["X-SDP-Trace-ID"]).toBe(trace.traceId);
    expect(info.mock.calls.join(" ")).not.toContain("sk_live_exposed");
  });
});
