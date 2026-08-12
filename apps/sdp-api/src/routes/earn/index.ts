import { type Context, Hono, type Next } from "hono";
import { AppError } from "@/lib/errors";
import { isEarnEnabled } from "@/lib/feature-flags";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import type { Env } from "@/types/env";
import {
  createEarnProgramWithdrawal,
  getEarnProgram,
  getEarnProgramWithdrawal,
  listEarnProgramDeposits,
  listEarnProgramWithdrawals,
  previewEarnProgramWithdrawal,
  upsertEarnProgram,
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

// Shared portfolio program: ONE provider wallet per org+environment+provider.
// PUT (money in) takes the full availability gate inside the handler; the
// withdrawal endpoints only require provider credentials (ADR 0002 exit
// safety — disabling a provider must never trap funds). Source of truth per
// route: program/deposits/withdrawal-detail read the provider LIVE; the
// withdrawals LIST reads the SDP ledger (earn_program_withdrawals) and takes
// no provider gate at all — the audit trail outlives credential removal.
earn.put("/program", requirePermissions("earn:write"), upsertEarnProgram);
earn.get("/program", requirePermissions("earn:read"), getEarnProgram);
earn.get("/program/deposits", requirePermissions("earn:read"), listEarnProgramDeposits);
earn.post(
  "/program/withdrawal-preview",
  requirePermissions("earn:read"),
  previewEarnProgramWithdrawal
);
earn.post("/program/withdrawals", requirePermissions("earn:write"), createEarnProgramWithdrawal);
earn.get("/program/withdrawals", requirePermissions("earn:read"), listEarnProgramWithdrawals);
earn.get(
  "/program/withdrawals/:withdrawalRef",
  requirePermissions("earn:read"),
  getEarnProgramWithdrawal
);

export default earn;
