import { Hono } from "hono";
import { requirePermissions } from "@/middleware/auth";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  archiveCounterpartyAccount,
  createCounterpartyAccount,
  getCounterpartyAccount,
  listCounterpartyAccounts,
  updateCounterpartyAccount,
} from "./handlers";
import { createCounterpartyAccountSchema, updateCounterpartyAccountSchema } from "./schemas";

// Mounted under /counterparties/:counterpartyId/accounts. Auth and project
// context middleware are applied by the parent counterparties router.
const counterpartyAccounts = new Hono<{ Bindings: Env }>();

counterpartyAccounts.get("/", requirePermissions("counterparties:read"), listCounterpartyAccounts);
counterpartyAccounts.post(
  "/",
  requirePermissions("counterparties:write"),
  validateBody(createCounterpartyAccountSchema),
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
  validateBody(updateCounterpartyAccountSchema),
  updateCounterpartyAccount
);
counterpartyAccounts.delete(
  "/:counterpartyAccountId",
  requirePermissions("counterparties:write"),
  archiveCounterpartyAccount
);

export default counterpartyAccounts;
