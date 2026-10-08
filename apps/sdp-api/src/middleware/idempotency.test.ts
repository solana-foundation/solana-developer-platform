import { type Context, Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";
import {
  canonicalJson,
  declaredIdempotency,
  IDEMPOTENT_REPLAYED_HEADER,
  type IdempotencyOptions,
  idempotent,
  requestFingerprint,
} from "./idempotency";

const ORG = "org_idempotency";
const USER = "usr_idempotency";
const SANDBOX = `prj_${ORG}_sandbox`;
const PRODUCTION = `prj_${ORG}_production`;

async function seed(): Promise<void> {
  const db = getDb(env);
  await db
    .prepare(
      `INSERT INTO users (id, email, email_verified, status)
       VALUES (?, 'idempotency@example.com', 1, 'active') ON CONFLICT (id) DO NOTHING`
    )
    .bind(USER)
    .run();
  await db
    .prepare(
      `INSERT INTO organizations (id, name, slug, tier, status)
       VALUES (?, ?, ?, 'individual', 'active') ON CONFLICT (id) DO NOTHING`
    )
    .bind(ORG, ORG, ORG)
    .run();
  await seedDefaultProjects(db, { organizationId: ORG, createdBy: USER, members: [USER] });
}

interface Handlers {
  create: ReturnType<typeof vi.fn>;
}

function buildApp(
  options: IdempotencyOptions,
  handle: (c: Context<{ Bindings: Env }>) => Response | Promise<Response>
): { app: Hono<{ Bindings: Env }>; handlers: Handlers } {
  const create = vi.fn(handle);
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toResponse(), err.statusCode as 400);
    }
    return c.json({ error: { code: "INTERNAL_ERROR" } }, 500);
  });
  app.use("*", async (c, next) => {
    const projectId = c.req.header("x-test-project") ?? SANDBOX;
    c.set("apiKey", { id: "key_test", organizationId: ORG, projectId } as never);
    c.set("projectId", projectId);
    if (c.req.header("x-test-approved-operation")) {
      c.set("approvedWalletOperationId", "wop_test");
    }
    await next();
  });
  app.post("/v1/things/:thingId/act", idempotent(options), (c) => create(c));
  app.post("/v1/other", idempotent(options), (c) => create(c));
  return { app, handlers: { create } };
}

function post(
  app: Hono<{ Bindings: Env }>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    env
  );
}

async function storedRows(): Promise<Array<Record<string, unknown>>> {
  return getDb(env).queryMany(
    `SELECT operation, project_id, status, response_status FROM idempotency_keys ORDER BY created_at`
  );
}

let counter = 0;
function createdResponse(c: Context<{ Bindings: Env }>) {
  counter += 1;
  return c.json({ thing: { id: `thing_${counter}` } }, 201);
}

describe("canonical fingerprint", () => {
  it("ignores object key order and undefined members, but not array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: undefined } })).toBe('{"a":{"d":[2,1]},"b":1}');
    const left = requestFingerprint({ operation: "POST /x", params: {}, body: { a: 1, b: 2 } });
    const right = requestFingerprint({ operation: "POST /x", params: {}, body: { b: 2, a: 1 } });
    expect(left).toBe(right);
    expect(left).toMatch(/^[0-9a-f]{64}$/);
    expect(requestFingerprint({ operation: "POST /x", params: {}, body: { a: [1, 2] } })).not.toBe(
      requestFingerprint({ operation: "POST /x", params: {}, body: { a: [2, 1] } })
    );
  });
});

