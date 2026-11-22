import { FORWARD_HEADERS, type SafeProxyCode } from "@sdp/safe-proxy-endpoints/protocol";
import type { SafeProxyReadiness } from "@sdp/types/safe-proxy";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  type AppEnv,
  createForwardHandler,
  FORWARD_ROUTE,
  type ForwardDependencies,
  readRequestId,
} from "./forward";
import { Refusal } from "./refusal";
import { requestLogLine, type WriteRequestLog } from "./request-log";
import { failureOutcome, type RequestOutcome } from "./request-result";

export interface AppDependencies extends ForwardDependencies {
  writeRequestLog: WriteRequestLog;
  readiness: () => SafeProxyReadiness;
  revision: string;
}

const OWN_ANSWER_STATUS = {
  unknown_route: 404,
  unauthenticated: 401,
  caller_check_unavailable: 503,
  invalid_request: 400,
  provider_not_allowed: 403,
  endpoint_not_allowed: 403,
  body_not_allowed: 403,
  caller_not_allowed: 403,
  credential_store_unavailable: 501,
  deadline_exceeded: 504,
  internal: 500,
  provider_no_answer: 502,
  provider_answer_too_large: 502,
} as const satisfies Record<SafeProxyCode, ContentfulStatusCode>;

export function createApp(dependencies: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const forward = createForwardHandler(dependencies);

  // The clock starts on receipt, before anything is checked.
  app.use(async (c, next) => {
    c.set("receivedAt", dependencies.now());
    c.set("requestId", readRequestId(c.req.header(FORWARD_HEADERS.requestId)));
    c.set("progress", { stage: "received" });
    await next();
  });

  function logRequest(c: Context<AppEnv>, outcome: RequestOutcome): void {
    dependencies.writeRequestLog(
      requestLogLine({
        requestId: c.get("requestId"),
        progress: c.get("progress"),
        outcome,
        durationMs: dependencies.now() - c.get("receivedAt"),
        revision: dependencies.revision,
      })
    );
  }

  // Liveness is constant and touches no dependency.
  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/health/ready", (c) => {
    const readiness = dependencies.readiness();
    switch (readiness) {
      case "starting":
        return c.json({ status: "starting" }, 503);
      case "ready":
        return c.json({ service: "sdp-safe-proxy", revision: dependencies.revision });
      default: {
        const unreachable: never = readiness;
        return unreachable;
      }
    }
  });

  app.all(FORWARD_ROUTE, async (c) => {
    const answer = await forward(c);
    logRequest(c, { result: "forwarded" });
    return answer;
  });

  app.notFound(() => {
    throw new Refusal("unknown_route");
  });

  // Every failure is answered and logged here, from how far the request got.
  app.onError((error, c) => {
    const outcome = failureOutcome(error, c.get("progress"));
    logRequest(c, outcome);
    return c.json({ code: outcome.code }, OWN_ANSWER_STATUS[outcome.code], {
      [FORWARD_HEADERS.result]: outcome.result,
    });
  });

  return app;
}
