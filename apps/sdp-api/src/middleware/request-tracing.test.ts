import { createHash } from "node:crypto";
import { type Context, Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as logger from "@/runtime/logger";
import { TEST_API_KEY, TEST_SEEDED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PROJECT } from "@/test/fixtures/tokens";
import { recordLoggedEvents } from "@/test/helpers/log-events";
import type { Env } from "@/types/env";
import { localRateLimit } from "./local-rate-limit";
import { requestIdMiddleware } from "./request-id";
import { requestTracingMiddleware } from "./request-tracing";

afterEach(() => vi.restoreAllMocks());

function captureLogs() {
  const testLogger = logger.rootLogger.child({});
  const info = vi.spyOn(testLogger, "info").mockImplementation(() => undefined);
  const warn = vi.spyOn(testLogger, "warn").mockImplementation(() => undefined);
  vi.spyOn(logger, "getLogger").mockReturnValue(testLogger);
  return { info, warn };
}

describe("requestTracingMiddleware", () => {
  it("logs a route template without the requested resource ID", async () => {
    const { info } = captureLogs();
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", requestIdMiddleware());
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

  it("replaces inbound IDs and bounds the source before logging", async () => {
    const { info } = captureLogs();
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", requestIdMiddleware());
    app.use("*", requestTracingMiddleware());
    app.get("/v1/wallets/:walletId", (c) => c.text("ok"));

    const response = await app.request("https://example.test/v1/wallets/secret-wallet", {
      headers: {
        "X-Request-ID": "sk_live_exposed",
        "X-SDP-Trace-ID": "sk_live_exposed",
        "X-SDP-Trace-Source": "route.dashboard.sk_live_exposed",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-ID")).toMatch(/^req_[0-9a-f-]{36}$/);
    expect(response.headers.get("X-SDP-Trace-ID")).toBe(response.headers.get("X-Request-ID"));
    expect(info.mock.calls[0]?.[0]).toMatchObject({ source: "dashboard" });
    expect(JSON.stringify(info.mock.calls[0]?.[0])).not.toContain("sk_live_exposed");
  });

  it("joins a generated web trace by hash while keeping independent API IDs", async () => {
    const { info } = captureLogs();
    const contexts: logger.LogContext[] = [];
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", requestIdMiddleware());
    app.use("*", requestTracingMiddleware());
    app.get("/join", (c) => {
      contexts.push(logger.getLogContext());
      return c.text("ok");
    });
    const webTraceId = `web_${"a".repeat(32)}`;

    const response = await app.request("https://example.test/join", {
      headers: { "X-SDP-Trace-ID": webTraceId },
    });

    const expectedHash = createHash("sha256").update(webTraceId).digest("hex");
    expect(contexts).toEqual([
      {
        request_id: response.headers.get("X-Request-ID"),
        trace_id: response.headers.get("X-Request-ID"),
        web_trace_hash: expectedHash,
        route: "GET /join",
      },
    ]);
    expect(response.headers.get("X-SDP-Trace-ID")).toBe(response.headers.get("X-Request-ID"));
    expect(JSON.stringify(info.mock.calls)).not.toContain(webTraceId);
  });

  it("ignores oversized and malformed correlation headers", async () => {
    const { info } = captureLogs();
    const contexts: logger.LogContext[] = [];
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", requestIdMiddleware());
    app.use("*", requestTracingMiddleware());
    app.get("/join", (c) => {
      contexts.push(logger.getLogContext());
      return c.text("ok");
    });
    const oversized = `web_${"b".repeat(32)}${"secret".repeat(80)}`;
    const malformed = "sk_live_exposed";

    await app.request("https://example.test/join", {
      headers: { "X-SDP-Trace-ID": oversized },
    });
    await app.request("https://example.test/join", {
      headers: { "X-SDP-Trace-ID": malformed },
    });

    expect(contexts.every((context) => context.web_trace_hash === undefined)).toBe(true);
    expect(JSON.stringify([contexts, info.mock.calls])).not.toContain(oversized);
    expect(JSON.stringify([contexts, info.mock.calls])).not.toContain(malformed);
  });

  it("keeps a successful response when the request log sink fails", async () => {
    vi.spyOn(logger, "getLogger").mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", requestIdMiddleware());
    app.use("*", requestTracingMiddleware());
    app.get("/ok", (c) => c.text("ok"));

    const response = await app.request("https://example.test/ok");

    expect(response.status).toBe(200);
    expect(response.headers.get("X-SDP-Trace-ID")).toBe(response.headers.get("X-Request-ID"));
  });

  describe("the settled identity on the timing line", () => {
    const loggedEvents = recordLoggedEvents(["sdp_api_request_timing"]);
    const session = {
      clerkUserId: "user_clerk_timing",
      clerkOrgId: "org_clerk_timing",
      orgSlug: null,
      email: TEST_USER.email,
    };
    const onProject = (c: Context<{ Bindings: Env }>) => {
      c.set("projectId", TEST_PROJECT.id);
      c.set("projectEnvironment", TEST_PROJECT.environment);
    };
    const project = {
      organization_id: TEST_ORG.id,
      project_id: TEST_PROJECT.id,
      environment: TEST_PROJECT.environment,
    };

    it.each<[string, (c: Context<{ Bindings: Env }>) => void, Record<string, string | null>]>([
      [
        "a signed-in member",
        (c) => {
          c.set("clerk", {
            ...session,
            userId: TEST_USER.id,
            organizationId: TEST_ORG.id,
            role: "admin",
          });
          onProject(c);
        },
        { ...project, user_id: TEST_USER.id, api_key_id: null, auth_type: "clerk" },
      ],
      [
        "an API key",
        (c) => {
          c.set("apiKey", {
            id: TEST_API_KEY.id,
            organizationId: TEST_ORG.id,
            projectId: TEST_PROJECT.id,
            grants: TEST_SEEDED_API_KEY.grants,
            environment: TEST_PROJECT.environment,
            walletAccess: { scope: "all" },
          });
          onProject(c);
        },
        { ...project, user_id: null, api_key_id: TEST_API_KEY.id, auth_type: "api_key" },
      ],
      [
        "a signup session",
        (c) =>
          c.set("clerkSignup", {
            userId: TEST_USER.id,
            clerkUserId: session.clerkUserId,
            email: TEST_USER.email,
          }),
        { user_id: TEST_USER.id },
      ],
      [
        "an onboarding session",
        (c) => c.set("clerkOnboarding", { ...session, organizationId: TEST_ORG.id }),
        { organization_id: TEST_ORG.id },
      ],
      ["an unauthenticated request", () => undefined, {}],
    ])("carries what %s settled", async (_, settle, identity) => {
      const app = new Hono<{ Bindings: Env }>();
      app.use("*", requestIdMiddleware());
      app.use("*", requestTracingMiddleware());
      app.use("*", async (c, next) => {
        settle(c);
        await next();
      });
      app.get("/settled", (c) => c.text("ok"));

      expect((await app.request("https://example.test/settled")).status).toBe(200);
      expect(loggedEvents()).toEqual([
        {
          severity: "INFO",
          event: "sdp_api_request_timing",
          source: "unknown",
          method: "GET",
          path: "/settled",
          status: 200,
          duration_ms: expect.any(Number),
          ...identity,
        },
      ]);
    });
  });

  it("keeps unmatched path and query secrets out of timing and rate-limit logs", async () => {
    const { info, warn } = captureLogs();
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", requestIdMiddleware());
    app.use("*", requestTracingMiddleware());
    app.use(
      "*",
      localRateLimit({
        name: "privacy-test",
        maxRequests: 1,
        windowMs: 60_000,
        maxTrackedKeys: 1,
      })
    );
    app.onError((_error, c) => c.text("limited", 429));
    const url = "https://example.test/sk_path_secret?api_key=sk_query_secret";

    expect((await app.request(url)).status).toBe(404);
    expect((await app.request(url)).status).toBe(429);

    const logged = JSON.stringify([info.mock.calls, warn.mock.calls]);
    expect(logged).not.toContain("sk_path_secret");
    expect(logged).not.toContain("sk_query_secret");
    expect(warn).toHaveBeenCalledOnce();
  });
});
