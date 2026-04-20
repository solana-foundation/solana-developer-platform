import type { Context } from "hono";
import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

export function resolveActor(c: AppContext): { organizationId: string; projectId?: string } {
  const apiKey = c.get("apiKey");
  if (apiKey) {
    return { organizationId: apiKey.organizationId, projectId: apiKey.projectId ?? undefined };
  }

  const clerk = c.get("clerk");
  if (clerk) {
    return { organizationId: clerk.organizationId };
  }

  const session = c.get("session");
  if (session) {
    return { organizationId: session.organizationId };
  }

  throw new AppError("UNAUTHORIZED", "Authentication required");
}

export function parseBooleanQueryParam(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

export async function getPreferredWalletForConfig(
  db: DatabaseClient,
  configId: string,
  defaultWalletId: string | null
): Promise<{ walletId: string; publicKey: string } | null> {
  const wallet = await db
    .prepare(
      `SELECT wallet_id, public_key
       FROM custody_wallets
       WHERE custody_config_id = ? AND status = 'active'
       ORDER BY CASE WHEN wallet_id = ? THEN 0 ELSE 1 END, created_at ASC
       LIMIT 1`
    )
    .bind(configId, defaultWalletId ?? "")
    .first<{ wallet_id: string; public_key: string }>();

  if (!wallet) {
    return null;
  }

  return {
    walletId: wallet.wallet_id,
    publicKey: wallet.public_key,
  };
}
