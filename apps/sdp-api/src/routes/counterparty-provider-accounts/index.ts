import { Hono } from "hono";
import { requireAction } from "@/middleware/require-action";
import type { Env } from "@/types/env";
import { listCounterpartyProviderAccounts } from "./handlers";

export const counterpartyProviderAccounts = new Hono<{ Bindings: Env }>();

counterpartyProviderAccounts.get(
  "/",
  requireAction("counterparties.read"),
  listCounterpartyProviderAccounts
);
