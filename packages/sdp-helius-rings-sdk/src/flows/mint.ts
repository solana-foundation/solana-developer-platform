import { SOL_MINT } from "@heliuslabs/zolana";

/**
 * The two spellings of native SOL, translated at the one boundary that sees
 * both.
 *
 * SDP names native SOL by its wrapped mint, because that is what its token
 * registry and every other integration key on. The protocol names it with the
 * system program. Neither is wrong, so rather than teaching either side the
 * other's spelling, the conversion lives here.
 */

// biome-ignore lint/security/noSecrets: the wrapped SOL mint, a public constant.
export const SDP_NATIVE_MINT = "So11111111111111111111111111111111111111112";

export const PROTOCOL_NATIVE_MINT: string = SOL_MINT;

/** Native SOL always has nine decimals, so this is a constant and not a guess. */
export const NATIVE_MINT_DECIMALS = 9;

export const NATIVE_MINT_SYMBOL = "SOL";

/** The mint SDP records for a balance the protocol reported. */
export function sdpMint(protocolMintValue: string): string {
  return protocolMintValue === PROTOCOL_NATIVE_MINT ? SDP_NATIVE_MINT : protocolMintValue;
}

/** The mint the protocol expects for a deposit SDP recorded. */
export function protocolMint(sdpMintValue: string): string {
  return sdpMintValue === SDP_NATIVE_MINT ? PROTOCOL_NATIVE_MINT : sdpMintValue;
}
