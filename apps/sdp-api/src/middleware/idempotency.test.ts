import { type Context, Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import * as idempotencyKeysRepository from "@/db/repositories/idempotency-keys.repository";
import { AppError, badRequest, forbidden, notFound } from "@/lib/errors";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";
import { authorize } from "./authorize";
import {
  declaredIdempotency,
  declaredIdempotencyRecovery,
  deriveIdempotencyRecordKey,
  getIdempotencyClaim,
  getIdempotencyFingerprint,
  getIdempotencyRecordKey,
  IDEMPOTENT_REPLAYED_HEADER,
  type IdempotencyOptions,
  idempotent,
  MAX_STORED_RESPONSE_BYTES,
  markIdempotencyCommitted,
  requestFingerprint,
  runIdempotency,
} from "./idempotency";
import { declaresRecordReplay, replayFromRecord } from "./movement-steps";
import { declaredValidation, validateBody, validateParams, validateQuery } from "./validate";

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

type Handle = (c: Context<{ Bindings: Env }>) => Response | Promise<Response>;

function testApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      // SAFETY: AppError status codes are the API's own error statuses.
      return c.json(err.toResponse(), err.statusCode as 400);
    }
    return c.json({ error: { code: "INTERNAL_ERROR" } }, 500);
  });
  app.use("*", async (c, next) => {
    const projectId = c.req.header("x-test-project") ?? SANDBOX;
    const keyId = c.req.header("x-test-key") ?? "key_test";
    // SAFETY: the middleware reads only id, organizationId and projectId.
    c.set("apiKey", { id: keyId, organizationId: ORG, projectId } as never);
    if (!c.req.header("x-test-skip-project")) {
      c.set("projectId", projectId);
    }
    // Stands in for the route's authorize step, which runs before idempotent().
    if (!c.req.header("x-test-skip-authorize")) {
      c.set("authorized", { loaded: undefined });
    }
    await next();
  });
  return app;
}

function buildApp(
  partial: Omit<IdempotencyOptions, "serverErrors"> & Partial<IdempotencyOptions>,
  handle: Handle
) {
  const options: IdempotencyOptions = { serverErrors: "store", ...partial };
  const create = vi.fn(handle);
  const app = testApp();
  app.post("/v1/things/:thingId/act", idempotent(options), (c) => create(c));
  app.post("/v1/other", idempotent(options), (c) => create(c));
  return { app, create };
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
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    env
  );
}

const errorBodySchema = z.object({ error: z.object({ code: z.string() }) });

async function errorCode(res: Response): Promise<string> {
  return errorBodySchema.parse(await res.json()).error.code;
}

async function storedRows(): Promise<Array<Record<string, unknown>>> {
  return getDb(env).queryMany(
    `SELECT operation, project_id, status, response_status FROM idempotency_keys ORDER BY created_at`
  );
}

let counter = 0;
function created(c: Context<{ Bindings: Env }>) {
  counter += 1;
  return c.json({ thing: { id: `thing_${counter}` } }, 201);
}

const KEY = { "Idempotency-Key": "key-1" };

