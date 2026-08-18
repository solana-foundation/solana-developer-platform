import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";
import {
  type ValidatedBodyContext,
  type ValidatedContext,
  validateBody,
  validateParams,
  validateQuery,
} from "./validate";

const schema = z.object({
  name: z.string().min(1),
  count: z.number().int(),
});

function createApp(onMiddlewarePass?: () => void) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: err.toResponse().error }, 400);
    }
    throw err;
  });
  app.post(
    "/",
    validateBody(schema),
    async (_c, next) => {
      onMiddlewarePass?.();
      await next();
    },
    (c: ValidatedBodyContext<typeof schema>) => c.json(c.req.valid("json"))
  );
  return app;
}

function post(app: Hono<{ Bindings: Env }>, body: string, contentType = "application/json") {
  return app.request("/", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
}

describe("validateBody", () => {
  it("passes the parsed, typed body through to the handler", async () => {
    const res = await post(createApp(), JSON.stringify({ name: "abc", count: 2, extra: true }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "abc", count: 2 });
  });

  it("rejects a body that fails the schema before downstream middleware runs", async () => {
    let downstreamRan = false;
    const res = await post(
      createApp(() => {
        downstreamRan = true;
      }),
      JSON.stringify({ name: "", count: "nope" })
    );

    expect(res.status).toBe(400);
    expect(downstreamRan).toBe(false);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.details.errors).toMatchObject({
      name: [expect.any(String)],
      count: [expect.any(String)],
    });
  });

  it("rejects a non-JSON content type as an empty body", async () => {
    const res = await post(createApp(), "name=abc", "application/x-www-form-urlencoded");

    expect(res.status).toBe(400);
  });
});

const querySchema = z.object({ limit: z.coerce.number().int().min(1) });
const paramSchema = z.object({ id: z.string().min(2) });

describe("validateQuery and validateParams", () => {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: err.toResponse().error }, 400);
    }
    throw err;
  });
  app.get(
    "/things/:id",
    validateParams(paramSchema),
    validateQuery(querySchema),
    (c: ValidatedContext<{ param: typeof paramSchema; query: typeof querySchema }>) =>
      c.json({ ...c.req.valid("param"), ...c.req.valid("query") })
  );

  it("passes typed params and coerced query through to the handler", async () => {
    const res = await app.request("/things/abc?limit=5");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "abc", limit: 5 });
  });

  it("rejects an invalid query with the query error shape", async () => {
    const res = await app.request("/things/abc?limit=zero");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe("Invalid query parameters");
    expect(body.error.details.errors).toMatchObject({ limit: [expect.any(String)] });
  });

  it("rejects an invalid path param with the params error shape", async () => {
    const res = await app.request("/things/x?limit=5");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe("Invalid path parameters");
  });
});
