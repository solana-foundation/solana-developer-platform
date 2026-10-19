import { Hono } from "hono";
import { requirePermissions } from "@/middleware/auth";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { cancelRampTransfer, simulateSandboxTransfer } from "./handlers";
import { offramp } from "./offramp";
import { onramp } from "./onramp";
import { cancelRampTransferSchema, simulateSandboxTransferSchema } from "./schemas";

export const ramps = new Hono<{ Bindings: Env }>();

ramps.route("/onramp", onramp);
ramps.route("/offramp", offramp);
ramps.post(
  "/transfers/cancel",
  requirePermissions("payments:write"),
  validateBody(cancelRampTransferSchema),
  cancelRampTransfer
);
ramps.post(
  "/sandbox/simulate",
  requirePermissions("payments:write"),
  validateBody(simulateSandboxTransferSchema),
  simulateSandboxTransfer
);
