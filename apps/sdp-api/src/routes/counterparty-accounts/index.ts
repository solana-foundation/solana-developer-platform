import { Hono } from "hono";
import { requirePermissions } from "@/middleware/auth";
import type { Env } from "@/types/env";
import {
  archiveCounterpartyAccount,
  createCounterpartyAccount,
  getCounterpartyAccount,
  listCounterpartyAccounts,
  updateCounterpartyAccount,
} from "./handlers";

// Mounted under /counterparties/:counterpartyId/accounts. Auth and project
// context middleware are applied by the parent counterparties router.
const counterpartyAccounts = new Hono<{ Bindings: Env }>();

counterpartyAccounts.get("/", requirePermissions("counterparties:read"), listCounterpartyAccounts);
counterpartyAccounts.post(
  "/",
  requirePermissions("counterparties:write"),
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
  updateCounterpartyAccount
);
counterpartyAccounts.delete(
  "/:counterpartyAccountId",
  requirePermissions("counterparties:write"),
  archiveCounterpartyAccount
);

export default counterpartyAccounts;
