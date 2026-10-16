import { Hono } from "hono";
import { requirePermissions } from "@/middleware/auth";
import { authorize } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { validateBody, validateParams } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { authorizeCounterparty, authorizeCounterpartyAccount } from "../counterparties/access";
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
const counterpartyAccounts = new Hono<{ Bindings: Env }>();

counterpartyAccounts.get("/", requirePermissions("counterparties:read"), listCounterpartyAccounts);
counterpartyAccounts.post(
  "/",
  requirePermissions("counterparties:write"),
  validateParams(counterpartyAccountListParamsSchema),
  validateBody(createCounterpartyAccountSchema),
  authorize(authorizeCounterparty),
  idempotent({ key: "accepted", serverErrors: "store" }),
  createCounterpartyAccount
);
counterpartyAccounts.get(
  "/:counterpartyAccountId",
  requirePermissions("counterparties:read"),
  getCounterpartyAccount
);
counterpartyAccounts.patch(
  "/:counterpartyAccountId",
  requirePermissions("counterparties:write"),
  validateParams(counterpartyAccountParamsSchema),
  validateBody(updateCounterpartyAccountSchema),
  authorize(authorizeCounterpartyAccount),
  idempotent({ key: "accepted", serverErrors: "store" }),
  updateCounterpartyAccount
);
counterpartyAccounts.delete(
  "/:counterpartyAccountId",
  requirePermissions("counterparties:write"),
  validateParams(counterpartyAccountParamsSchema),
  authorize(authorizeCounterpartyAccount),
  idempotent({ key: "accepted", serverErrors: "store" }),
  archiveCounterpartyAccount
);

export default counterpartyAccounts;
