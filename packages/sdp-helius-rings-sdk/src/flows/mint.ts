import { SOL_MINT } from "@heliuslabs/zolana";
import { type Address, address } from "@solana/kit";

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

/**
 * The `asset` a builder should receive, or undefined for native SOL.
 *
 * Undefined rather than the protocol's own SOL constant because every builder
 * types `asset` as optional and treats its absence as native. Passing the
 * constant explicitly would work today and is one upstream default change away
 * from not working.
 */
export function protocolMint(sdpMint: string): Address | undefined {
  if (sdpMint === SDP_NATIVE_MINT || sdpMint === PROTOCOL_NATIVE_MINT) {
    return undefined;
  }
  return address(sdpMint);
}

/** The mint SDP records for a balance or history row the protocol reported. */
export function sdpMint(protocolMintValue: string): string {
  return protocolMintValue === PROTOCOL_NATIVE_MINT ? SDP_NATIVE_MINT : protocolMintValue;
}
