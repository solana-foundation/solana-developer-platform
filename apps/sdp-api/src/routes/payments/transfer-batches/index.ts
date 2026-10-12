import { Hono } from "hono";
import { requireAllowedOperation } from "@/middleware/allowed-operations";
import { requirePermissions } from "@/middleware/auth";
import { requestGate } from "@/middleware/request-gate";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  admitTransferBatchExecution,
  createTransferBatch,
  estimateTransferBatch,
  extractTransferBatchRequest,
  findTransferBatchIdempotentKeyReplay,
  getTransferBatch,
  listTransferBatches,
} from "./handlers";
import { createTransferBatchSchema, estimateTransferBatchSchema } from "./schemas";

const transferBatches = new Hono<{ Bindings: Env }>();

transferBatches.post(
  "/estimate",
  requirePermissions("payments:read", "wallets:read", "counterparties:read"),
  validateBody(estimateTransferBatchSchema),
  estimateTransferBatch
);
transferBatches.post(
  "/",
  requirePermissions("payments:write", "wallets:read", "counterparties:read"),
  requireAllowedOperation("payment_transfer_batch_execute"),
  validateBody(createTransferBatchSchema),
  requestGate({
    extract: extractTransferBatchRequest,
    findIdempotentKeyReplay: findTransferBatchIdempotentKeyReplay,
    admit: admitTransferBatchExecution,
  }),
  createTransferBatch
);
transferBatches.get("/", requirePermissions("payments:read"), listTransferBatches);
transferBatches.get("/:batchId", requirePermissions("payments:read"), getTransferBatch);

export default transferBatches;
