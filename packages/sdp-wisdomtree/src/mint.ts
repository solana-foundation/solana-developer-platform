import { SdpWisdomTreeError } from "./errors";

/**
 * Minimal Token-2022 mint parser — just the fields this package must verify
 * before building against a fund: initialization and decimals from the base
 * layout, plus transfer-hook and pausable state from the TLV extensions.
 *
 * Hand-rolled rather than pulled from `@solana-program/token-2022`'s decoder
 * because the builders only need these few fields and the parse must fail CLOSED on
 * anything structurally surprising: an account that does not parse is an
 * account this package refuses to move money against.
 *
 * Layout (SPL Token-2022):
 *   0..82    base mint (decimals at byte 44)
 *   82..165  padding
 *   165      account type (1 = mint)
 *   166..    TLV entries: u16 type, u16 length, body
 * TransferHook extension (type 14) body: authority (32) ++ hook program (32).
 */

const MINT_BASE_LENGTH = 82;
const ACCOUNT_TYPE_OFFSET = 165;
const ACCOUNT_TYPE_MINT = 1;
const EXTENSION_TRANSFER_HOOK = 14;
// `ExtensionType::Pausable` in the canonical Token-2022 interface enum.
const EXTENSION_PAUSABLE = 26;

export interface ParsedFundMint {
  decimals: number;
  initialized: boolean;
  /** Absent when the mint has no Pausable config. */
  paused?: boolean;
  /** Base58 transfer-hook program, absent when the mint carries no hook. */
  transferHookProgram?: string;
}

// biome-ignore lint/security/noSecrets: the public base58 alphabet, not a credential
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }
  let out = "";
  while (value > 0n) {
    out = BASE58_ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out === "" ? "1".repeat(bytes.length) : out;
}

/** All-zero pubkeys mean "none" in several Token-2022 extension slots. */
function isZeroed(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

export function parseFundMint(data: Uint8Array): ParsedFundMint {
  if (data.length < MINT_BASE_LENGTH) {
    throw new SdpWisdomTreeError(
      "MINT_MISMATCH",
      `Mint account data is ${data.length} bytes — shorter than a token mint.`
    );
  }
  const decimals = data[44] as number;
  const initialized = data[45] === 1;

  // A bare 82-byte mint has no extensions and no hook.
  if (data.length <= ACCOUNT_TYPE_OFFSET) {
    return { decimals, initialized };
  }
  if (data[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT) {
    throw new SdpWisdomTreeError(
      "MINT_MISMATCH",
      "Token-2022 account type byte does not mark this account as a mint."
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = ACCOUNT_TYPE_OFFSET + 1;
  let transferHookProgram: string | undefined;
  let paused: boolean | undefined;
  while (offset + 4 <= data.length) {
    const extensionType = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    const bodyStart = offset + 4;
    if (bodyStart + length > data.length) {
      throw new SdpWisdomTreeError(
        "MINT_MISMATCH",
        "Token-2022 TLV extension overruns the account data; refusing the parse."
      );
    }
    if (extensionType === EXTENSION_TRANSFER_HOOK) {
      const program = data.subarray(bodyStart + 32, bodyStart + 64);
      if (program.length === 32 && !isZeroed(program)) {
        transferHookProgram = encodeBase58(program);
      }
    }
    if (extensionType === EXTENSION_PAUSABLE) {
      // PausableConfig is `MaybeNull<Address> authority` followed by the
      // one-byte unaligned Bool. Anything but an exact 0/1 is malformed.
      if (length !== 33) {
        throw new SdpWisdomTreeError(
          "MINT_MISMATCH",
          `Token-2022 Pausable extension has length ${length}, expected 33.`
        );
      }
      const pausedByte = data[bodyStart + 32];
      if (pausedByte !== 0 && pausedByte !== 1) {
        throw new SdpWisdomTreeError(
          "MINT_MISMATCH",
          "Token-2022 Pausable extension carries an invalid boolean."
        );
      }
      paused = pausedByte === 1;
    }
    offset = bodyStart + length;
  }

  return {
    decimals,
    initialized,
    ...(paused === undefined ? {} : { paused }),
    ...(transferHookProgram === undefined ? {} : { transferHookProgram }),
  };
}
