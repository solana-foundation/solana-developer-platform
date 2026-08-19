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

function createApp<S extends z.ZodType<object>>(bodySchema: S, onMiddlewarePass?: () => void) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: err.toResponse().error }, 400);
    }
    throw err;
  });
  app.post(
    "/",
    validateBody(bodySchema),
    async (_c, next) => {
      onMiddlewarePass?.();
      await next();
    },
    (c: ValidatedBodyContext<S>) => c.json(c.req.valid("json"))
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
    const res = await post(
      createApp(schema),
      JSON.stringify({ name: "abc", count: 2, extra: true })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "abc", count: 2 });
  });

  it("rejects a body that fails the schema before downstream middleware runs", async () => {
    let downstreamRan = false;
    const res = await post(
      createApp(schema, () => {
        downstreamRan = true;
      }),
      JSON.stringify({ name: "", count: "nope" })
    );

    expect(res.status).toBe(400);
    expect(downstreamRan).toBe(false);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("Invalid request body:");
    expect(body.error.message).toContain("→ at name");
    expect(body.error.message).toContain("→ at count");
    expect(body.error.details).toBeUndefined();
  });

  it("parses a JSON body even without a JSON content type", async () => {
    const res = await post(
      createApp(schema),
      JSON.stringify({ name: "abc", count: 2 }),
      "text/plain"
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "abc", count: 2 });
  });

  it("rejects a non-JSON body as malformed", async () => {
    const res = await post(createApp(schema), "name=abc", "application/x-www-form-urlencoded");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe("Malformed JSON in request body");
  });

  it("renders a nested issue with its full dot path in the message", async () => {
    const nestedSchema = z.object({
      identity: z.object({
        address: z.object({ line1: z.string().min(1) }),
      }),
    });
    const res = await post(
      createApp(nestedSchema),
      JSON.stringify({ identity: { address: { line1: "" } } })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("→ at identity.address.line1");
    expect(body.error.details).toBeUndefined();
  });

  it("names a strict schema's unrecognized keys in the message", async () => {
    const strictSchema = z.strictObject({
      provider: z.string().min(1),
      nested: z.strictObject({ known: z.string().min(1) }).optional(),
    });
    const res = await post(
      createApp(strictSchema),
      JSON.stringify({ provider: "para", apiBaseUrl: "https://x", nested: { known: "a", bad: 1 } })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('Unrecognized key: "apiBaseUrl"');
    expect(body.error.message).toContain('Unrecognized key: "bad"');
    expect(body.error.message).toContain("→ at nested");
    expect(body.error.details).toBeUndefined();
  });

  it("reports a non-object body as a root-level message line", async () => {
    const res = await post(createApp(schema), JSON.stringify("not an object"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("expected object, received string");
    expect(body.error.details).toBeUndefined();
  });

  it("treats an empty body with a JSON content type as an empty object", async () => {
    const emptyBodySchema = z.object({ note: z.string().optional() });

    const res = await post(createApp(emptyBodySchema), "");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
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
    expect(body.error.message).toContain("Invalid query parameters:");
    expect(body.error.message).toContain("→ at limit");
    expect(body.error.details).toBeUndefined();
  });

  it("rejects an invalid path param with the params error shape", async () => {
    const res = await app.request("/things/x?limit=5");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("Invalid path parameters:");
  });
});
