import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as logger from "@/runtime/logger";
import type { Env } from "@/types/env";
import { requestTracingMiddleware } from "./request-tracing";

afterEach(() => vi.restoreAllMocks());

describe("requestTracingMiddleware", () => {
  it("logs a route template without the requested resource ID", async () => {
    const info = vi.fn();
    vi.spyOn(logger, "getLogger").mockReturnValue({ info } as unknown as ReturnType<
      typeof logger.getLogger
    >);
    const app = new Hono<{ Bindings: Env }>();
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
});
