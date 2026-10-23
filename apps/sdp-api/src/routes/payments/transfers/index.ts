import { Hono } from "hono";
import { authorize } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { admit, replayFromRecord } from "@/middleware/movement-steps";
import { requireAction } from "@/middleware/require-action";
import { validateBody } from "@/middleware/validate";
import { canonicalizePaymentBody } from "@/routes/payments/fingerprint";
import type { Env } from "@/types/env";
import {
  admitTransferExecution,
  authorizeTransfer,
  createTransfer,
  findTransferRecordReplay,
  getTransfer,
  listTransfers,
} from "./handlers";
import { createTransferSchema } from "./schemas";

export const transfers = new Hono<{ Bindings: Env }>();

transfers.post(
  "/",
  requireAction("transfers.execute"),
  validateBody(createTransferSchema),
  authorize(authorizeTransfer),
  // The transfer row is written under its key before anything is signed, so a
  // retry after a 5xx re-runs and is answered from that row (HOO-1918).
  idempotent({
    key: "required",
    serverErrors: "rerun",
    recovery: "record",
    canonicalize: canonicalizePaymentBody,
  }),
  replayFromRecord(findTransferRecordReplay),
  admit(admitTransferExecution),
  createTransfer
);
transfers.get("/", requireAction("transfers.read"), listTransfers);
transfers.get("/:transferId", requireAction("transfers.read"), getTransfer);
