import { createClusterRpc } from "@sdp/rpc/factory";
import { assertValidAddress } from "@sdp/solana/address";
import { formatDecimalAmount } from "@sdp/solana/amount";
import { z } from "zod";
import { badRequestQuery, providerUnavailable } from "@/lib/errors";
import { success } from "@/lib/response";
import { getLogger } from "@/runtime/logger";
import {
  attachTokenSymbolsToBalances,
  attachUsdValuesToBalances,
} from "@/services/helius-das.service";
import type { AppContext } from "../context";
import * as tokenAccounts from "../token-accounts";
import { resolveIssuedTokenLabelsByMint } from "../token-labels";
import { resolveWalletFromParams } from "../wallets";
import { walletBalancesQuerySchema } from "./schemas";

/** One deadline over every chain read a balances request makes, failover hops included. */
const BALANCE_READ_TIMEOUT_MS = 3_000;

export async function getWalletBalances(c: AppContext) {
  const { wallet } = await resolveWalletFromParams(c, ["wallets:read"]);
  const owner = assertValidAddress(wallet.publicKey, "publicKey");

  const parsed = walletBalancesQuerySchema.safeParse(c.req.query());
  if (!parsed.success) throw badRequestQuery({ errors: z.flattenError(parsed.error).fieldErrors });
  const { minimumSlot } = parsed.data;
  const rpc = createClusterRpc();
  const tokenLabelsByMint = await resolveIssuedTokenLabelsByMint(c);

  const bounds: tokenAccounts.BalanceReadBounds = {
    abortSignal: AbortSignal.timeout(BALANCE_READ_TIMEOUT_MS),
    minContextSlot: minimumSlot === undefined ? undefined : BigInt(minimumSlot),
  };
  const [solBalanceResult, splBalancesResult] = await Promise.allSettled([
    tokenAccounts.getLamportsBalance(rpc, owner, bounds),
    tokenAccounts.getSplTokenBalances(rpc, owner, {
      ...bounds,
      tokenLabelsByMint,
    }),
  ]);

  if (solBalanceResult.status === "rejected") {
    getLogger().error(
      {
        requestId: c.get("requestId"),
        walletId: wallet.walletId,
        publicKey: wallet.publicKey,
        error:
          solBalanceResult.reason instanceof Error
            ? solBalanceResult.reason.message
            : String(solBalanceResult.reason),
      },
      "getWalletBalances: failed to fetch SOL balance"
    );
  }

  if (splBalancesResult.status === "rejected") {
    getLogger().error(
      {
        requestId: c.get("requestId"),
        walletId: wallet.walletId,
        publicKey: wallet.publicKey,
        error:
          splBalancesResult.reason instanceof Error
            ? splBalancesResult.reason.message
            : String(splBalancesResult.reason),
      },
      "getWalletBalances: failed to fetch SPL balances"
    );
  }

  if (solBalanceResult.status === "rejected" || splBalancesResult.status === "rejected") {
    throw providerUnavailable("Wallet balances are temporarily unavailable. Try again.");
  }
  const lamports = solBalanceResult.value;
  const splBalances = splBalancesResult.value;
  const labeledBalances = await attachTokenSymbolsToBalances([
    {
      token: "SOL",
      mint: tokenAccounts.SOL_MINT,
      amount: lamports.toString(),
      uiAmount: formatDecimalAmount(lamports, 9),
      decimals: 9,
    },
    ...splBalances,
  ]);
  const balances = await attachUsdValuesToBalances(c.env, labeledBalances);

  return success(c, {
    ...(minimumSlot === undefined ? {} : { balanceReadContext: { minimumSlot } }),
    walletBalances: {
      walletId: wallet.walletId,
      address: wallet.publicKey,
      balances,
    },
  });
}
