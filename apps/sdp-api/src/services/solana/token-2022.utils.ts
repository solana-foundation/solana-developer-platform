/**
 * Token-2022 Utilities
 *
 * Pure functions for Token-2022 operations.
 * Extracted from Token2022Service for testability.
 */

import type { TokenExtensionsConfig } from "@sdp/types";
import { type ExtensionArgs, extension } from "@solana-program/token-2022";
import type { Address, TransactionSigner } from "@solana/kit";

/**
 * JSON stringify replacer that handles BigInt values by converting them to strings.
 * Solana RPC responses often contain bigints (slots, lamports) that JSON.stringify can't handle.
 */
export function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Safely stringify a value that may contain BigInt values.
 */
export function safeStringify(value: unknown): string {
  return JSON.stringify(value, bigIntReplacer);
}

/**
 * Create a proxy "signer" from an address for use in instruction builders.
 * This allows using an external signer's address (like Kora's fee payer)
 * in instructions without having the actual signing capability locally.
 * The real signature will be added later by the external signer.
 */
export function addressAsSigner(address: Address): TransactionSigner {
  return { address } as TransactionSigner;
}

/**
 * Convert TokenExtensionsConfig to ExtensionArgs array for getMintSize calculation.
 *
 * Supports:
 * - TransferFeeConfig: Fee on transfers
 * - PermanentDelegate: Permanent delegate authority
 * - DefaultAccountState: Default state for new token accounts
 * - NonTransferable: Soulbound tokens
 */
export function getExtensionTypes(extensions?: TokenExtensionsConfig): ExtensionArgs[] {
  if (!extensions) return [];

  const types: ExtensionArgs[] = [];

  if (extensions.transferFee) {
    types.push(
      // biome-ignore lint/nursery/noSecrets: Token-2022 extension type identifier
      extension("TransferFeeConfig", {
        transferFeeConfigAuthority: extensions.transferFee.transferFeeConfigAuthority as Address,
        withdrawWithheldAuthority: extensions.transferFee.withdrawWithheldAuthority as Address,
        withheldAmount: 0n,
        olderTransferFee: {
          epoch: 0n,
          maximumFee: BigInt(extensions.transferFee.maxFee),
          transferFeeBasisPoints: extensions.transferFee.basisPoints,
        },
        newerTransferFee: {
          epoch: 0n,
          maximumFee: BigInt(extensions.transferFee.maxFee),
          transferFeeBasisPoints: extensions.transferFee.basisPoints,
        },
      })
    );
  }

  if (extensions.permanentDelegate) {
    types.push(
      // biome-ignore lint/nursery/noSecrets: Token-2022 extension type identifier
      extension("PermanentDelegate", {
        delegate: extensions.permanentDelegate as Address,
      })
    );
  }

  if (extensions.defaultAccountState) {
    // 0 = Uninitialized, 1 = Initialized, 2 = Frozen
    const state = extensions.defaultAccountState === "frozen" ? 2 : 1;
    // biome-ignore lint/nursery/noSecrets: Token-2022 extension type identifier
    types.push(extension("DefaultAccountState", { state }));
  }

  if (extensions.nonTransferable) {
    types.push(extension("NonTransferable", {}));
  }

  return types;
}
