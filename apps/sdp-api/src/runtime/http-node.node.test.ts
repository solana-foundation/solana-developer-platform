import { Hono } from "hono";
import { prettyJSON } from "hono/pretty-json";
import { describe, expect, it } from "vitest";
import { openapi } from "@/routes/openapi";
import { env } from "@/test/helpers/env";
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
    const response = await createNodeHttpApp(app).request(
      "http://local.test/openapi.json?pretty",
      { headers: { "Accept-Encoding": "gzip" } },
      { SDP_RELEASE_CHANNEL: "stable" } as Env
    );

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

  it("preserves a wildcard Vary header without appending redundant dimensions", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.get("/varies-on-everything", (c) => {
      c.header("Vary", "*");
      return c.text("uncacheable");
    });

    const response = await createNodeHttpApp(app).request("http://local.test/varies-on-everything");

    expect(response.headers.get("Vary")).toBe("*");
  });
});

describe("Node HTTP delegation to the inner app", () => {
  it("answers an unmatched path with the inner app's notFound handler", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.notFound((c) => c.json({ error: "inner_not_found" }, 404));

    const response = await createNodeHttpApp(app).request("http://local.test/missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "inner_not_found" });
  });

  it("answers an inner handler error through the inner app's onError", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.get("/boom", () => {
      throw new Error("inner failure");
    });
    app.onError((error, c) => c.json({ error: error.message }, 500));

    const response = await createNodeHttpApp(app).request("http://local.test/boom");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "inner failure" });
  });

  it("forwards a POST body to the inner handler intact", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.post("/echo", async (c) => c.text(await c.req.text()));

    const response = await createNodeHttpApp(app).request("http://local.test/echo", {
      method: "POST",
      body: '{"amount":"12.50"}',
    });

    expect(await response.text()).toBe('{"amount":"12.50"}');
  });

  it("passes request env bindings to the inner handler", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.get("/version", (c) => c.text(c.env.API_VERSION));

    const response = await createNodeHttpApp(app).request("http://local.test/version", {}, env);

    expect(await response.text()).toBe(env.API_VERSION);
  });
});
