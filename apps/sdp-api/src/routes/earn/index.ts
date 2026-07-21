import { type Context, Hono, type Next } from "hono";
import { AppError } from "@/lib/errors";
import { isEarnEnabled } from "@/lib/feature-flags";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import type { Env } from "@/types/env";
import { getEarnMovement, listEarnMovements } from "./handlers/movements";
import { getEarnPosition, listEarnPositions } from "./handlers/positions";
import { quoteEarnDeposit, quoteEarnWithdrawal } from "./handlers/quotes";
import {
  getEarnStrategy,
  getEarnStrategyNavHistory,
  listEarnStrategies,
} from "./handlers/strategies";

const earn = new Hono<{ Bindings: Env }>();

// Gate the whole family behind the Earn feature flag until it is ready for
// prime time. Off by default; enable per-environment via EARN_ENABLED.
async function requireEarnFeature(c: Context<{ Bindings: Env }>, next: Next) {
  if (!isEarnEnabled(c.env)) {
    throw new AppError("FORBIDDEN", "Earn is not enabled for this environment");
  }
  await next();
}

earn.use("*", requireEarnFeature);
earn.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
earn.use("*", projectContextMiddleware());

// Strategy catalogue.
earn.get("/strategies", requirePermissions("earn:read"), listEarnStrategies);
earn.get("/strategies/:strategyId", requirePermissions("earn:read"), getEarnStrategy);
earn.get("/strategies/:strategyId/nav", requirePermissions("earn:read"), getEarnStrategyNavHistory);

// Rate previews. Execution endpoints (POST /deposits, POST /withdrawals) land
// with the first real provider integration — they additionally need wallet
// resolution, custody signing, and movement persistence.
earn.post("/deposits/quote", requirePermissions("earn:read"), quoteEarnDeposit);
earn.post("/withdrawals/quote", requirePermissions("earn:read"), quoteEarnWithdrawal);

// Positions and the deposit/withdrawal ledger.
earn.get("/positions", requirePermissions("earn:read"), listEarnPositions);
earn.get("/positions/:positionId", requirePermissions("earn:read"), getEarnPosition);
earn.get("/movements", requirePermissions("earn:read"), listEarnMovements);
earn.get("/movements/:movementId", requirePermissions("earn:read"), getEarnMovement);

export default earn;
