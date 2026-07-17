import { Hono } from "hono";
import { prettyJSON } from "hono/pretty-json";
import { describe, expect, it } from "vitest";
import openapi from "@/routes/openapi";
import type { Env } from "@/types/env";
import { createNodeHttpApp } from "./http-node";

async function readGzipJson(response: Response): Promise<unknown> {
  const decompressed = response.body?.pipeThrough(new DecompressionStream("gzip"));
  return new Response(decompressed).json();
}

describe("Node HTTP response compression", () => {
  it("compresses a large response and preserves existing Vary dimensions", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.get("/large", (c) => {
      c.header("Vary", "Origin");
      return c.json({ payload: "x".repeat(8_000) });
    });

    const response = await createNodeHttpApp(app).request("http://local.test/large", {
      headers: { "Accept-Encoding": "gzip" },
    });

    expect(response.headers.get("Content-Encoding")).toBe("gzip");
    expect(response.headers.get("Content-Length")).toBeNull();
    expect(response.headers.get("Vary")).toBe("Origin, Accept-Encoding");
    expect(await readGzipJson(response)).toEqual({ payload: "x".repeat(8_000) });
  });

  it("compresses OpenAPI after development pretty-printing", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", prettyJSON());
    app.route("/openapi.json", openapi);
    const response = await createNodeHttpApp(app).request("http://local.test/openapi.json?pretty", {
      headers: { "Accept-Encoding": "gzip" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Encoding")).toBe("gzip");
    expect(response.headers.get("Content-Length")).toBeNull();
    expect(response.headers.get("Vary")).toBe("Accept-Encoding");
    expect((await readGzipJson(response)) as { openapi: string }).toMatchObject({
      openapi: "3.0.3",
    });
  });

  it("leaves responses uncompressed when the client does not advertise support", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.get("/large", (c) => c.json({ payload: "x".repeat(8_000) }));

    const response = await createNodeHttpApp(app).request("http://local.test/large");

    expect(response.headers.get("Content-Encoding")).toBeNull();
    expect(response.headers.get("Vary")).toBe("Accept-Encoding");
    expect(await response.json()).toEqual({ payload: "x".repeat(8_000) });
  });
});
