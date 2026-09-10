import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { ApiErrorBody } from "../src/types.ts";
import { DEMO_SESSION_HEADER, hasValidDemoSession } from "./demo-session.ts";
import { deposit, loadDashboard, withdraw } from "./embedded-yield.ts";
import { getConfig } from "./env.ts";
import { SdpApiError } from "./sdp-client.ts";

const app = new Hono();
const config = getConfig();

const depositSchema = z.object({
  strategyId: z.string().min(1),
  amount: z.string().min(1).max(128),
});
const withdrawalSchema = z.object({
  positionId: z.string().min(1),
  shares: z.string().min(1).max(128),
});

app.use("/api/*", async (context, next) => {
  if (
    !hasValidDemoSession(
      context.req.header(DEMO_SESSION_HEADER),
      config.NORTHSTAR_DEMO_SESSION_TOKEN
    )
  ) {
    return context.json(
      {
        error: {
          code: "DEMO_UNAUTHORIZED",
          message: "Access Northstar through its local Vite application",
        },
      } satisfies ApiErrorBody,
      401
    );
  }

  await next();
});

app.get("/api/health", async (context) => {
  const config = getConfig();
  const response = await fetch(
    `${config.SDP_API_BASE_URL.replace(/\/$/, "")}/health`
  );
  return context.json({ ok: response.ok }, response.ok ? 200 : 503);
});

app.get("/api/dashboard", async (context) =>
  context.json({ data: await loadDashboard() })
);

app.post("/api/deposits", async (context) => {
  const input = depositSchema.parse(await context.req.json());
  return context.json({
    data: { movement: await deposit(input.strategyId, input.amount) },
  });
});

app.post("/api/withdrawals", async (context) => {
  const input = withdrawalSchema.parse(await context.req.json());
  return context.json({
    data: { movement: await withdraw(input.positionId, input.shares) },
  });
});

app.onError((error, context) => {
  console.error(
    error instanceof SdpApiError
      ? `SDP ${error.status} ${error.code ?? ""}: ${error.message}`
      : error
  );
  const body: ApiErrorBody = {
    error: {
      code:
        error instanceof SdpApiError
          ? (error.code ?? "SDP_REQUEST_FAILED")
          : "DEMO_REQUEST_FAILED",
      message: error instanceof Error ? error.message : "Unexpected demo error",
    },
  };
  const status =
    error instanceof z.ZodError
      ? 400
      : error instanceof SdpApiError
        ? error.status
        : 500;
  const responseStatus = (
    status >= 400 && status <= 599 ? status : 500
  ) as ContentfulStatusCode;
  return context.json(body, responseStatus);
});

serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.DEMO_API_PORT });
console.log(
  `Northstar demo API listening on http://127.0.0.1:${config.DEMO_API_PORT}`
);
