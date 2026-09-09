import { SOL_MINT } from "@heliuslabs/zolana";
import { HeliusRingsError } from "@sdp/helius-rings";

/**
 * The two spellings of native SOL, translated at the one boundary that sees
 * both: SDP names it by the wrapped mint its token registry keys on, the
 * protocol names it with the system program.
 */

// biome-ignore lint/security/noSecrets: the wrapped SOL mint, a public constant.
export const SDP_NATIVE_MINT = "So11111111111111111111111111111111111111112";

export const PROTOCOL_NATIVE_MINT: string = SOL_MINT;

/**
 * Devnet USDC, the one SPL asset this build spends.
 *
 * Spelled the same by SDP and the protocol — `protocolMint` only rewrites
 * native SOL — so the constant serves both. Mainnet USDC is a different mint
 * and is deliberately absent: nothing has exercised the pool's SPL interface
 * there, and a spend gate is the wrong place to discover that.
 */
// biome-ignore lint/security/noSecrets: the devnet USDC mint, a public constant.
export const SDP_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/**
 * The assets a spend may name, as the protocol spells them.
 *
 * Not the `helius_rings_assets` allowlist, which is a product-level catalogue
 * the service checks separately: this is the narrower set whose settlement
 * path — SOL interface or SPL vault plus recipient ATA — the builders and the
 * wire policy both know how to assemble and verify.
 */
export const PROTOCOL_SPEND_MINTS: readonly string[] = [PROTOCOL_NATIVE_MINT, SDP_USDC_MINT];

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

/** Whether a mint names native SOL, whichever of the two spellings it uses. */
export function isProtocolNativeMint(mint: string): boolean {
  return protocolMint(mint) === PROTOCOL_NATIVE_MINT;
}

/**
 * Every spend's gate, ring-bound or not. Defense in depth behind the route
 * schema's mint union; the wire policy asserts the same set independently on
 * the bytes.
 */
export function requireSpendMint(
  mint: string,
  opTypeLabel: "withdrawals" | "transfers" | "merges"
): void {
  if (!PROTOCOL_SPEND_MINTS.includes(protocolMint(mint))) {
    throw new HeliusRingsError(
      "invalid_input",
      `only SOL and USDC ${opTypeLabel} are supported in this build`
    );
  }
}

/**
 * The narrower gate the ring moves still keep. A move settles shielded, so
 * nothing about its wire would resist USDC, but no move has been proved
 * against the pool's SPL interface yet and a gate is the wrong place to find
 * out. Widen it to `requireSpendMint` when one has.
 */
export function requireProtocolSol(mint: string, opTypeLabel: "ring exits" | "ring entries"): void {
  if (protocolMint(mint) !== PROTOCOL_NATIVE_MINT) {
    throw new HeliusRingsError(
      "invalid_input",
      `only SOL ${opTypeLabel} are supported in this build`
    );
  }
}
