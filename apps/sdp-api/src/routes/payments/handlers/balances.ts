import type { Address } from "@solana/kit";
import { z } from "zod";
import { formatDecimalAmount } from "@/lib/amount";
import { AppError, badRequest } from "@/lib/errors";
import { success } from "@/lib/response";
import { attachUsdValuesToBalances } from "@/services/helius-das.service";
import * as solanaRpc from "@/services/solana/rpc";
import { type AppContext, getPaymentsRepository } from "../context";
import {
  buildWalletPolicyPayload,
  DESTINATION_ALLOWLIST_POLICY_TYPE,
  PAYMENT_POLICY_VERSION,
  TRANSFER_LIMITS_POLICY_TYPE,
} from "../policy";
import { updateWalletPolicySchema } from "../schemas";
import * as tokenAccounts from "../token-accounts";
import { resolveWalletFromParams } from "./transfers";

export async function getWalletBalances(c: AppContext) {
  const { wallet } = await resolveWalletFromParams(c, ["wallets:read"]);

  const rpc = solanaRpc.createRpc(c.env);
  let lamports = 0n;
  let splBalances: Awaited<ReturnType<typeof tokenAccounts.getSplTokenBalances>> = [];

  try {
    const accountInfo = await solanaRpc.getAccountInfo(rpc, wallet.publicKey as Address);
    lamports = accountInfo?.lamports ?? 0n;
  } catch (error) {
    console.error("getWalletBalances: failed to fetch SOL balance", {
      requestId: c.get("requestId"),
      walletId: wallet.walletId,
      publicKey: wallet.publicKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    splBalances = await tokenAccounts.getSplTokenBalances(rpc, wallet.publicKey as Address);
  } catch (error) {
    console.error("getWalletBalances: failed to fetch SPL balances", {
      requestId: c.get("requestId"),
      walletId: wallet.walletId,
      publicKey: wallet.publicKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const balances = await attachUsdValuesToBalances(c.env, [
    {
      token: "SOL",
      mint: tokenAccounts.SOL_MINT,
      amount: lamports.toString(),
      uiAmount: formatDecimalAmount(lamports, 9),
      decimals: 9,
    },
    ...splBalances,
  ]);

  return success(c, {
    walletBalances: {
      walletId: wallet.walletId,
      address: wallet.publicKey,
      balances,
    },
  });
}

export async function getWalletPolicy(c: AppContext) {
  const { wallet } = await resolveWalletFromParams(c, ["wallets:read"]);
  const repository = getPaymentsRepository(c);

  const rows = await repository.getWalletPoliciesByCustodyWalletId(wallet.id);
  const payload = buildWalletPolicyPayload(wallet.walletId, rows, wallet.createdAt);

  return success(c, { policy: payload });
}

export async function updateWalletPolicy(c: AppContext) {
  const { wallet } = await resolveWalletFromParams(c, ["wallets:write"]);
  const repository = getPaymentsRepository(c);

  const body = await c.req.json();
  const parsed = updateWalletPolicySchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const now = new Date().toISOString();
  const rows = await repository.upsertWalletPolicies([
    {
      id: `pwp_${crypto.randomUUID()}`,
      custodyWalletId: wallet.id,
      policyType: DESTINATION_ALLOWLIST_POLICY_TYPE,
      policy: JSON.stringify({
        version: PAYMENT_POLICY_VERSION,
        destinationAllowlist: parsed.data.destinationAllowlist,
      }),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: `pwp_${crypto.randomUUID()}`,
      custodyWalletId: wallet.id,
      policyType: TRANSFER_LIMITS_POLICY_TYPE,
      policy: JSON.stringify({
        version: PAYMENT_POLICY_VERSION,
        maxTransferAmount: parsed.data.maxTransferAmount ?? null,
        maxDailyAmount: parsed.data.maxDailyAmount ?? null,
      }),
      createdAt: now,
      updatedAt: now,
    },
  ]);

  if (rows.length === 0) {
    throw new AppError("INTERNAL_ERROR", "Failed to persist wallet policy");
  }

  const payload = buildWalletPolicyPayload(wallet.walletId, rows, now);

  return success(c, { policy: payload });
}
