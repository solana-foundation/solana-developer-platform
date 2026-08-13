import type { Permission } from "@sdp/types";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import type { KVStoreSet } from "@/runtime/kv";
import { env } from "@/test/helpers/env";
import { clearKVStores, readRateLimitCount, seedRateLimit } from "@/test/mocks/kv";
import type { Env } from "@/types/env";
import { kvStoreMiddleware } from "./kv-store";
import { meteredQuota } from "./metered-quota";

const ORG_ID = "org_metered_quota_test";
const QUOTA = { name: "test-op", actorMax: 3, orgMax: 5 };

const ORG_SCOPE = `metered:${QUOTA.name}:org:${ORG_ID}`;

type Actor = { kind: "key"; id: string } | { kind: "user"; id: string };

function apiKeyContext(keyId: string) {
  return {
    id: keyId,
    organizationId: ORG_ID,
    projectId: "prj_metered_quota_test",
    role: "api_admin",
    permissions: ["*"] as Permission[],
    environment: "sandbox" as const,
    signingWalletId: null,
    signingWalletIds: [],
    walletBindings: [],
  };
}

function clerkContext(userId: string) {
  return {
    userId,
    organizationId: ORG_ID,
    role: "admin",
    permissions: [] as Permission[],
    clerkUserId: `clerk_${userId}`,
    clerkOrgId: "clerk_org_metered",
    email: null,
    orgSlug: null,
    orgRole: null,
  };
}

function createQuotaApp(options: { actor: Actor; kv?: "store" | "broken" | "missing" }) {
  const app = new Hono<{ Bindings: Env }>();

  if ((options.kv ?? "store") === "store") {
    app.use("*", kvStoreMiddleware());
  } else if (options.kv === "broken") {
    app.use("*", async (c, next) => {
      c.set("kv", {
        rateLimits: {
          admitSlidingWindow: () => Promise.reject(new Error("kv down")),
        },
      } as unknown as KVStoreSet);
      await next();
    });
  }

  app.use("*", async (c, next) => {
    if (options.actor.kind === "key") {
      c.set("apiKey", apiKeyContext(options.actor.id));
    } else {
      c.set("clerk", clerkContext(options.actor.id));
    }
    await next();
  });

  app.use("*", meteredQuota(QUOTA));
  app.get("/op", (c) => c.json({ ok: true }));
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(error.toResponse(), error.statusCode as 429 | 503);
    }
    throw error;
  });

  return app;
}

async function requestOp(app: Hono<{ Bindings: Env }>): Promise<Response> {
  return await app.request("/op", {}, env);
}

describe("meteredQuota", () => {
  afterEach(async () => {
    await clearKVStores(env);
  });

  it("admits under both quotas and charges the actor and org counters", async () => {
    const app = createQuotaApp({ actor: { kind: "key", id: "key_a" } });

    const res = await requestOp(app);

    expect(res.status).toBe(200);
    expect(await readRateLimitCount(env, `${ORG_SCOPE}:key:key_a`)).toBe(1);
    expect(await readRateLimitCount(env, ORG_SCOPE)).toBe(1);
  });

  it("isolates actor quotas: one exhausted actor does not block another", async () => {
    await seedRateLimit(env, `${ORG_SCOPE}:key:key_a`, QUOTA.actorMax);

    const blocked = await requestOp(createQuotaApp({ actor: { kind: "key", id: "key_a" } }));
    const allowed = await requestOp(createQuotaApp({ actor: { kind: "key", id: "key_b" } }));

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).not.toBeNull();
    expect(allowed.status).toBe(200);
  });

  it("does not charge the org pool for requests the actor quota rejected", async () => {
    await seedRateLimit(env, `${ORG_SCOPE}:key:key_a`, QUOTA.actorMax);

    const res = await requestOp(createQuotaApp({ actor: { kind: "key", id: "key_a" } }));

    expect(res.status).toBe(429);
    expect(await readRateLimitCount(env, ORG_SCOPE)).toBe(0);
  });

  it("enforces the org ceiling across actors", async () => {
    await seedRateLimit(env, ORG_SCOPE, QUOTA.orgMax);

    const res = await requestOp(createQuotaApp({ actor: { kind: "key", id: "key_fresh" } }));

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
  });

  it("keys dashboard actors by user id", async () => {
    await seedRateLimit(env, `${ORG_SCOPE}:user:usr_1`, QUOTA.actorMax);

    const blocked = await requestOp(createQuotaApp({ actor: { kind: "user", id: "usr_1" } }));
    const allowed = await requestOp(createQuotaApp({ actor: { kind: "user", id: "usr_2" } }));

    expect(blocked.status).toBe(429);
    expect(allowed.status).toBe(200);
  });

  it("fails closed with a 503 when the counter store errors", async () => {
    const res = await requestOp(
      createQuotaApp({ actor: { kind: "key", id: "key_a" }, kv: "broken" })
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("fails closed with a 503 when no counter store is bound", async () => {
    const res = await requestOp(
      createQuotaApp({ actor: { kind: "key", id: "key_a" }, kv: "missing" })
    );

    expect(res.status).toBe(503);
  });
});
