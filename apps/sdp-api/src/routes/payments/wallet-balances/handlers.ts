import { createClusterRpc } from "@sdp/rpc/factory";
import { formatDecimalAmount } from "@sdp/solana/amount";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import type { Address } from "@solana/kit";
import { z } from "zod";
import { badRequestQuery, providerUnavailable } from "@/lib/errors";
import { success } from "@/lib/response";
import { getSplTokenBalances } from "@/routes/payments/token-accounts";
import { getLogger } from "@/runtime/logger";
import {
  attachTokenSymbolsToBalances,
  attachUsdValuesToBalances,
} from "@/services/helius-das.service";
import type { AppContext } from "../context";
import { resolveIssuedTokenLabelsByMint } from "../token-labels";
import { resolveWalletFromParams } from "../wallets";
import { walletBalancesQuerySchema } from "./schemas";

const BALANCE_READ_TIMEOUT_MS = 3_000;

export async function getWalletBalances(c: AppContext) {
  const { wallet } = await resolveWalletFromParams(c, ["wallets:read"]);

  const parsed = walletBalancesQuerySchema.safeParse(c.req.query());
  if (!parsed.success) throw badRequestQuery({ errors: z.flattenError(parsed.error).fieldErrors });
  const { minimumSlot } = parsed.data;
  const rpc = createClusterRpc();
  const minContextSlot = minimumSlot === undefined ? undefined : BigInt(minimumSlot);
  const tokenLabelsByMint = await resolveIssuedTokenLabelsByMint(c);
  const abortSignal = AbortSignal.timeout(BALANCE_READ_TIMEOUT_MS);

  const [solBalanceResult, splBalancesResult] = await Promise.allSettled([
    rpc
      .getAccountInfo(wallet.publicKey as Address, {
        encoding: "base64",
        commitment: "confirmed",
        minContextSlot,
      })
      .send({ abortSignal })
      .then((response) => response.value),
    getSplTokenBalances(rpc, wallet.publicKey as Address, {
      tokenLabelsByMint,
      minContextSlot,
      abortSignal,
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
  const lamports = solBalanceResult.value?.lamports ?? 0n;
  const splBalances = splBalancesResult.value;
  const labeledBalances = await attachTokenSymbolsToBalances([
    {
      token: "SOL",
      mint: SOL_MINT,
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
