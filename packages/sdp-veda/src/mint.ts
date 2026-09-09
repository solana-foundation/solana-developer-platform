import type { Address } from "@solana/kit";
import { mintDecimals } from "./amounts";
import { SdpVedaError } from "./errors";
import { createVedaRpc } from "./rpc";

/**
 * A mint's decimals, read from the chain.
 *
 * Deliberately NOT taken from `WELL_KNOWN_TOKEN_BY_MINT`, even though every
 * mint SDP fronts for Veda is in it. That catalogue is SDP's own metadata; the
 * number that decides how many atoms a decimal string becomes has to be the
 * mint's own, or a stale catalogue entry would move a different amount than the
 * one requested. Same reasoning as `@sdp/kamino` reading `tokenMintDecimals`
 * off live vault state rather than trusting a catalogue row.
 *
 * Outside `./sdk.ts` because it needs no Veda SDK — just this repo's kit — so
 * it stays unit-testable without loading the SDK or its nested `@solana/kit` 7.
 */
export async function readMintDecimals(rpcUrl: string, mint: Address): Promise<number> {
  const rpc = createVedaRpc(rpcUrl);
  let account: unknown;
  try {
    account = (await rpc.getAccountInfo(mint, { encoding: "jsonParsed" }).send())?.value;
  } catch (cause) {
    throw new SdpVedaError("VAULT_UNREADABLE", `Veda could not read the mint ${mint}`, { cause });
  }
  if (!account) {
    throw new SdpVedaError("VAULT_UNREADABLE", `Veda deposit mint ${mint} does not exist`);
  }

  const parsed = (account as { data?: { parsed?: { info?: { decimals?: unknown } } } }).data?.parsed
    ?.info?.decimals;
  try {
    return mintDecimals(parsed, `deposit mint ${mint} decimals`);
  } catch (cause) {
    // A mint account the RPC could not parse is not a mint SDP should spend
    // against: without its scale there is no honest conversion from a decimal
    // string to the atoms the instruction encodes.
    throw new SdpVedaError(
      "VAULT_UNREADABLE",
      `Veda deposit mint ${mint} did not report a usable decimal count`,
      { cause }
    );
  }
}
