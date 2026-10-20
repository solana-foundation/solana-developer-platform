import { Hono } from "hono";
import { requireAction } from "@/middleware/require-action";
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
  requireAction("ramp_transfers.manage"),
  validateBody(cancelRampTransferSchema),
  cancelRampTransfer
);
ramps.post(
  "/sandbox/simulate",
  requireAction("ramp_transfers.manage"),
  validateBody(simulateSandboxTransferSchema),
  simulateSandboxTransfer
);
