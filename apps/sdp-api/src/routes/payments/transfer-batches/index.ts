import { Hono } from "hono";
import { requireAllowedOperation } from "@/middleware/allowed-operations";
import { requirePermissions } from "@/middleware/auth";
import { idempotent } from "@/middleware/idempotency";
import { policyGate } from "@/middleware/policy-gate";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { authorizeSourceWalletReplay } from "../wallets";
import {
  admitTransferBatchRuntimeExecution,
  createTransferBatch,
  estimateTransferBatch,
  extractTransferBatchPolicyCandidate,
  findTransferBatchIdempotentKeyReplay,
  getTransferBatch,
  listTransferBatches,
} from "./handlers";
import { canonicalizeTransferBatchBody } from "./idempotency";
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
  // Batches run longer than one transfer, recipient order does not change what
  // moves, and the batch row is written under its key first (HOO-1918).
  idempotent({
    key: "required",
    serverErrors: "rerun",
    leaseSeconds: 300,
    canonicalize: canonicalizeTransferBatchBody,
    honorsDryRun: true,
    authorizeReplay: authorizeSourceWalletReplay,
  }),
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
