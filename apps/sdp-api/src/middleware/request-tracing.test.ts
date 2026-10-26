import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as logger from "@/runtime/logger";
import type { Env } from "@/types/env";
import { localRateLimit } from "./local-rate-limit";
import { requestIdMiddleware } from "./request-id";
import { requestTracingMiddleware } from "./request-tracing";

afterEach(() => vi.restoreAllMocks());

describe("requestTracingMiddleware", () => {
  it("logs a route template without the requested resource ID", async () => {
    const info = vi.fn();
    vi.spyOn(logger, "getLogger").mockReturnValue({ info } as unknown as ReturnType<
      typeof logger.getLogger
    >);
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", requestIdMiddleware());
    app.use("*", requestTracingMiddleware());
    app.get("/v1/wallets/:walletId", (c) => c.text("ok"));

    const response = await app.request("https://example.test/v1/wallets/private-wallet-id");

    expect(response.status).toBe(200);
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0]?.[0]).toMatchObject({
      event: "sdp_api_request_timing",
      path: "/v1/wallets/:walletId",
      method: "GET",
      status: 200,
    });
    expect(JSON.stringify(info.mock.calls[0]?.[0])).not.toContain("private-wallet-id");
  });

  it("replaces inbound IDs and bounds the source before logging", async () => {
    const info = vi.fn();
    vi.spyOn(logger, "getLogger").mockReturnValue({ info } as unknown as ReturnType<
      typeof logger.getLogger
    >);
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", requestIdMiddleware());
    app.use("*", requestTracingMiddleware());
    app.get("/v1/wallets/:walletId", (c) => c.text("ok"));

    const response = await app.request("https://example.test/v1/wallets/secret-wallet", {
      headers: {
        "X-Request-ID": "sk_live_exposed",
        "X-SDP-Trace-ID": "sk_live_exposed",
        "X-SDP-Trace-Source": "route.dashboard.sk_live_exposed",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-ID")).toMatch(/^req_[0-9a-f-]{36}$/);
    expect(response.headers.get("X-SDP-Trace-ID")).toBe(response.headers.get("X-Request-ID"));
    expect(info.mock.calls[0]?.[0]).toMatchObject({ source: "dashboard" });
    expect(JSON.stringify(info.mock.calls[0]?.[0])).not.toContain("sk_live_exposed");
  });

  it("keeps a successful response when the request log sink fails", async () => {
    vi.spyOn(logger, "getLogger").mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", requestIdMiddleware());
    app.use("*", requestTracingMiddleware());
    app.get("/ok", (c) => c.text("ok"));

    const response = await app.request("https://example.test/ok");

    expect(response.status).toBe(200);
    expect(response.headers.get("X-SDP-Trace-ID")).toBe(response.headers.get("X-Request-ID"));
  });

  it("keeps unmatched path and query secrets out of timing and rate-limit logs", async () => {
    const info = vi.fn();
    const warn = vi.fn();
    vi.spyOn(logger, "getLogger").mockReturnValue({ info, warn } as unknown as ReturnType<
      typeof logger.getLogger
    >);
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", requestIdMiddleware());
    app.use("*", requestTracingMiddleware());
    app.use(
      "*",
      localRateLimit({
        name: "privacy-test",
        maxRequests: 1,
        windowMs: 60_000,
        maxTrackedKeys: 1,
      })
    );
    app.onError((_error, c) => c.text("limited", 429));
    const url = "https://example.test/sk_path_secret?api_key=sk_query_secret";

    expect((await app.request(url)).status).toBe(404);
    expect((await app.request(url)).status).toBe(429);

    const logged = JSON.stringify([info.mock.calls, warn.mock.calls]);
    expect(logged).not.toContain("sk_path_secret");
    expect(logged).not.toContain("sk_query_secret");
    expect(warn).toHaveBeenCalledOnce();
  });
});
