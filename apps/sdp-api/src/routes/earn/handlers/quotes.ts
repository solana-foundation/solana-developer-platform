import { resolveEarnProviderClient } from "@sdp/earn";
import { strategyNotAvailable } from "@sdp/earn/errors";
import type { EarnVaultProvider } from "@sdp/earn/types";
import type { EarnMovementDirection, EarnQuoteResponse } from "@sdp/types";
import { z } from "zod";
import { getDb } from "@/db";
import type { EarnStrategyRow } from "@/db/repositories";
import { getAuth } from "@/lib/auth";
import { badRequest } from "@/lib/errors";
import { success } from "@/lib/response";
import {
  assertEarnProviderConfigured,
  assertProviderAvailable,
} from "@/services/provider-availability.service";
import { type AppContext, earnRuntime, resolveSdpEnvironment } from "../context";
import { earnDepositQuoteSchema, earnWithdrawalQuoteSchema } from "../schemas";
import { requireEarnStrategy } from "./strategies";

/**
 * Shared pre-flight for both quote directions. The gates are deliberately
 * asymmetric so disabling a provider or pausing a strategy can never trap
 * funds:
 * - deposits require an active strategy AND the full entitled+configured
 *   provider gate;
 * - withdrawals ignore strategy status (paused/deprecated stop money in,
 *   never money out) and only require provider credentials for the caller's
 *   environment.
 */
async function requireQuotableStrategy(
  c: AppContext,
  params: { strategyId: string; tokenMint: string },
  direction: EarnMovementDirection
): Promise<{ strategy: EarnStrategyRow; client: EarnVaultProvider }> {
  const strategy = await requireEarnStrategy(c, params.strategyId);
  const client = resolveEarnProviderClient(strategy.provider);

  if (direction === "deposit" && strategy.status !== "active") {
    throw strategyNotAvailable(
      `Strategy ${strategy.id} is ${strategy.status} and not accepting deposits`
    );
  }

  if (!strategy.deposit_mints.includes(params.tokenMint)) {
    throw badRequest(`Strategy ${strategy.id} does not accept mint ${params.tokenMint}`);
  }

  const testMode = resolveSdpEnvironment(c) === "sandbox";
  if (direction === "deposit") {
    const auth = getAuth(c);
    await assertProviderAvailable(
      c.env,
      getDb(c.env),
      auth.organizationId,
      "earn",
      strategy.provider,
      testMode
    );
  } else {
    assertEarnProviderConfigured(c.env, strategy.provider, testMode);
  }

  return { strategy, client };
}

export const quoteEarnDeposit = async (c: AppContext) => {
  const body = await c.req.json();
  const parsed = earnDepositQuoteSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  const { strategy, client } = await requireQuotableStrategy(c, parsed.data, "deposit");

  const quote = await client.quoteDeposit(earnRuntime(c), {
    strategyProviderReference: strategy.provider_reference,
    tokenMint: parsed.data.tokenMint,
    amount: parsed.data.amount,
  });

  const response: EarnQuoteResponse = {
    quote: {
      provider: strategy.provider,
      strategyId: strategy.id,
      tokenMint: parsed.data.tokenMint,
      amount: parsed.data.amount,
      shareAmount: quote.expectedShareAmount,
      sharePrice: quote.sharePrice,
      expiresAt: quote.expiresAt,
    },
  };

  return success(c, response);
};

export const quoteEarnWithdrawal = async (c: AppContext) => {
  const body = await c.req.json();
  const parsed = earnWithdrawalQuoteSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  const { strategy, client } = await requireQuotableStrategy(c, parsed.data, "withdrawal");

  const quote = await client.quoteWithdrawal(earnRuntime(c), {
    strategyProviderReference: strategy.provider_reference,
    tokenMint: parsed.data.tokenMint,
    amount: parsed.data.amount,
    shareAmount: parsed.data.shareAmount,
  });

  const response: EarnQuoteResponse = {
    quote: {
      provider: strategy.provider,
      strategyId: strategy.id,
      tokenMint: parsed.data.tokenMint,
      amount: quote.expectedAmount ?? parsed.data.amount,
      shareAmount: parsed.data.shareAmount,
      sharePrice: quote.sharePrice,
      redemptionAvailableAt: quote.redemptionAvailableAt,
      expiresAt: quote.expiresAt,
    },
  };

  return success(c, response);
};
