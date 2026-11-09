import { Hono } from "hono";
import { authorize } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { admit, replayFromRecord } from "@/middleware/movement-steps";
import { requireAction } from "@/middleware/require-action";
import { isModuleInChannel } from "@/middleware/require-module";
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
import { createTransferSchema, walletTransferSchema } from "./schemas";

export const transfers = new Hono<{ Bindings: Env }>();

transfers.post(
  "/execute",
  requireAction("transfers.execute"),
  validateBody((c) =>
    isModuleInChannel(c, "ramps") ? createTransferSchema : walletTransferSchema
  ),
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
