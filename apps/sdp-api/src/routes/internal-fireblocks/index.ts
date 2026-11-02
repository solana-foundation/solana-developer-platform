import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { badRequest } from "@/lib/errors";
import { success } from "@/lib/response";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { requireHumanSession } from "@/middleware/human-session";
import { enforceMeteredQuota } from "@/middleware/metered-quota";
import { projectContextMiddleware } from "@/middleware/project-context";
import { assertCallerMayPerform, requireAction } from "@/middleware/require-action";
import { checkFireblocksDestination } from "@/services/custody/fireblocks-address-book.service";
import type { Env } from "@/types/env";
import { fireblocksDestinationQuerySchema } from "./schemas";

export const internalFireblocks = new Hono<{ Bindings: Env }>();
internalFireblocks.use("*", bodyLimit({ maxSize: 4096 }));
internalFireblocks.use("*", unifiedAuthMiddleware());
internalFireblocks.use("*", requireHumanSession());
internalFireblocks.use("*", projectContextMiddleware());

internalFireblocks.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
internalFireblocks.get("/destination-eligibility", requireAction("wallets.read"), async (c) => {
  assertCallerMayPerform(c, "counterparties.read");
  const parsed = fireblocksDestinationQuerySchema.safeParse(c.req.query());
  if (!parsed.success) throw badRequest("Invalid Fireblocks destination");
  await enforceMeteredQuota(c, { name: "fireblocks-destination", actorMax: 60, orgMax: 300 });
  return success(c, await checkFireblocksDestination(c, parsed.data));
});
