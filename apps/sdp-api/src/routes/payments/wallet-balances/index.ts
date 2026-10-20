import { Hono } from "hono";
import { requireAction } from "@/middleware/require-action";
import type { Env } from "@/types/env";
import { getWalletBalances } from "./handlers";

export const walletBalances = new Hono<{ Bindings: Env }>();

walletBalances.get("/:walletId/balances", requireAction("wallets.read"), getWalletBalances);
