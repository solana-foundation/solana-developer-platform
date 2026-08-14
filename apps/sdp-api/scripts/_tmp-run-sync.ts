/**
 * Local-only: drive one catalogue-sync pass against the local Postgres so the
 * devnet Kamino path can be verified end to end (client -> sync guard -> DB).
 */
import { syncEarnCatalogue } from "@/cron/earn-catalogue-sync";
import type { Env } from "@/types/env";

const env = {
  DATABASE_URL: process.env.DATABASE_URL,
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
  MARKETS_ENABLED: "true",
  EARN_ENABLED: "true",
} as unknown as Env;

await syncEarnCatalogue(env);
console.log("sync pass complete");
