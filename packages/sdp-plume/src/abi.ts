import {
  PLUME_ENDPOINT_ID,
  PLUME_SOLANA_ENDPOINT_ID,
  type PlumeVaultDeployment,
} from "@sdp/types/plume-programs";
import {
  addDecoderSizePrefix,
  address,
  fixDecoderSize,
  getAddressEncoder,
  getBytesDecoder,
  getOptionDecoder,
  getStructDecoder,
  getU8Decoder,
  getU32Decoder,
  getU64Decoder,
} from "@solana/kit";

// Circle's ec16e95 IDL and LayerZero's 3.0.159 generated oft302 serializers.
// Kept as Kit codecs, with the upstream sources and byte fixtures pinned in tests.
const bytes32 = fixDecoderSize(getBytesDecoder(), 32);
const vector = addDecoderSizePrefix(getBytesDecoder(), getU32Decoder());
export const cctpBurnDecoder = getStructDecoder([
  ["discriminator", fixDecoderSize(getBytesDecoder(), 8)],
  ["amount", getU64Decoder()],
  ["domain", getU32Decoder()],
  ["recipient", bytes32],
  ["caller", bytes32],
  ["maxFee", getU64Decoder()],
  ["finality", getU32Decoder()],
  ["hook", vector],
]);
export const oftSendDecoder = getStructDecoder([
  ["discriminator", fixDecoderSize(getBytesDecoder(), 8)],
  ["dstEid", getU32Decoder()],
  ["to", bytes32],
  ["amount", getU64Decoder()],
  ["minimum", getU64Decoder()],
  ["options", vector],
  ["compose", getOptionDecoder(vector)],
  ["nativeFee", getU64Decoder()],
  ["lzTokenFee", getU64Decoder()],
]);
export const oftStoreDecoder = getStructDecoder([
  ["discriminator", fixDecoderSize(getBytesDecoder(), 8)],
  ["oftType", getU8Decoder()],
  ["rate", getU64Decoder()],
  ["mint", bytes32],
  ["escrow", bytes32],
  ["endpoint", bytes32],
]);

/** ABI words are bytes, not JS numbers. No amount passes through floating point. */
function word(value: bigint | string): string {
  const hex = typeof value === "bigint" ? value.toString(16) : value.replace(/^0x/, "");
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length > 64) throw new Error("Invalid ABI word");
  return hex.padStart(64, "0");
}
export function solanaWord(value: string): string {
  return Buffer.from(getAddressEncoder().encode(address(value))).toString("hex");
}
export function evmWord(value: string): Uint8Array {
  if (!/^0x[0-9a-f]{40}$/i.test(value)) throw new Error("Invalid EVM deployment address");
  return Buffer.from(word(value), "hex");
}
function sendParam(eid: number, receiver: string, amount: bigint, command?: bigint): string {
  const tail = command === undefined ? word(0n) : word(32n) + word(command);
  return [
    word(BigInt(eid)),
    receiver,
    word(amount),
    word(0n),
    word(224n),
    word(256n),
    word(288n),
    word(0n),
    word(0n),
    tail,
  ].join("");
}
export function mintHook(
  vault: PlumeVaultDeployment,
  owner: string,
  usdcAta: string,
  net: bigint
): Uint8Array {
  return Buffer.from(
    vault.mintComposer.slice(2) +
      "fe030ec4" +
      solanaWord(usdcAta) +
      word(net) +
      word(128n) +
      word(vault.mintComposer) +
      sendParam(PLUME_SOLANA_ENDPOINT_ID, solanaWord(owner), 0n),
    "hex"
  );
}
export function redeemCompose(
  usdcAta: string,
  shares: bigint,
  mode: "standard" | "instant",
  returnValue = 0n
): Uint8Array {
  return Buffer.from(
    word(64n) +
      word(returnValue) +
      sendParam(
        mode === "standard" ? PLUME_ENDPOINT_ID : PLUME_SOLANA_ENDPOINT_ID,
        solanaWord(usdcAta),
        mode === "standard" ? shares : 0n,
        mode === "standard" ? 1n : 0n
      ),
    "hex"
  );
}

export function cancelCompose(receiver: string, returnValue: bigint): Uint8Array {
  return Buffer.from(
    word(64n) +
      word(returnValue) +
      sendParam(PLUME_SOLANA_ENDPOINT_ID, solanaWord(receiver), 0n, 2n),
    "hex"
  );
}
