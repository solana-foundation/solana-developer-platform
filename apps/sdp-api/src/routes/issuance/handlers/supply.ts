import { createClusterRpc } from "@sdp/rpc/factory";
import { assertValidAddress } from "@sdp/solana/address";
import type { Context } from "hono";
import { getDb } from "@/db/client";
import { AppError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { rethrowRpcUnavailable } from "@/lib/rpc-unavailable";
import { getTenantTokenService, requireProjectScope } from "@/routes/issuance/helpers";
import { AuditService } from "@/services/audit.service";
import type { Env } from "@/types/env";
import { toPublicToken } from "./public-response";

type AppContext = Context<{ Bindings: Env }>;

/**
 * The mint's current supply in base units, read through the scope's cluster pool.
 *
 * @param mintAddress - The token's mint.
 * @returns The confirmed supply as a base-unit integer string.
 */
async function fetchTokenSupplyBaseUnits(mintAddress: string): Promise<string> {
  const { value } = await createClusterRpc()
    .getTokenSupply(assertValidAddress(mintAddress, "mintAddress"), { commitment: "confirmed" })
    .send();
  return value.amount;
}

export const refreshTokenSupply = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { projectId, orgId } = requireProjectScope(c);

  const tokenService = getTenantTokenService(c);
  const token = await tokenService.getToken({
    tokenId,
    organizationId: orgId,
    projectId,
  });

  if (!token) {
    throw notFound("Token");
  }

  if (!token.mintAddress) {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token must be deployed before refreshing supply");
  }

  let supplyBaseUnits: string;
  try {
    supplyBaseUnits = await fetchTokenSupplyBaseUnits(token.mintAddress);
  } catch (error) {
    rethrowRpcUnavailable(error);
    throw new AppError(
      "SOLANA_RPC_ERROR",
      error instanceof Error ? error.message : "Failed to refresh token supply"
    );
  }

  const refreshedToken = await tokenService.setSupplyFromBaseUnits(tokenId, supplyBaseUnits);

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "update",
    resourceType: "token",
    resourceId: tokenId,
    metadata: {
      mintAddress: token.mintAddress,
      supplyBaseUnits,
    },
  });

  return success(c, { token: toPublicToken(refreshedToken) });
};
