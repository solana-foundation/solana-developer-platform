import app from "@/index";
import { env } from "@/test/helpers/env";
import { describe, expect, it } from "vitest";

describe("RPC routes", () => {
  it("returns 404 for GET /v1/rpc/providers", async () => {
    const response = await app.request("/v1/rpc/providers", {}, env);
    expect(response.status).toBe(404);
  });

  it("returns 404 for POST /v1/rpc/proxy", async () => {
    const response = await app.request(
      "/v1/rpc/proxy",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getVersion",
          params: [],
        }),
      },
      env
    );

    expect(response.status).toBe(404);
  });
});
