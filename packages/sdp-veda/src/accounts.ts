import { type Address, fetchEncodedAccounts } from "@solana/kit";
import { SdpVedaError } from "./errors";
import { type createVedaReadRpc, createVedaRpc } from "./rpc";

/**
 * Whether an account currently exists on chain.
 *
 * Exists for `createsShareAccount`: the plan always carries an IDEMPOTENT
 * create, so only a chain read can say whether rent will actually be charged
 * (see `EarnVaultTransactionPlan.createsShareAccount` in `@sdp/earn` for the
 * contract and its known pre-execution residual).
 *
 * Read through the operation's client with the SDK's own config, so an
 * account the operation's batched read already holds costs no request.
 *
 * Outside `./sdk.ts` because it needs no Veda SDK — just this repo's kit —
 * matching `./mint.ts`.
 */
export async function accountExists(
  rpc: ReturnType<typeof createVedaReadRpc>,
  commitment: "confirmed" | "finalized",
  account: Address
): Promise<boolean> {
  try {
    const [found] = await fetchEncodedAccounts(rpc, [account], { commitment });
    return found.exists;
  } catch (cause) {
    throw new SdpVedaError("VAULT_UNREADABLE", `Veda could not read the account ${account}`, {
      cause,
    });
  }
}

/**
 * The rent-exempt minimum for an account of `bytes`, read from the chain the
 * plan targets rather than computed locally: rent parameters are cluster
 * state, and a hardcoded rate silently under-funds the day they change
 * (devnet's has already moved once during this integration).
 */
export async function minimumBalanceForRentExemption(
  rpcUrl: string,
  bytes: number
): Promise<bigint> {
  const rpc = createVedaRpc(rpcUrl);
  try {
    return BigInt(await rpc.getMinimumBalanceForRentExemption(BigInt(bytes)).send());
  } catch (cause) {
    throw new SdpVedaError(
      "VAULT_UNREADABLE",
      `Veda could not read the rent-exempt minimum for a ${bytes}-byte account`,
      { cause }
    );
  }
}
