import { SigningError } from "@sdp/custody/signing";
import type { OrganizationRole } from "@sdp/types";
import type { Context } from "hono";
import type { z } from "zod";
import { getDb } from "@/db";
import { AppError, badRequest } from "@/lib/errors";
import { callerMayPerform } from "@/middleware/require-action";
import type { ApiKeySigningWalletScope } from "@/services/api-key.service";
import {
  parseRequestedWalletScope,
  resolveSigningWalletsInProject,
} from "@/services/api-key-scope.service";
import { provisionApiKeyWallet } from "@/services/api-key-wallet-provisioning.service";
import type { Env } from "@/types/env";
import type { apiKeyCreateSchema } from "./schemas";

/**
 * The wallet scope a new key is created with (HOO-2099): `all`, or `selected`
 * with the listed custody wallets of this project plus, when asked, one wallet
 * provisioned for the key. Provisioning creates a custody wallet, so it needs
 * `wallets.manage`.
 */
export async function resolveCreateWalletScope(
  c: Context<{ Bindings: Env }>,
  actor: { organizationId: string; role: OrganizationRole },
  projectId: string,
  body: Pick<
    z.infer<typeof apiKeyCreateSchema>,
    "walletScope" | "walletIds" | "provisionWallet" | "walletLabel" | "walletPurpose"
  >
): Promise<{ walletScope: ApiKeySigningWalletScope; provisionedWalletId: string | null }> {
  const requested = parseRequestedWalletScope({
    walletScope: body.walletScope,
    walletIds: body.walletIds,
    provisionWallet: body.provisionWallet !== undefined,
  });
  if (requested === undefined) {
    throw badRequest("walletScope is required");
  }
  const tenant = { organizationId: actor.organizationId, projectId };
  const listed = await resolveSigningWalletsInProject(getDb(c.env), tenant, requested);
  if (body.provisionWallet === undefined || listed.scope === "all") {
    return { walletScope: listed, provisionedWalletId: null };
  }
  if (!callerMayPerform(c, "wallets.manage")) {
    throw new AppError("INSUFFICIENT_PERMISSIONS", "Missing action: wallets.manage", {
      action: "wallets.manage",
    });
  }
  try {
    const wallet = await provisionApiKeyWallet(getDb(c.env), c.env, {
      auditContext: c,
      creationReason: "api_key",
      ...tenant,
      owner: body.provisionWallet,
      label: body.walletLabel,
      purpose: body.walletPurpose,
    });
    return {
      walletScope: {
        scope: "selected",
        custodyWalletIds: [...listed.custodyWalletIds, wallet.id],
      },
      provisionedWalletId: wallet.id,
    };
  } catch (error) {
    if (error instanceof SigningError) {
      if (error.code === "NOT_FOUND") {
        throw new AppError("CONFLICT", error.message);
      }
      throw badRequest(error.message);
    }
    throw error;
  }
}

/** A stored scope as the API returns it: the scope and the custody wallet ids it lists. */
export function walletScopeAuditMetadata(walletScope: ApiKeySigningWalletScope) {
  return {
    walletScope: walletScope.scope,
    walletIds: walletScope.scope === "selected" ? [...walletScope.custodyWalletIds] : [],
  };
}
