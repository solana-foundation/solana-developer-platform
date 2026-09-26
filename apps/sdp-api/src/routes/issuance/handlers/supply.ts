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

async function fetchCurrentConfirmedSlot(rpcUrl: string): Promise<number | null> {
  try {
    const rpcResponse = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "getSlot",
        params: [{ commitment: "confirmed" }],
      }),
    });

    if (!rpcResponse.ok) {
      return null;
    }

    const payload = (await rpcResponse.json()) as { result?: unknown };
    const slot = payload.result;
    return typeof slot === "number" && Number.isInteger(slot) && slot >= 0 ? slot : null;
  } catch {
    return null;
  }
}

async function fetchTokenSupplyBaseUnits(
  rpcUrl: string,
  mintAddress: string
): Promise<{ amount: string; slot: number }> {
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
  // wall-clock stamps. A response without one falls back to the current
  // confirmed slot: it bounds the reading from above, so a burn the reading
  // absorbed is recognized as absorbed (its slot is at or below the bound)
  // and a burn settling after the refresh still subtracts its decrement
  // exactly. The bound is mandatory, not best-effort: a reading whose slot
  // cannot be determined is never applied, because a slotless absorption
  // cannot be ordered against a burn that settles after the refresh — the
  // bookkeeping would skip that burn's decrement and leave the record above
  // the chain until a separate refresh. Failing here turns the refresh into
  // a retryable error with the recorded figure untouched; if even the slot
  // lookup fails, this throws and nothing is written.
  const contextSlot = payload.result?.context?.slot;
  const slot =
    typeof contextSlot === "number" && Number.isInteger(contextSlot) && contextSlot >= 0
      ? contextSlot
      : await fetchCurrentConfirmedSlot(rpcUrl);

  if (slot === null) {
    throw new Error(
      "Could not determine the slot the supply reading was taken at; retry the refresh"
    );
  }

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

  let supply: { amount: string; slot: number };
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
