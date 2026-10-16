import { withMinimumRpcSlot, withRpcReadContext } from "@sdp/rpc/read-context";
import * as solanaRpc from "@sdp/rpc/solana";
import { formatDecimalAmount } from "@sdp/solana/amount";
import type { Address } from "@solana/kit";
import { z } from "zod";
import { badRequestQuery, providerUnavailable } from "@/lib/errors";
import { success } from "@/lib/response";
import { resolveSdpEnvironment } from "@/lib/sdp-environment";
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

export async function getWalletBalances(c: AppContext) {
  const { wallet } = await resolveWalletFromParams(c, ["wallets:read"]);

  const parsed = walletBalancesQuerySchema.safeParse(c.req.query());
  if (!parsed.success) throw badRequestQuery({ errors: z.flattenError(parsed.error).fieldErrors });
  const { minimumSlot } = parsed.data;
  const rpc =
    minimumSlot === undefined
      ? solanaRpc.createRpc(c.env, { requestTimeoutMs: 3_000, wrapTransport: withRpcReadContext })
      : solanaRpc.createClusterRpc(
          c.env,
          resolveSdpEnvironment(c) === "sandbox" ? "devnet" : "mainnet-beta",
          { requestTimeoutMs: 3_000, wrapTransport: withRpcReadContext }
        );
  const tokenLabelsByMint = await resolveIssuedTokenLabelsByMint(c);

  const read = <T>(fn: () => Promise<T>) =>
    minimumSlot === undefined ? fn() : withMinimumRpcSlot(minimumSlot, fn);
  const [solBalanceResult, splBalancesResult] = await Promise.allSettled([
    read(() => solanaRpc.getAccountInfo(rpc, wallet.publicKey as Address)),
    read(() =>
      tokenAccounts.getSplTokenBalances(rpc, wallet.publicKey as Address, { tokenLabelsByMint })
    ),
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
  const labeledBalances = await attachTokenSymbolsToBalances(c.env, [
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
