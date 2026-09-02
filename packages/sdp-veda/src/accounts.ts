import type { Address } from "@solana/kit";
import { SdpVedaError } from "./errors";
import { createVedaRpc } from "./rpc";

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
 */
export async function accountExists(rpcUrl: string, account: Address): Promise<boolean> {
  const rpc = createVedaRpc(rpcUrl);
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
