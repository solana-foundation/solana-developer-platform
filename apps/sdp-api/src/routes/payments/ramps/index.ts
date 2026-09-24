import { Hono } from "hono";
import { requirePermissions } from "@/middleware/auth";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import events from "./events";
import { cancelRampTransfer, simulateSandboxTransfer } from "./handlers";
import offramp from "./offramp";
import onramp from "./onramp";
import { cancelRampTransferSchema, simulateSandboxTransferSchema } from "./schemas";

const ramps = new Hono<{ Bindings: Env }>();

ramps.route("/onramp", onramp);
ramps.route("/offramp", offramp);
ramps.route("/", events);
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

export default ramps;
