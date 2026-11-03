import { Hono } from "hono";
import { AppError } from "@/lib/errors";
import { mapErrorStatusCode } from "@/lib/response";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import type { KVStore, KVStoreSet } from "@/runtime/kv";
import type { Env } from "@/types/env";

/**
 * From TEST-NET-3 (203.0.113.0/24, RFC 5737), never publicly routable. It must
 * be a syntactically valid IP: getClientIp drops x-forwarded-for entries that
 * fail isIP(), which would move a test to the "unknown" bucket.
 */
export const TEST_CLIENT_IP = "203.0.113.7";

/**
 * How a middleware test app binds `c.var.kv`: the worker's Redis through
 * kvStoreMiddleware, a store whose every call fails as during a Redis outage,
 * or nothing at all.
 */
export type MiddlewareTestKv = "store" | "unavailable" | "none";

/** A counter store whose every call fails, as during a Redis outage. */
function unavailableKvStoreSet(): KVStoreSet {
  const down = () => Promise.reject(new Error("kv down"));
  const store: KVStore = {
    get: down,
    put: down,
    delete: down,
    compareAndSet: down,
    compareAndDelete: down,
    list: down,
    admitSlidingWindow: down,
  };
  return { rateLimits: store, cache: store };
}

/**
 * A bare Hono app for middleware tests: a thrown AppError answers with its own
 * status and envelope, any other error propagates to the test, and the counter
 * store is bound as asked before the caller mounts its middleware and routes.
 *
 * @param kv - How the app binds the counter store.
 * @returns The app, ready for the middleware and routes under test.
 */
export function middlewareTestApp(kv: MiddlewareTestKv): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toResponse(), mapErrorStatusCode(err.statusCode));
    }
    throw err;
  });
  switch (kv) {
    case "store":
      app.use("*", kvStoreMiddleware());
      break;
    case "unavailable":
      app.use("*", async (c, next) => {
        c.set("kv", unavailableKvStoreSet());
        await next();
      });
      break;
    case "none":
      break;
    default: {
      const unhandled: never = kv;
      throw new Error(`Unhandled kv binding: ${unhandled}`);
    }
  }
  return app;
}
