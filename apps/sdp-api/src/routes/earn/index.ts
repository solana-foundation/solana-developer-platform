import { type Context, Hono, type Next } from "hono";
import { AppError } from "@/lib/errors";
import { isEarnEnabled } from "@/lib/feature-flags";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import type { Env } from "@/types/env";
import {
  createEarnProgram,
  createEarnProgramWithdrawal,
  getEarnProgram,
  getEarnProgramWithdrawal,
  listEarnProgramDeposits,
  listEarnPrograms,
  listEarnProgramWithdrawals,
  previewEarnProgramWithdrawal,
  retargetEarnProgram,
} from "./handlers/program";
import { getEarnStrategy, listEarnStrategies } from "./handlers/strategies";

const earn = new Hono<{ Bindings: Env }>();

// Gate the whole family behind the Earn feature flag until it is ready for
// prime time. Off by default; enable per-environment with EARN_ENABLED plus its
// parent MARKETS_ENABLED — isEarnEnabled owns that hierarchy, so no separate
// markets check belongs here.
async function requireEarnFeature(c: Context<{ Bindings: Env }>, next: Next) {
  if (!isEarnEnabled(c.env)) {
    throw new AppError("FORBIDDEN", "Earn is not enabled for this environment");
  }
  await next();
}

earn.use("*", requireEarnFeature);
earn.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
earn.use("*", projectContextMiddleware());

// Strategy catalogue (source: DB, written only by the sync cron + dev seed).
earn.get("/strategies", requirePermissions("earn:read"), listEarnStrategies);
earn.get("/strategies/:strategyId", requirePermissions("earn:read"), getEarnStrategy);

// Portfolio programs: N provider wallets per org+environment+provider
// (PRO-1670), each addressed by its own id. Money-in (create, re-target) takes
// the full availability gate inside the handler; the withdrawal endpoints only
// require provider credentials (ADR 0002 exit safety — disabling a provider must
// never trap funds). Source of truth per route: list/get/deposits/
// withdrawal-detail read the provider LIVE; the withdrawals LIST reads the SDP
// ledger (earn_program_withdrawals) and takes no provider gate at all — the
// audit trail outlives credential removal.
//
// The collection is declared BEFORE the `:programId` routes so a literal
// segment can never be captured as an id.
earn.get("/programs", requirePermissions("earn:read"), listEarnPrograms);
earn.post("/programs", requirePermissions("earn:write"), createEarnProgram);
earn.get("/programs/:programId", requirePermissions("earn:read"), getEarnProgram);
earn.put("/programs/:programId", requirePermissions("earn:write"), retargetEarnProgram);
earn.get("/programs/:programId/deposits", requirePermissions("earn:read"), listEarnProgramDeposits);
earn.post(
  "/programs/:programId/withdrawal-preview",
  requirePermissions("earn:read"),
  previewEarnProgramWithdrawal
);
earn.post(
  "/programs/:programId/withdrawals",
  requirePermissions("earn:write"),
  createEarnProgramWithdrawal
);
earn.get(
  "/programs/:programId/withdrawals",
  requirePermissions("earn:read"),
  listEarnProgramWithdrawals
);
earn.get(
  "/programs/:programId/withdrawals/:withdrawalRef",
  requirePermissions("earn:read"),
  getEarnProgramWithdrawal
);

export default earn;
