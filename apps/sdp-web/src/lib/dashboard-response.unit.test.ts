import { describe, expect, it } from "vitest";
import { expectDashboardNoStore } from "@/test/dashboard-response";
import { dashboardJson, dashboardResponseHeaders } from "./dashboard-response";

const trace = { traceId: "trace_1", serverTiming: () => "app;dur=3" };

describe("dashboardJson", () => {
  it("marks a success uncacheable and keeps the trace headers", async () => {
    const response = dashboardJson({ data: [] }, { trace });

    expect(response.status).toBe(200);
    expectDashboardNoStore(response);
    expect(response.headers.get("X-SDP-Trace-ID")).toBe("trace_1");
    expect(response.headers.get("Server-Timing")).toBe("app;dur=3");
    expect(await response.json()).toEqual({ data: [] });
  });

  it("marks an error uncacheable", () => {
    const response = dashboardJson({ error: { message: "nope" } }, { status: 500 });

    expect(response.status).toBe(500);
    expectDashboardNoStore(response);
    expect(response.headers.has("X-SDP-Trace-ID")).toBe(false);
  });
});

describe("dashboardResponseHeaders", () => {
  it("keeps the route's own headers but not a weaker cache policy", () => {
    const headers = dashboardResponseHeaders(undefined, {
      "Content-Type": "text/csv",
      "Cache-Control": "public, max-age=60",
    });

    expect(headers.get("Content-Type")).toBe("text/csv");
    expect(headers.get("Cache-Control")).toBe("private, no-store");
    expect(headers.get("Vary")).toBe("x-project-id");
  });
});
