import { Hono } from "hono";
import { requireAllowedOperation } from "@/middleware/allowed-operations";
import { requirePermissions } from "@/middleware/auth";
import { idempotent } from "@/middleware/idempotency";
import { policyGate } from "@/middleware/policy-gate";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { authorizeSourceWalletReplay } from "../wallets";
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
  // The transfer row is written under its key before anything is signed, so a
  // retry after a 5xx re-runs and the handler recovers that row (HOO-1918).
  idempotent({
    key: "required",
    serverErrors: "rerun",
    honorsDryRun: true,
    authorizeReplay: authorizeSourceWalletReplay,
  }),
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
