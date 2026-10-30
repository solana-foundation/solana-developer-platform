import { Hono } from "hono";
import { authorize } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { meteredQuota } from "@/middleware/metered-quota";
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
  findTransferBatchRetryReplay,
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

/** Batch sends and retries share one quota per actor and organization. */
const TRANSFER_BATCH_QUOTA = { name: "transfer-batch", actorMax: 10, orgMax: 30 };

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
  // Meters only new sends: a replay, an in-flight poll or a record answer has
  // exited by now. A 429 is never stored under the key (ADR 0009).
  meteredQuota(TRANSFER_BATCH_QUOTA),
  admit(admitTransferBatchExecution),
  createTransferBatch
);
transferBatches.post(
  "/:batchId/retry",
  requireAction("transfer_batches.execute"),
  validateParams(transferBatchIdParamsSchema),
  validateBody(retryTransferBatchSchema),
  authorize(authorizeTransferBatchRetry),
  // The claim records the retry under its key before anything is signed, so a
  // rerun after a 5xx or a crash is answered from that row (HOO-2343).
  idempotent({ key: "required", serverErrors: "rerun", recovery: "record", leaseSeconds: 300 }),
  replayFromRecord(findTransferBatchRetryReplay),
  // Meters only new retries, as for create.
  meteredQuota(TRANSFER_BATCH_QUOTA),
  admit(admitTransferBatchRetryExecution),
  retryTransferBatch
);
transferBatches.get("/", requireAction("transfer_batches.read"), listTransferBatches);
transferBatches.get("/:batchId", requireAction("transfer_batches.read"), getTransferBatch);