describe("idempotent()", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seed();
    counter = 0;
  });

  it("declares its key mode for route inventories", () => {
    expect(declaredIdempotency(idempotent({ key: "required" }))).toBe("required");
    expect(declaredIdempotency(idempotent({ key: "accepted" }))).toBe("accepted");
    expect(declaredIdempotency(() => undefined)).toBeUndefined();
  });

  it("runs an unkeyed request on an accepting route without recording anything", async () => {
    const { app, handlers } = buildApp({ key: "accepted" }, createdResponse);
    expect((await post(app, "/v1/other", { a: 1 })).status).toBe(201);
    expect((await post(app, "/v1/other", { a: 1 })).status).toBe(201);
    expect(handlers.create).toHaveBeenCalledTimes(2);
    expect(await storedRows()).toEqual([]);
  });

  it("refuses an unkeyed request on a requiring route before the handler runs", async () => {
    const { app, handlers } = buildApp({ key: "required" }, createdResponse);
    const res = await post(app, "/v1/other", { a: 1 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "IDEMPOTENCY_KEY_REQUIRED"
    );
    expect(handlers.create).not.toHaveBeenCalled();
  });

  it("refuses a malformed key", async () => {
    const { app, handlers } = buildApp({ key: "accepted" }, createdResponse);
    const res = await post(app, "/v1/other", {}, { "Idempotency-Key": "k".repeat(256) });
    expect(res.status).toBe(400);
    expect(handlers.create).not.toHaveBeenCalled();
  });

  it("replays a completed request's status and body, marked as a replay", async () => {
    const { app, handlers } = buildApp({ key: "required" }, createdResponse);
    const headers = { "Idempotency-Key": "key-1" };
    const first = await post(app, "/v1/things/t1/act", { amount: "1", to: "a" }, headers);
    // Same request, members in a different order.
    const second = await post(app, "/v1/things/t1/act", { to: "a", amount: "1" }, headers);

    expect(first.status).toBe(201);
    expect(first.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    expect(second.status).toBe(201);
    expect(second.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
    expect(second.headers.get("content-type")).toContain("application/json");
    expect(await second.json()).toEqual(await first.json());
    expect(handlers.create).toHaveBeenCalledTimes(1);
    expect(await storedRows()).toEqual([
      {
        operation: "POST /v1/things/:thingId/act",
        project_id: SANDBOX,
        status: "completed",
        response_status: 201,
      },
    ]);
  });

  it("answers 422 when a key is reused with a different body or path parameter", async () => {
    const { app, handlers } = buildApp({ key: "required" }, createdResponse);
    const headers = { "Idempotency-Key": "key-1" };
    await post(app, "/v1/things/t1/act", { amount: "1" }, headers);

    const otherBody = await post(app, "/v1/things/t1/act", { amount: "2" }, headers);
    const otherParam = await post(app, "/v1/things/t2/act", { amount: "1" }, headers);

    for (const res of [otherBody, otherParam]) {
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "IDEMPOTENCY_KEY_REUSED"
      );
    }
    expect(handlers.create).toHaveBeenCalledTimes(1);
  });

  it("scopes a key to its operation and its project", async () => {
    const { app, handlers } = buildApp({ key: "required" }, createdResponse);
    const headers = { "Idempotency-Key": "key-1" };
    await post(app, "/v1/things/t1/act", { amount: "1" }, headers);
    const otherOperation = await post(app, "/v1/other", { amount: "1" }, headers);
    const otherProject = await post(
      app,
      "/v1/things/t1/act",
      { amount: "1" },
      { ...headers, "x-test-project": PRODUCTION }
    );

    expect(otherOperation.status).toBe(201);
    expect(otherOperation.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    expect(otherProject.status).toBe(201);
    expect(otherProject.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    expect(handlers.create).toHaveBeenCalledTimes(3);
  });

  it("answers 409 with Retry-After while the original request still holds the key", async () => {
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app, handlers } = buildApp({ key: "required", leaseSeconds: 30 }, async (c) => {
      markStarted();
      await released;
      return c.json({ ok: true }, 201);
    });
    const headers = { "Idempotency-Key": "key-1" };

    const first = post(app, "/v1/other", { a: 1 }, headers);
    await started;
    const concurrent = await post(app, "/v1/other", { a: 1 }, headers);
    release();

    expect(concurrent.status).toBe(409);
    expect(((await concurrent.json()) as { error: { code: string } }).error.code).toBe(
      "IDEMPOTENCY_KEY_IN_FLIGHT"
    );
    const retryAfter = Number(concurrent.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(30);
    expect((await first).status).toBe(201);
    expect(handlers.create).toHaveBeenCalledTimes(1);
  });

  it("does not store a refusal, so the same key runs again", async () => {
    let refuse = true;
    const { app, handlers } = buildApp({ key: "required" }, (c) => {
      if (refuse) throw badRequest("not yet");
      return c.json({ ok: true }, 201);
    });
    const headers = { "Idempotency-Key": "key-1" };

    expect((await post(app, "/v1/other", { a: 1 }, headers)).status).toBe(400);
    expect(await storedRows()).toEqual([]);
    refuse = false;
    const retried = await post(app, "/v1/other", { a: 1 }, headers);

    expect(retried.status).toBe(201);
    expect(retried.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    expect(handlers.create).toHaveBeenCalledTimes(2);
  });

  it("stores a handler's 404 and replays it", async () => {
    const { app, handlers } = buildApp({ key: "required" }, () => {
      throw notFound("Thing");
    });
    const headers = { "Idempotency-Key": "key-1" };

    const first = await post(app, "/v1/other", { a: 1 }, headers);
    const second = await post(app, "/v1/other", { a: 1 }, headers);

    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(second.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
    expect(handlers.create).toHaveBeenCalledTimes(1);
  });

  it("does not store a 5xx: the same request runs again, a different one is refused", async () => {
    let fail = true;
    const { app, handlers } = buildApp({ key: "required" }, (c) => {
      if (fail) throw new Error("upstream down");
      return c.json({ ok: true }, 201);
    });
    const headers = { "Idempotency-Key": "key-1" };

    expect((await post(app, "/v1/other", { a: 1 }, headers)).status).toBe(500);
    expect((await post(app, "/v1/other", { a: 2 }, headers)).status).toBe(422);
    fail = false;
    const retried = await post(app, "/v1/other", { a: 1 }, headers);

    expect(retried.status).toBe(201);
    expect(handlers.create).toHaveBeenCalledTimes(2);
    expect(await storedRows()).toMatchObject([{ status: "completed", response_status: 201 }]);
  });

  it("skips dry runs and approved-operation executions", async () => {
    const { app, handlers } = buildApp({ key: "required" }, createdResponse);
    const headers = { "Idempotency-Key": "key-1" };

    await post(app, "/v1/other", { a: 1 }, { ...headers, "Dry-Run": "true" });
    expect(await storedRows()).toEqual([]);

    await post(app, "/v1/other", { a: 1 }, headers);
    const executed = await post(
      app,
      "/v1/other",
      { a: 1 },
      { ...headers, "x-test-approved-operation": "1" }
    );

    expect(executed.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    expect(handlers.create).toHaveBeenCalledTimes(3);
  });

  it("applies the route's canonicalize hook before fingerprinting", async () => {
    const { app, handlers } = buildApp(
      {
        key: "required",
        canonicalize: (body) => {
          const { recipients, ...rest } = body as { recipients: string[] };
          return { ...rest, recipients: [...recipients].sort() };
        },
      },
      createdResponse
    );
    const headers = { "Idempotency-Key": "key-1" };

    await post(app, "/v1/other", { recipients: ["b", "a"] }, headers);
    const reordered = await post(app, "/v1/other", { recipients: ["a", "b"] }, headers);

    expect(reordered.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
    expect(handlers.create).toHaveBeenCalledTimes(1);
  });
});
