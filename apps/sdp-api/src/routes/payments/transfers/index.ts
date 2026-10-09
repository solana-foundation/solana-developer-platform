import { Hono } from "hono";
import { requireAllowedOperation } from "@/middleware/allowed-operations";
import { requirePermissions } from "@/middleware/auth";
import { policyGate } from "@/middleware/policy-gate";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  admitTransferRuntimeExecution,
  createTransfer,
  extractTransferPolicyCandidate,
  findTransferIdempotentKeyReplay,
  getTransfer,
  listTransfers,
} from "./handlers";
import { createTransferSchema } from "./schemas";

const transfers = new Hono<{ Bindings: Env }>();

transfers.post(
  "/",
  requirePermissions("payments:write", "wallets:read"),
  requireAllowedOperation("payment_transfer_execute"),
  validateBody(createTransferSchema),
  policyGate({
    extract: extractTransferPolicyCandidate,
    findIdempotentKeyReplay: findTransferIdempotentKeyReplay,
    beforeEnforce: admitTransferRuntimeExecution,
  }),
  createTransfer
);
transfers.get("/", requirePermissions("payments:read"), listTransfers);
transfers.get("/:transferId", requirePermissions("payments:read"), getTransfer);

export default transfers;
