import { Hono } from "hono";
import { authorize } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { admit, replayFromRecord } from "@/middleware/movement-steps";
import { requestGate } from "@/middleware/request-gate";
import { requireAction } from "@/middleware/require-action";
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
import { canonicalizeTransferBatchBody, previousCanonicalTransferBatchBody } from "./idempotency";
import { createTransferBatchSchema, estimateTransferBatchSchema } from "./schemas";

const transferBatches = new Hono<{ Bindings: Env }>();

transferBatches.post(
  "/estimate",
  requireAction("transfer_batches.read"),
  validateBody(estimateTransferBatchSchema),
  estimateTransferBatch
);
transferBatches.post(
  "/",
  requireAction("transfer_batches.execute"),
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
    previousCanonicalize: previousCanonicalTransferBatchBody,
  }),
  replayFromRecord(findTransferBatchRecordReplay),
  admit(admitTransferBatchExecution),
  createTransferBatch
);
transferBatches.get("/", requireAction("transfer_batches.read"), listTransferBatches);
transferBatches.get("/:batchId", requireAction("transfer_batches.read"), getTransferBatch);

export default transferBatches;
