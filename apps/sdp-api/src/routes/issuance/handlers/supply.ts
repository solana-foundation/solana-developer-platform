import { getSolanaConfig } from "@sdp/rpc";
import type { Context } from "hono";
import { getDb } from "@/db";
import { AppError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import type { Env } from "@/types/env";
import { getTenantTokenService, requireProjectScope } from "../helpers";
import { toPublicToken } from "./public-response";

type AppContext = Context<{ Bindings: Env }>;

interface TokenSupplyRpcResponse {
  result?: {
    value?: {
      amount?: string;
    };
    context?: {
      slot?: number;
    };
  };
  error?: {
    message?: string;
  };
}

async function fetchTokenSupplyBaseUnits(
  rpcUrl: string,
  mintAddress: string
): Promise<{ amount: string; slot: number | null }> {
  const rpcResponse = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "getTokenSupply",
      params: [mintAddress, { commitment: "confirmed" }],
    }),
  });

  if (!rpcResponse.ok) {
    throw new Error(`RPC request failed with status ${rpcResponse.status}`);
  }

  const payload = (await rpcResponse.json()) as TokenSupplyRpcResponse;
  if (payload.error) {
    throw new Error(payload.error.message ?? "RPC returned an error");
  }

  const amount = payload.result?.value?.amount;
  if (!amount || !/^\d+$/.test(amount)) {
    throw new Error("RPC returned an invalid token supply");
  }

  // The response context carries the slot the reading was taken at. Supply
  // reconciliation records it so settled-burn bookkeeping can order a burn's
  // settlement against this reading by slot instead of guessing from
  // wall-clock stamps. A response without one simply leaves the recorded
  // slot alone.
  const contextSlot = payload.result?.context?.slot;
  const slot =
    typeof contextSlot === "number" && Number.isInteger(contextSlot) && contextSlot >= 0
      ? contextSlot
      : null;

  return { amount, slot };
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

  let supply: { amount: string; slot: number | null };
  try {
    const { rpcUrl } = getSolanaConfig(c.env);
    supply = await fetchTokenSupplyBaseUnits(rpcUrl, token.mintAddress);
  } catch (error) {
    throw new AppError(
      "SOLANA_RPC_ERROR",
      error instanceof Error ? error.message : "Failed to refresh token supply"
    );
  }

  const refreshedToken = await tokenService.setSupplyFromBaseUnits(
    tokenId,
    supply.amount,
    supply.slot
  );

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "update",
    resourceType: "token",
    resourceId: tokenId,
    metadata: {
      mintAddress: token.mintAddress,
      supplyBaseUnits: supply.amount,
      supplyReadSlot: supply.slot,
    },
  });

  return success(c, { token: toPublicToken(refreshedToken) });
};
