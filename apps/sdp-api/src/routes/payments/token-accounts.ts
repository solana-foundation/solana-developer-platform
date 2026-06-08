import type { Address } from "@solana/kit";
import {
  getSplTokenAccountAddresses as getSplTokenAccountAddressesForWallet,
  getSplTokenBalances as getSplTokenBalancesForWallet,
  resolveSourceTokenAccount as resolveSourceWalletTokenAccount,
  resolveMintDecimals as resolveTokenMintDecimals,
  resolveMintTokenProgram as resolveTokenMintProgram,
} from "@/services/payments/token-accounts";
import type { createRpc } from "@/services/solana/rpc";

export { SOL_MINT } from "@/services/payments/token-accounts";

export async function resolveMintDecimals(
  rpc: ReturnType<typeof createRpc>,
  mint: Address
): Promise<number> {
  return resolveTokenMintDecimals(rpc, mint);
}

export async function getSplTokenBalances(
  rpc: ReturnType<typeof createRpc>,
  owner: Address
): Promise<
  Array<{ token: string; mint: string; amount: string; uiAmount: string; decimals: number }>
> {
  return getSplTokenBalancesForWallet(rpc, owner);
}

export async function getSplTokenAccountAddresses(
  rpc: ReturnType<typeof createRpc>,
  owner: Address
): Promise<Address[]> {
  return getSplTokenAccountAddressesForWallet(rpc, owner);
}

export async function resolveMintTokenProgram(
  rpc: ReturnType<typeof createRpc>,
  mint: Address
): Promise<Address> {
  return resolveTokenMintProgram(rpc, mint);
}

export async function resolveSourceTokenAccount(
  rpc: ReturnType<typeof createRpc>,
  owner: Address,
  mint: Address,
  tokenProgram: Address
): Promise<{ tokenAccount: Address; decimals: number }> {
  return resolveSourceWalletTokenAccount(rpc, owner, mint, tokenProgram);
}
