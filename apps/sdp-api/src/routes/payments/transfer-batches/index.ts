import { Hono } from "hono";
import { requireAllowedOperation } from "@/middleware/allowed-operations";
import { requirePermissions } from "@/middleware/auth";
import { authorize } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { admit, replayFromRecord } from "@/middleware/movement-steps";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  admitTransferBatchExecution,
  authorizeTransferBatch,
  createTransferBatch,
  estimateTransferBatch,
  findTransferBatchRecordReplay,
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
  validateBody(createTransferBatchSchema),
  authorize(authorizeTransferBatch),
  // Batches run longer than one transfer, recipient order does not change what
  // moves, and the batch row is written under its key first (HOO-1918).
  idempotent({
    key: "required",
    serverErrors: "rerun",
    recovery: "record",
    leaseSeconds: 300,
    canonicalize: canonicalizeTransferBatchBody,
  }),
  replayFromRecord(findTransferBatchRecordReplay),
  admit(admitTransferBatchExecution),
  createTransferBatch
);
transferBatches.get("/", requirePermissions("payments:read"), listTransferBatches);
transferBatches.get("/:batchId", requirePermissions("payments:read"), getTransferBatch);

export default transferBatches;
