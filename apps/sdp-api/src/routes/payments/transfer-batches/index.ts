import { Hono } from "hono";
import { authorize } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { admit, replayFromRecord } from "@/middleware/movement-steps";
import { requireAction } from "@/middleware/require-action";
import { validateBody, validateParams } from "@/middleware/validate";
import {
  admitTransferBatchExecution,
  authorizeTransferBatch,
  createTransferBatch,
  findTransferBatchRecordReplay,
} from "@/routes/payments/transfer-batches/create";
import { estimateTransferBatch } from "@/routes/payments/transfer-batches/estimate";
import { getTransferBatch, listTransferBatches } from "@/routes/payments/transfer-batches/read";
import {
  admitTransferBatchRetryExecution,
  authorizeTransferBatchRetry,
  retryTransferBatch,
} from "@/routes/payments/transfer-batches/retry";
import type { Env } from "@/types/env";
import { canonicalizeTransferBatchBody, previousCanonicalTransferBatchBody } from "./idempotency";
import {
  createTransferBatchSchema,
  estimateTransferBatchSchema,
  retryTransferBatchSchema,
  transferBatchIdParamsSchema,
} from "./schemas";

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
transferBatches.post(
  "/:batchId/retry",
  requireAction("transfer_batches.execute"),
  validateParams(transferBatchIdParamsSchema),
  validateBody(retryTransferBatchSchema),
  authorize(authorizeTransferBatchRetry),
  // No row of its own to answer from: a 5xx is stored, and a retry after a
  // crash gets OUTCOME_UNKNOWN. A new key is then safe, since a retry only
  // ever claims recipients that are failed (HOO-2343).
  idempotent({ key: "required", serverErrors: "store" }),
  admit(admitTransferBatchRetryExecution),
  retryTransferBatch
);
transferBatches.get("/", requireAction("transfer_batches.read"), listTransferBatches);
transferBatches.get("/:batchId", requireAction("transfer_batches.read"), getTransferBatch);
