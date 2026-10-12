import { Hono } from "hono";
import { requireAllowedOperation } from "@/middleware/allowed-operations";
import { requirePermissions } from "@/middleware/auth";
import { requestGate } from "@/middleware/request-gate";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  admitTransferExecution,
  createTransfer,
  extractTransferRequest,
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
  requestGate({
    extract: extractTransferRequest,
    findIdempotentKeyReplay: findTransferIdempotentKeyReplay,
    admit: admitTransferExecution,
  }),
  createTransfer
);
transfers.get("/", requirePermissions("payments:read"), listTransfers);
transfers.get("/:transferId", requirePermissions("payments:read"), getTransfer);

export default transfers;
