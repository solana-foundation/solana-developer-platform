import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { LOCAL_CALLER_HEADER } from "@/caller";
import { type DispatchDependencies, dispatch } from "@/dispatch";

const MAX_BODY_BYTES = 256 * 1024;

export function createApp(dependencies: DispatchDependencies): Hono {
  const app = new Hono();

  // Liveness and readiness are the same thing here: the service holds no connection to wait for.
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/health/ready", (c) => c.json({ status: "ok" }));

  const answerCall = async (c: Context, body: unknown) => {
    const answer = await dispatch(dependencies, {
      section: c.req.param("section") ?? "",
      name: c.req.param("name") ?? "",
      credentials: {
        authorization: c.req.header("authorization"),
        localCaller: c.req.header(LOCAL_CALLER_HEADER),
      },
      body,
    });
    // SAFETY: dispatch answers 200 or a status from SAFE_PROXY_ERROR_HTTP_STATUS, all of which
    // carry a body.
    return c.json(answer.body, answer.status as ContentfulStatusCode);
  };

  app.post(
    "/v1/call/:section/:name",
    // A body that is too large or is not JSON reaches dispatch as undefined. It is refused there
    // as invalid_request, after the caller check, and logged like any other request.
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => answerCall(c, undefined) }),
    async (c) => answerCall(c, await c.req.json().catch(() => undefined))
  );

  return app;
}
