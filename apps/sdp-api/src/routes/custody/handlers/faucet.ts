import { address } from "@solana/kit";
import { AppError } from "@/lib/errors";
import { success } from "@/lib/response";
import type { ValidatedContext } from "@/middleware/validate";
import type { walletFaucetSchema, walletIdParamsSchema } from "@/routes/custody/schemas";
import { requestDevnetFaucetAirdrop } from "@/services/custody/devnet-faucet";
import { findProjectOperationalWallet } from "./wallets";

export const requestWalletFaucet = async (
  c: ValidatedContext<{ param: typeof walletIdParamsSchema; json: typeof walletFaucetSchema }>
) => {
  const { walletId } = c.req.valid("param");
  const wallet = await findProjectOperationalWallet(c, walletId, true);
  if (!wallet) {
    throw new AppError("NOT_FOUND", "Wallet not found");
  }

  return success(c, await requestDevnetFaucetAirdrop(address(wallet.publicKey)));
};