describe("requestFingerprint", () => {
  const base = {
    operation: "POST /x",
    params: {},
    query: {},
    body: { a: 1, b: 2 },
  };

  it("ignores object key order but not array order", () => {
    expect(requestFingerprint(base)).toBe(requestFingerprint({ ...base, body: { b: 2, a: 1 } }));
    expect(requestFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(requestFingerprint({ ...base, body: [1, 2] })).not.toBe(
      requestFingerprint({ ...base, body: [2, 1] })
    );
  });

  it("separates path parameters and query", () => {
    const fingerprint = requestFingerprint(base);
    for (const variant of [{ params: { id: "1" } }, { query: { force: ["true"] } }]) {
      expect(requestFingerprint({ ...base, ...variant })).not.toBe(fingerprint);
    }
  });
});

describe("idempotent()", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seed();
    counter = 0;
  });

  it("declares its key mode for route inventories", () => {
    expect(declaredIdempotency(idempotent({ key: "required", serverErrors: "store" }))).toBe(
      "required"
    );
    expect(declaredIdempotency(idempotent({ key: "accepted", serverErrors: "store" }))).toBe(
      "accepted"
    );
    expect(declaredIdempotency(() => undefined)).toBeUndefined();
  });

  it("declares row recovery, record replay and validation for route inventories", () => {
    expect(
      declaredIdempotencyRecovery(
        idempotent({ key: "required", serverErrors: "store", recovery: "record" })
      )
    ).toBe("record");
    expect(
      declaredIdempotencyRecovery(idempotent({ key: "required", serverErrors: "store" }))
    ).toBeUndefined();
    expect(declaredIdempotencyRecovery(() => undefined)).toBeUndefined();
    expect(declaresRecordReplay(replayFromRecord(async () => null))).toBe(true);
    expect(declaresRecordReplay(() => undefined)).toBe(false);
    expect(declaredValidation(validateBody(z.object({})))).toBe("json");
    expect(declaredValidation(validateQuery(z.object({})))).toBe("query");
    expect(declaredValidation(validateParams(z.object({})))).toBe("param");
    expect(declaredValidation(() => undefined)).toBeUndefined();
  });

  it("stores a refusal raised after the handler wrote its domain row", async () => {
    const { app, create } = buildApp({ key: "required" }, (c) => {
      markIdempotencyCommitted(c);
      throw new AppError("CONFLICT", "the row exists but the provider refused");
    });

    expect((await post(app, "/v1/other", { a: 1 }, KEY)).status).toBe(409);
    const replayed = await post(app, "/v1/other", { a: 1 }, KEY);

    expect(replayed.status).toBe(409);
    expect(replayed.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("binds the record key to the credential, never the raw key", async () => {
    const seen: Array<string | undefined> = [];
    const { app } = buildApp({ key: "required" }, (c) => {
      seen.push(getIdempotencyRecordKey(c));
      return c.json({}, 201);
    });

    await post(app, "/v1/other", { a: 1 }, KEY);

    const scope = { organizationId: ORG, projectId: SANDBOX, principal: "key_test" };
    expect(seen).toEqual([deriveIdempotencyRecordKey(scope, "key-1")]);
    expect(seen[0]).not.toBe("key-1");
    expect(deriveIdempotencyRecordKey({ ...scope, principal: "key_other" }, "key-1")).not.toBe(
      seen[0]
    );
  });

  it("runs an unkeyed request on an accepting route without recording anything", async () => {
    const { app, create } = buildApp({ key: "accepted" }, created);
    expect((await post(app, "/v1/other", { a: 1 })).status).toBe(201);
    expect((await post(app, "/v1/other", { a: 1 })).status).toBe(201);
    expect(create).toHaveBeenCalledTimes(2);
    expect(await storedRows()).toEqual([]);
  });

  it("refuses an unkeyed request on a requiring route before the handler runs", async () => {
    const { app, create } = buildApp({ key: "required" }, created);
    const res = await post(app, "/v1/other", { a: 1 });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a malformed key", async () => {
    const { app, create } = buildApp({ key: "accepted" }, created);
    const res = await post(app, "/v1/other", {}, { "Idempotency-Key": "k".repeat(256) });
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses to run from a wildcard mount, where every endpoint would share one scope", async () => {
    const app = testApp();
    app.use("/v1/wild/*", idempotent({ key: "required", serverErrors: "store" }));
    app.post("/v1/wild/:id", (c) => c.json({ ok: true }, 201));
    expect((await post(app, "/v1/wild/a", {}, KEY)).status).toBe(500);
    expect(await storedRows()).toEqual([]);
  });

  it("replays a completed request's status, body and Location, marked as a replay", async () => {
    const { app, create } = buildApp({ key: "required" }, (c) => {
      c.header("Location", "/v1/things/thing_1");
      return created(c);
    });
    const first = await post(app, "/v1/things/t1/act", { amount: "1", to: "a" }, KEY);
    const second = await post(app, "/v1/things/t1/act", { to: "a", amount: "1" }, KEY);

    expect(first.status).toBe(201);
    expect(first.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    expect(second.status).toBe(201);
    expect(second.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
    expect(second.headers.get("location")).toBe("/v1/things/thing_1");
    expect(await second.json()).toEqual(await first.json());
    expect(create).toHaveBeenCalledTimes(1);
    expect(await storedRows()).toEqual([
      {
        operation: "POST /v1/things/:thingId/act",
        project_id: SANDBOX,
        status: "completed",
        response_status: 201,
      },
    ]);
  });

  it("replays a 204 without a body", async () => {
    const { app, create } = buildApp({ key: "required" }, (c) => c.body(null, 204));
    await post(app, "/v1/other", {}, KEY);
    const replayed = await post(app, "/v1/other", {}, KEY);
    expect(replayed.status).toBe(204);
    expect(replayed.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("treats an empty body as {} and fingerprints an unparsable body apart from any JSON", async () => {
    const { app, create } = buildApp({ key: "required" }, created);
    await post(app, "/v1/other", "", KEY);
    expect((await post(app, "/v1/other", {}, KEY)).headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe(
      "true"
    );
    expect((await post(app, "/v1/other", ["unparsed", "{"], KEY)).status).toBe(422);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("answers 422 when a key is reused with a different body, path parameter, query or credential", async () => {
    const { app, create } = buildApp({ key: "required" }, created);
    await post(app, "/v1/things/t1/act", { amount: "1" }, KEY);

    for (const res of [
      await post(app, "/v1/things/t1/act", { amount: "2" }, KEY),
      await post(app, "/v1/things/t2/act", { amount: "1" }, KEY),
      await post(app, "/v1/things/t1/act?force=true", { amount: "1" }, KEY),
      await post(app, "/v1/things/t1/act", { amount: "1" }, { ...KEY, "x-test-key": "key_other" }),
    ]) {
      expect(res.status).toBe(422);
      expect(await errorCode(res)).toBe("IDEMPOTENCY_KEY_REUSED");
    }
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("scopes a key to its operation and its project", async () => {
    const { app, create } = buildApp({ key: "required" }, created);
    await post(app, "/v1/things/t1/act", { amount: "1" }, KEY);
    const otherOperation = await post(app, "/v1/other", { amount: "1" }, KEY);
    const otherProject = await post(
      app,
      "/v1/things/t1/act",
      { amount: "1" },
      { ...KEY, "x-test-project": PRODUCTION }
    );

    expect(otherOperation.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    expect(otherProject.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("answers 409 with Retry-After while the original holds the key, renewing past its lease", async () => {
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app, create } = buildApp({ key: "required", leaseSeconds: 1 }, async (c) => {
      markStarted();
      await released;
      return c.json({ ok: true }, 201);
    });

    const first = post(app, "/v1/other", { a: 1 }, KEY);
    await started;
    // Past the 1s lease: the renewal keeps the key held.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const concurrent = await post(app, "/v1/other", { a: 1 }, KEY);
    release();

    expect(concurrent.status).toBe(409);
    expect(await errorCode(concurrent)).toBe("IDEMPOTENCY_KEY_IN_FLIGHT");
    expect(Number(concurrent.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect((await first).status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
  });

  function hungApp(serverErrors: IdempotencyOptions["serverErrors"]) {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const built = buildApp(
      { key: "required", serverErrors, leaseSeconds: 1, maxLeaseRenewalSeconds: 1 },
      async (c) => {
        if (built.create.mock.calls.length === 1) {
          markStarted();
          await released;
        }
        return c.json({ ok: true }, 201);
      }
    );
    return { ...built, started, release };
  }

  it("lets a hung request's key go once it outlives the renewal cap on a rerun route", async () => {
    const { app, create, started, release } = hungApp("rerun");

    const first = post(app, "/v1/other", { a: 1 }, KEY);
    await started;
    // Renewal stops at the 1s cap, so the lease runs out and a retry takes over.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const takeover = await post(app, "/v1/other", { a: 1 }, KEY);
    release();
    await first;

    expect(takeover.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("answers a hung request's retry on a store route with the terminal 409, then replays its outcome", async () => {
    const { app, create, started, release } = hungApp("store");

    const first = post(app, "/v1/other", { a: 1 }, KEY);
    await started;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const retry = await post(app, "/v1/other", { a: 1 }, KEY);
    release();

    expect(retry.status).toBe(409);
    expect(await errorCode(retry)).toBe("IDEMPOTENCY_KEY_OUTCOME_UNKNOWN");
    expect((await first).status).toBe(201);
    const replayed = await post(app, "/v1/other", { a: 1 }, KEY);
    expect(replayed.status).toBe(201);
    expect(replayed.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
    expect(create).toHaveBeenCalledTimes(1);
  });

  /** Runs `body` while every outcome write fails, as if the database dropped after the handler. */
  async function withFailingCompletes(body: () => Promise<void>): Promise<void> {
    const actual = idempotencyKeysRepository.createPostgresIdempotencyKeyRepository;
    const factory = vi
      .spyOn(idempotencyKeysRepository, "createPostgresIdempotencyKeyRepository")
      .mockImplementation((db) => ({
        ...actual(db),
        complete: async () => {
          throw new Error("database unavailable");
        },
      }));
    try {
      await body();
    } finally {
      factory.mockRestore();
    }
  }

  it.each(["store", "rerun"] as const)(
    "answers a live request whose renewals fail as in flight on a %s route, then replays it",
    async (serverErrors) => {
      const actual = idempotencyKeysRepository.createPostgresIdempotencyKeyRepository;
      const factory = vi
        .spyOn(idempotencyKeysRepository, "createPostgresIdempotencyKeyRepository")
        .mockImplementation((db) => ({
          ...actual(db),
          renew: async () => {
            throw new Error("database failing over");
          },
        }));
      try {
        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const { app, create } = buildApp(
          { key: "required", serverErrors, leaseSeconds: 1 },
          async (c) => {
            markStarted();
            await released;
            return c.json({ ok: true }, 201);
          }
        );

        const first = post(app, "/v1/other", { a: 1 }, KEY);
        await started;
        // The 1s lease lapses because every renewal fails; the request is still running.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const retry = await post(app, "/v1/other", { a: 1 }, KEY);
        release();

        expect(retry.status).toBe(409);
        expect(await errorCode(retry)).toBe("IDEMPOTENCY_KEY_IN_FLIGHT");
        const retryAfter = Number(retry.headers.get("Retry-After"));
        expect(retryAfter).toBeGreaterThanOrEqual(1);
        expect(retryAfter).toBeLessThanOrEqual(60);
        expect((await first).status).toBe(201);
        const replayed = await post(app, "/v1/other", { a: 1 }, KEY);
        expect(replayed.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
        expect(create).toHaveBeenCalledTimes(1);
      } finally {
        factory.mockRestore();
      }
    }
  );

  it("answers a store route's unrecorded outcome with a terminal 409 and never runs it twice", async () => {
    await withFailingCompletes(async () => {
      const { app, create } = buildApp(
        { key: "required", leaseSeconds: 1, maxLeaseRenewalSeconds: 1 },
        created
      );

      expect((await post(app, "/v1/other", { a: 1 }, KEY)).status).toBe(201);
      // Past the 1s lease and the 2s window (renewal cap plus lease).
      await new Promise((resolve) => setTimeout(resolve, 2500));
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const retry = await post(app, "/v1/other", { a: 1 }, KEY);
        expect(retry.status).toBe(409);
        expect(retry.headers.get("Retry-After")).toBeNull();
        expect(await errorCode(retry)).toBe("IDEMPOTENCY_KEY_OUTCOME_UNKNOWN");
      }
      expect(create).toHaveBeenCalledTimes(1);
      expect(await storedRows()).toMatchObject([{ status: "in_progress", response_status: null }]);
    });
  });

  it("answers a crashed store route's retry with the terminal 409", async () => {
    const { app, create } = buildApp({ key: "required" }, created);
    expect((await post(app, "/v1/other", { a: 1 }, KEY)).status).toBe(201);
    // A crash before the outcome was written: in progress, lease lapsed, never released.
    await getDb(env).execute(
      `UPDATE idempotency_keys
          SET status = 'in_progress', claim_token = 'crashed', locked_until = now() - interval '1 second', claimed_at = now() - interval '1 hour',
              response_status = NULL, response_headers = NULL, response_body = NULL`
    );

    const retry = await post(app, "/v1/other", { a: 1 }, KEY);
    expect(retry.status).toBe(409);
    expect(retry.headers.get("Retry-After")).toBeNull();
    expect(await errorCode(retry)).toBe("IDEMPOTENCY_KEY_OUTCOME_UNKNOWN");
    expect(create).toHaveBeenCalledTimes(1);
  });

  describe("on a store route that recovers from its domain row", () => {
    function recoveringApp(recovery: IdempotencyOptions["recovery"]) {
      const rows = new Map<string, { thing: { id: string } }>();
      const create = vi.fn((c: Context<{ Bindings: Env }>) => {
        const row = { thing: { id: `thing_${rows.size + 1}` } };
        const recordKey = getIdempotencyRecordKey(c);
        if (recordKey === undefined) throw new Error("expected a claimed key");
        rows.set(recordKey, row);
        return c.json(row, 201);
      });
      const app = testApp();
      app.post(
        "/v1/other",
        idempotent({
          key: "required",
          serverErrors: "store",
          recovery,
          leaseSeconds: 1,
          maxLeaseRenewalSeconds: 1,
        }),
        replayFromRecord(async (c, _input, recordKey) => {
          const row = rows.get(recordKey);
          return row === undefined ? null : { fingerprint: null, respond: () => c.json(row, 201) };
        }),
        (c) => create(c)
      );
      return { app, create };
    }

    it("takes over an unrecorded outcome and answers it from the row", async () => {
      await withFailingCompletes(async () => {
        const { app, create } = recoveringApp("record");
        const first = await post(app, "/v1/other", { a: 1 }, KEY);
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const retry = await post(app, "/v1/other", { a: 1 }, KEY);

        expect(retry.status).toBe(201);
        expect(await retry.json()).toEqual(await first.json());
        expect(create).toHaveBeenCalledTimes(1);
      });
    });

    it("never stores a record mismatch, so the original request's retry is still answered", async () => {
      const rows = new Map<string, { fingerprint: string; row: { thing: string } }>();
      const create = vi.fn((c: Context<{ Bindings: Env }>) => {
        const recordKey = getIdempotencyRecordKey(c);
        const fingerprint = getIdempotencyFingerprint(c);
        if (recordKey === undefined || fingerprint === undefined)
          throw new Error("expected a claim");
        rows.set(recordKey, { fingerprint, row: { thing: "original" } });
        return c.json({ thing: "original" }, 201);
      });
      const app = testApp();
      app.post(
        "/v1/other",
        idempotent({ key: "required", serverErrors: "store", recovery: "record" }),
        replayFromRecord(async (c, _input, recordKey) => {
          const found = rows.get(recordKey);
          return found === undefined
            ? null
            : { fingerprint: found.fingerprint, respond: () => c.json(found.row, 201) };
        }),
        (c) => create(c)
      );

      expect((await post(app, "/v1/other", { a: 1 }, KEY)).status).toBe(201);
      // The key's 24 hours pass; the domain row remains.
      await getDb(env).execute(
        "UPDATE idempotency_keys SET expires_at = now() - interval '1 second'"
      );
      const changed = await post(app, "/v1/other", { a: 2 }, KEY);
      expect(changed.status).toBe(422);
      expect(await errorCode(changed)).toBe("IDEMPOTENCY_KEY_REUSED");
      const original = await post(app, "/v1/other", { a: 1 }, KEY);

      expect(original.status).toBe(201);
      expect(await original.json()).toEqual({ thing: "original" });
      expect(original.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
      expect(create).toHaveBeenCalledTimes(1);
    });

    it("refuses the takeover without the option", async () => {
      await withFailingCompletes(async () => {
        const { app, create } = recoveringApp(undefined);
        await post(app, "/v1/other", { a: 1 }, KEY);
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const retry = await post(app, "/v1/other", { a: 1 }, KEY);

        expect(retry.status).toBe(409);
        expect(await errorCode(retry)).toBe("IDEMPOTENCY_KEY_OUTCOME_UNKNOWN");
        expect(create).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("does not store a refusal, so the same key runs again", async () => {
    let refuse = true;
    const { app, create } = buildApp({ key: "required" }, (c) => {
      if (refuse) throw badRequest("not yet");
      return c.json({ ok: true }, 201);
    });

    expect((await post(app, "/v1/other", { a: 1 }, KEY)).status).toBe(400);
    expect(await storedRows()).toEqual([]);
    refuse = false;
    const retried = await post(app, "/v1/other", { a: 1 }, KEY);

    expect(retried.status).toBe(201);
    expect(retried.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("stores a handler's 404 and replays it", async () => {
    const { app, create } = buildApp({ key: "required" }, () => {
      throw notFound("Thing");
    });
    expect((await post(app, "/v1/other", { a: 1 }, KEY)).status).toBe(404);
    const second = await post(app, "/v1/other", { a: 1 }, KEY);
    expect(second.status).toBe(404);
    expect(second.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("stores a 5xx by default", async () => {
    const { app, create } = buildApp({ key: "required" }, () => {
      throw new Error("upstream down");
    });
    expect((await post(app, "/v1/other", { a: 1 }, KEY)).status).toBe(500);
    const replayed = await post(app, "/v1/other", { a: 1 }, KEY);
    expect(replayed.status).toBe(500);
    expect(replayed.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("re-runs after a 5xx on a route that opts in, keeping the key bound to its request", async () => {
    let fail = true;
    const { app, create } = buildApp({ key: "required", serverErrors: "rerun" }, (c) => {
      if (fail) throw new Error("upstream down");
      return c.json({ ok: true }, 201);
    });

    expect((await post(app, "/v1/other", { a: 1 }, KEY)).status).toBe(500);
    expect((await post(app, "/v1/other", { a: 2 }, KEY)).status).toBe(422);
    fail = false;
    expect((await post(app, "/v1/other", { a: 1 }, KEY)).status).toBe(201);
    expect(create).toHaveBeenCalledTimes(2);
    expect(await storedRows()).toMatchObject([{ status: "completed", response_status: 201 }]);
  });

  it("keeps a taken-over key bound to its request when the retry is refused", async () => {
    let step = 0;
    const { app } = buildApp({ key: "required", serverErrors: "rerun" }, () => {
      step += 1;
      if (step === 1) throw new Error("upstream down");
      throw forbidden("paused");
    });
    await post(app, "/v1/other", { a: 1 }, KEY);
    expect((await post(app, "/v1/other", { a: 1 }, KEY)).status).toBe(403);
    expect((await post(app, "/v1/other", { a: 2 }, KEY)).status).toBe(422);
  });

  it("frees a fresh key when a composite step's own check throws a refusal", async () => {
    const app = testApp();
    let admit = false;
    app.post("/v1/composite", async (c) => {
      const res = await runIdempotency(
        c,
        async () => {
          if (!admit) throw forbidden("not admitted");
          c.res = c.json({ ok: true }, 201);
        },
        { key: "required", serverErrors: "store" }
      );
      return res ?? c.res;
    });

    expect((await post(app, "/v1/composite", { a: 1 }, KEY)).status).toBe(403);
    admit = true;
    expect((await post(app, "/v1/composite", { a: 2 }, KEY)).status).toBe(201);
  });

  it("stores a 5xx AppError thrown past a composite step's checks, like one inside the chain", async () => {
    const app = testApp();
    const run = vi.fn(async () => {
      throw new AppError("SERVICE_UNAVAILABLE");
    });
    app.post(
      "/v1/composite",
      async (c) =>
        (await runIdempotency(c, run, { key: "required", serverErrors: "store" })) ?? c.res
    );

    expect((await post(app, "/v1/composite", { a: 1 }, KEY)).status).toBe(503);
    const replayed = await post(app, "/v1/composite", { a: 1 }, KEY);
    expect(replayed.status).toBe(503);
    expect(replayed.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("never stores an error the app maps itself, so a corrected retry runs", async () => {
    const app = testApp();
    let fail = true;
    app.post("/v1/composite", async (c) => {
      const res = await runIdempotency(
        c,
        async () => {
          // Not an AppError: only the app's error handler knows its status.
          if (fail) throw new Error("package-level refusal");
          c.res = c.json({ ok: true }, 201);
        },
        { key: "required", serverErrors: "store" }
      );
      return res ?? c.res;
    });

    expect((await post(app, "/v1/composite", { a: 1 }, KEY)).status).toBe(500);
    fail = false;
    const retried = await post(app, "/v1/composite", { a: 1 }, KEY);
    expect(retried.status).toBe(201);
    expect(retried.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
  });

  it("stores the status alone when the body is too large, and never runs twice", async () => {
    const { app, create } = buildApp({ key: "required" }, (c) =>
      c.json({ blob: "x".repeat(MAX_STORED_RESPONSE_BYTES) }, 201)
    );
    expect((await post(app, "/v1/other", {}, KEY)).status).toBe(201);
    const replayed = await post(app, "/v1/other", {}, KEY);
    expect(replayed.status).toBe(201);
    expect(await replayed.text()).toBe("");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("refuses to run without an earlier authorize step", async () => {
    const { app, create } = buildApp({ key: "required" }, created);
    const res = await post(app, "/v1/other", { a: 1 }, { ...KEY, "x-test-skip-authorize": "1" });
    expect(res.status).toBe(500);
    expect(create).not.toHaveBeenCalled();
    expect(await storedRows()).toHaveLength(0);
  });

  it("refuses to run without project context, since every key belongs to a project", async () => {
    const { app, create } = buildApp({ key: "required" }, created);
    const res = await post(app, "/v1/other", { a: 1 }, { ...KEY, "x-test-skip-project": "1" });
    expect(res.status).toBe(500);
    expect(create).not.toHaveBeenCalled();
    expect(await storedRows()).toHaveLength(0);
  });

  it("runs the route's access check on a replay exactly as on a new request", async () => {
    let allowed = true;
    const create = vi.fn(created);
    const app = testApp();
    app.post(
      "/v1/other",
      authorize(() => {
        if (!allowed) throw forbidden("wallet no longer bound");
      }),
      idempotent({ key: "required", serverErrors: "store" }),
      (c) => create(c)
    );
    await post(app, "/v1/other", { a: 1 }, KEY);
    allowed = false;
    const refused = await post(app, "/v1/other", { a: 1 }, KEY);
    expect(refused.status).toBe(403);
    expect(refused.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    allowed = true;
    expect(
      (await post(app, "/v1/other", { a: 1 }, KEY)).headers.get(IDEMPOTENT_REPLAYED_HEADER)
    ).toBe("true");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("hands the handler the fingerprint of the request holding the key", async () => {
    const seen: Array<string | undefined> = [];
    const app = testApp();
    app.post("/v1/other", idempotent({ key: "accepted", serverErrors: "store" }), (c) => {
      seen.push(getIdempotencyFingerprint(c));
      return c.json({}, 201);
    });
    await post(app, "/v1/other", { a: 1 }, KEY);
    await post(app, "/v1/other", { a: 1 }, { "Idempotency-Key": "key-2" });
    await post(app, "/v1/other", { a: 1 });
    expect(seen[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).toBeUndefined();
  });

  it("hands the handler the claimed key only when this step claimed one", async () => {
    const seen: Array<ReturnType<typeof getIdempotencyClaim>> = [];
    const app = testApp();
    app.post("/v1/other", idempotent({ key: "accepted", serverErrors: "store" }), (c) => {
      seen.push(getIdempotencyClaim(c));
      return c.json({}, 201);
    });
    const unclaimed = new Hono<{ Bindings: Env }>();
    unclaimed.post("/v1/raw", (c) => {
      seen.push(getIdempotencyClaim(c));
      return c.json({}, 201);
    });

    await post(app, "/v1/other", { a: 1 }, KEY);
    await post(app, "/v1/other", { a: 1 });
    // A key header the step never claimed (no idempotent() on the route) is not a claim.
    await unclaimed.request(
      "/v1/raw",
      { method: "POST", headers: { ...KEY, "Content-Type": "application/json" }, body: "{}" },
      env
    );

    expect(seen[0]).toEqual({ key: "key-1", fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(seen[1]).toBeUndefined();
    expect(seen[2]).toBeUndefined();
  });

  it("fingerprints the body as the validator left it", async () => {
    const create = vi.fn(created);
    const app = testApp();
    app.post(
      "/v1/other",
      validateBody(z.object({ amount: z.string().transform((v) => String(Number(v))) })),
      idempotent({ key: "required", serverErrors: "store" }),
      (c) => create(c)
    );
    await post(app, "/v1/other", { amount: "1.0" }, KEY);
    const sameAmount = await post(app, "/v1/other", { amount: "1" }, KEY);
    expect(sameAmount.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("applies the route's canonicalize hook before fingerprinting", async () => {
    const { app, create } = buildApp(
      {
        key: "required",
        canonicalize: (body) => {
          // SAFETY: the test always sends a recipients array of strings.
          const { recipients, ...rest } = body as { recipients: string[] };
          return { ...rest, recipients: [...recipients].sort() };
        },
      },
      created
    );
    await post(app, "/v1/other", { recipients: ["b", "a"] }, KEY);
    const reordered = await post(app, "/v1/other", { recipients: ["a", "b"] }, KEY);
    expect(reordered.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
    expect(create).toHaveBeenCalledTimes(1);
  });
});
