import type {
  Address,
  GetAccountInfoApi,
  GetMinimumBalanceForRentExemptionApi,
  Rpc,
} from "@solana/kit";
import { SdpVedaError } from "./errors";

/**
 * Whether an account currently exists on chain.
 *
 * Exists for `createsShareAccount`: the plan always carries an IDEMPOTENT
 * create, so only a chain read can say whether rent will actually be charged
 * (see `EarnVaultTransactionPlan.createsShareAccount` in `@sdp/earn` for the
 * contract and its known pre-execution residual). Zero-length data slice: the
 * question is existence, not content.
 *
 * Outside `./sdk.ts` because it needs no Veda SDK — just this repo's kit —
 * matching `./mint.ts`.
 *
 * @param rpc - A client for the plan's cluster.
 * @param account - The account to look up.
 * @returns Whether the account exists.
 * @throws SdpVedaError `VAULT_UNREADABLE` when the read fails.
 */
export async function accountExists(
  rpc: Rpc<GetAccountInfoApi>,
  account: Address
): Promise<boolean> {
  try {
    const result = await rpc
      .getAccountInfo(account, { encoding: "base64", dataSlice: { offset: 0, length: 0 } })
      .send();
    return result?.value != null;
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
 *
 * @param rpc - A client for the plan's cluster.
 * @param bytes - The account's data size.
 * @returns The rent-exempt minimum in lamports.
 * @throws SdpVedaError `VAULT_UNREADABLE` when the read fails.
 */
export async function minimumBalanceForRentExemption(
  rpc: Rpc<GetMinimumBalanceForRentExemptionApi>,
  bytes: number
): Promise<bigint> {
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
