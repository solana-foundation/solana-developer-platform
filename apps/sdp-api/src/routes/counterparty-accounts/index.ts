import { Hono } from "hono";
import { authorize } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { requireAction } from "@/middleware/require-action";
import { validateBody, validateParams } from "@/middleware/validate";
import {
  authorizeCounterparty,
  authorizeCounterpartyAccount,
} from "@/routes/counterparties/access";
import type { Env } from "@/types/env";
import {
  archiveCounterpartyAccount,
  createCounterpartyAccount,
  getCounterpartyAccount,
  listCounterpartyAccounts,
  updateCounterpartyAccount,
} from "./handlers";
import {
  counterpartyAccountListParamsSchema,
  counterpartyAccountParamsSchema,
  createCounterpartyAccountSchema,
  updateCounterpartyAccountSchema,
} from "./schemas";

// Mounted under /counterparties/:counterpartyId/accounts. Auth and project
// context middleware are applied by the parent counterparties router.
export const counterpartyAccounts = new Hono<{ Bindings: Env }>();

counterpartyAccounts.get("/", requireAction("counterparties.read"), listCounterpartyAccounts);
// Creating an account sets a payout destination, so it is `execute` like editing one
// (APE SOLA9-771): `manage` alone could otherwise point a transfer batch anywhere.
counterpartyAccounts.post(
  "/",
  requireAction("counterparties.execute"),
  validateParams(counterpartyAccountListParamsSchema),
  validateBody(createCounterpartyAccountSchema),
  authorize(authorizeCounterparty),
  idempotent({ key: "accepted", serverErrors: "store" }),
  createCounterpartyAccount
);
counterpartyAccounts.get(
  "/:counterpartyAccountId",
  requireAction("counterparties.read"),
  getCounterpartyAccount
);
counterpartyAccounts.patch(
  "/:counterpartyAccountId",
  requireAction("counterparties.execute"),
  validateParams(counterpartyAccountParamsSchema),
  validateBody(updateCounterpartyAccountSchema),
  authorize(authorizeCounterpartyAccount),
  idempotent({ key: "accepted", serverErrors: "store" }),
  updateCounterpartyAccount
);
counterpartyAccounts.delete(
  "/:counterpartyAccountId",
  requireAction("counterparties.manage"),
  validateParams(counterpartyAccountParamsSchema),
  authorize(authorizeCounterpartyAccount),
  idempotent({ key: "accepted", serverErrors: "store" }),
  archiveCounterpartyAccount
);
