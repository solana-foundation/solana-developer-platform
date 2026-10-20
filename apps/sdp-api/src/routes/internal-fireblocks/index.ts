import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { badRequest } from "@/lib/errors";
import { success } from "@/lib/response";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { enforceMeteredQuota } from "@/middleware/metered-quota";
import { projectContextMiddleware } from "@/middleware/project-context";
import { assertCallerMayPerform, requireAction } from "@/middleware/require-action";
import { checkFireblocksDestination } from "@/services/custody/fireblocks-address-book.service";
import { checkFireblocksPolicy } from "@/services/custody/fireblocks-policy.service";
import type { Env } from "@/types/env";

const input = z
  .object({
    walletId: z.string().min(1).max(200),
    counterpartyId: z.string().min(1).max(200),
    accountId: z.string().min(1).max(200),
    address: z.string().min(32).max(44),
    token: z.string().min(1).max(64),
  })
  .strict();
export const internalFireblocks = new Hono<{ Bindings: Env }>();
const policySelection = input.extend({
  amount: z
    .string()
    .max(100)
    .regex(/^\d+(\.\d+)?$/),
});
internalFireblocks.use("*", bodyLimit({ maxSize: 4096 }));
internalFireblocks.use("*", unifiedAuthMiddleware());
internalFireblocks.use("*", projectContextMiddleware());

internalFireblocks.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
internalFireblocks.get("/destination", requireAction("wallets.read"), async (c) => {
  assertCallerMayPerform(c, "counterparties.read");
  const parsed = input.safeParse(c.req.query());
  if (!parsed.success) throw badRequest("Invalid Fireblocks destination");
  await enforceMeteredQuota(c, { name: "fireblocks-destination", actorMax: 60, orgMax: 300 });
  return success(c, await checkFireblocksDestination(c, parsed.data));
});
internalFireblocks.get("/policy", requireAction("wallets.read"), async (c) => {
  assertCallerMayPerform(c, "counterparties.read");
  const parsed = policySelection.safeParse(c.req.query());
  if (!parsed.success) throw badRequest("Invalid Fireblocks payment selection");
  await enforceMeteredQuota(c, { name: "fireblocks-policy-check", actorMax: 60, orgMax: 300 });
  return success(c, await checkFireblocksPolicy(c, parsed.data));
});
