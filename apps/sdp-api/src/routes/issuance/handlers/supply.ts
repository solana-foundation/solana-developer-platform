import type { TokenResponse } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { AppError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { getSolanaConfig } from "@/lib/solana";
import { AuditService } from "@/services/audit.service";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import { requireProjectScope } from "../helpers";

type AppContext = Context<{ Bindings: Env }>;

interface TokenSupplyRpcResponse {
  result?: {
    value?: {
      amount?: string;
    };
  };
  error?: {
    message?: string;
  };
}

async function fetchTokenSupplyBaseUnits(rpcUrl: string, mintAddress: string): Promise<string> {
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

  return amount;
}

export const refreshTokenSupply = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { projectId, orgId } = requireProjectScope(c);

  const tokenService = new TokenService(getDb(c.env));
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
    const { rpcUrl } = getSolanaConfig(c.env);
    supplyBaseUnits = await fetchTokenSupplyBaseUnits(rpcUrl, token.mintAddress);
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

  const response: TokenResponse = { token: refreshedToken };
  return success(c, response);
};
