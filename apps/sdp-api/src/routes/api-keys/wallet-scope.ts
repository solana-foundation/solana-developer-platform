import type { Context } from "hono";
import type { z } from "zod";
import { getDb } from "@/db/client";
import { badRequest } from "@/lib/errors";
import type { ApiKeySigningWalletScope } from "@/services/api-key.service";
import {
  parseRequestedWalletScope,
  resolveSigningWalletsInProject,
} from "@/services/api-key-scope.service";
import type { Env } from "@/types/env";
import type { apiKeyCreateSchema } from "./schemas";

/**
 * The wallet scope a new key is created with (HOO-2099): `all`, or `selected`
 * with the listed custody wallets of this project. Creating a key never
 * creates a wallet: a wallet is created first (`POST /v1/wallets`) and listed.
 */
export async function resolveCreateWalletScope(
  c: Context<{ Bindings: Env }>,
  tenant: { organizationId: string; projectId: string },
  body: Pick<z.infer<typeof apiKeyCreateSchema>, "walletScope" | "walletIds">
): Promise<ApiKeySigningWalletScope> {
  const requested = parseRequestedWalletScope({
    walletScope: body.walletScope,
    walletIds: body.walletIds,
  });
  if (requested === undefined) {
    throw badRequest("walletScope is required");
  }
  return resolveSigningWalletsInProject(getDb(c.env), tenant, requested);
}

/** A stored scope as the API returns it: the scope and the custody wallet ids it lists. */
export function walletScopeAuditMetadata(walletScope: ApiKeySigningWalletScope) {
  return {
    walletScope: walletScope.scope,
    walletIds: walletScope.scope === "selected" ? [...walletScope.custodyWalletIds] : [],
  };
}
