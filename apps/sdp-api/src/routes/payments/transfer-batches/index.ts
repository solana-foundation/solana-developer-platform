import { Hono } from "hono";
import { authorize } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { meteredQuota } from "@/middleware/metered-quota";
import { admit, replayFromRecord } from "@/middleware/movement-steps";
import { requireAction } from "@/middleware/require-action";
import { validateBody } from "@/middleware/validate";
import {
  admitTransferBatchExecution,
  authorizeTransferBatch,
  createTransferBatch,
  findTransferBatchRecordReplay,
} from "@/routes/payments/transfer-batches/create";
import { estimateTransferBatch } from "@/routes/payments/transfer-batches/estimate";
import { getTransferBatch, listTransferBatches } from "@/routes/payments/transfer-batches/read";
import type { Env } from "@/types/env";
import { canonicalizeTransferBatchBody, previousCanonicalTransferBatchBody } from "./idempotency";
import { createTransferBatchSchema, estimateTransferBatchSchema } from "./schemas";

/** Batch sends and retries share one quota per actor and organization. */
export const TRANSFER_BATCH_QUOTA = { name: "transfer-batch", actorMax: 10, orgMax: 30 };

export const transferBatches = new Hono<{ Bindings: Env }>();

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
  // Signs and broadcasts up to one transaction per chunk. Before the key is
  // claimed, so a refusal is never stored under it (ADR 0009).
  meteredQuota(TRANSFER_BATCH_QUOTA),
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
