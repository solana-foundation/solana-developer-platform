import { createRpc } from "@sdp/rpc/solana";
import { address, assertAccountExists, fetchEncodedAccount } from "@solana/kit";
import { decodeMint } from "@solana-program/token-2022";
import type { Context } from "hono";
import { getDb } from "@/db/client";
import { AppError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { getTenantTokenService, requireProjectScope } from "@/routes/issuance/helpers";
import { AuditService } from "@/services/audit.service";
import type { Env } from "@/types/env";
import { toPublicToken } from "./public-response";

type AppContext = Context<{ Bindings: Env }>;

/**
 * The mint's supply in base units, decoded from the mint account itself (both
 * token programs share the base mint layout). RPC budget: one `getAccountInfo`,
 * as the `getTokenSupply` it replaces; the account carries no display value.
 */
async function readMintSupplyBaseUnits(env: Env, mintAddress: string): Promise<string> {
  const account = await fetchEncodedAccount(createRpc(env), address(mintAddress), {
    commitment: "confirmed",
  });
  assertAccountExists(account);
  return decodeMint(account).data.supply.toString();
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
    supplyBaseUnits = await readMintSupplyBaseUnits(c.env, token.mintAddress);
  } catch (error) {
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
