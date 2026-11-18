import { type Context, Hono, type Next } from "hono";
import { presentsApiKey } from "@/lib/api-key-format";
import { AppError } from "@/lib/errors";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { authorize } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { meteredQuota } from "@/middleware/metered-quota";
import { projectContextMiddleware } from "@/middleware/project-context";
import { requireAction } from "@/middleware/require-action";
import { validateBody } from "@/middleware/validate";
import { createEarnOnboardingRoutes } from "@/routes/earn-onboarding";
import type { Env } from "@/types/env";
import {
  authorizeEarnDeposit,
  authorizeEarnWithdrawal,
  prepareEarnOperation,
} from "./core/prepare";
import { listEarnDiscovery, listEarnPositions } from "./core/read";
import { prepareEarnDepositSchema, prepareEarnWithdrawalSchema } from "./core/schemas";
import { isEarnExitOrRead } from "./exits";

export const earnRoutes = new Hono<{ Bindings: Env }>();
const earn = new Hono<{ Bindings: Env }>();
const earnProjectContextOptions = {
  allowUnentitledProduction: (c: Context<{ Bindings: Env }>) =>
    isEarnExitOrRead(c.req.method, c.req.path),
};

async function cacheEarnCatalogue(c: Context<{ Bindings: Env }>, next: Next) {
  await next();
  if (c.res.status >= 200 && c.res.status < 300) c.header("Cache-Control", "private, max-age=30");
}

// Authenticate before project context so absent credentials receive 401.
async function requireKeyedEarnCredential(c: Context<{ Bindings: Env }>, next: Next) {
  if (!c.req.header("Authorization") && !presentsApiKey(c))
    throw new AppError("UNAUTHORIZED", "API key required for this Earn route");
  await next();
}

earn.use("*", requireKeyedEarnCredential);
earn.use("*", unifiedAuthMiddleware());
earn.use("*", projectContextMiddleware(earnProjectContextOptions));
earn.get("/discovery", requireAction("earn.read"), cacheEarnCatalogue, listEarnDiscovery);
earn.get(
  "/positions",
  requireAction("earn.read"),
  meteredQuota({ name: "earn-chain-read", actorMax: 30, orgMax: 120 }),
  listEarnPositions
);
earn.post(
  "/deposit",
  requireAction("earn.execute"),
  validateBody(prepareEarnDepositSchema),
  authorize(authorizeEarnDeposit),
  idempotent({ key: "required", serverErrors: "rerun" }),
  meteredQuota({ name: "earn-provider-read", actorMax: 60, orgMax: 240 }),
  prepareEarnOperation
);
// Exit preparation stays available when deposit entitlement or quota is lost.
earn.post(
  "/withdraw",
  requireAction("earn.execute"),
  validateBody(prepareEarnWithdrawalSchema),
  authorize(authorizeEarnWithdrawal),
  idempotent({ key: "required", serverErrors: "rerun" }),
  prepareEarnOperation
);
earn.route("/onboarding/wisdomtree", createEarnOnboardingRoutes("wisdomtree"));
earnRoutes.route("/", earn);
