import { Hono } from "hono";
import { requirePermissions } from "@/middleware/auth";
import { policyGate } from "@/middleware/policy-gate";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  admitTransferBatchRuntimeExecution,
  createTransferBatch,
  estimateTransferBatch,
  extractTransferBatchPolicyCandidate,
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
  validateBody(createTransferBatchSchema),
  policyGate({
    extract: extractTransferBatchPolicyCandidate,
    findIdempotentKeyReplay: findTransferBatchIdempotentKeyReplay,
    beforeEnforce: admitTransferBatchRuntimeExecution,
  }),
  createTransferBatch
);
transferBatches.get("/", requirePermissions("payments:read"), listTransferBatches);
transferBatches.get("/:batchId", requirePermissions("payments:read"), getTransferBatch);

export default transferBatches;
