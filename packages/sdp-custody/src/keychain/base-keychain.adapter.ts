/** Shared base for custody adapters that expose @solana/kit transaction signers. */

import type { Address, TransactionSigner } from "@solana/kit";
import type { FullSigningPort } from "../signing";

export abstract class BaseKeychainAdapter implements FullSigningPort {
  abstract readonly providerId: string;

  abstract getTransactionSigner(
    walletId?: string,
    walletPublicKey?: Address
  ): Promise<TransactionSigner>;

  async getPublicKey(walletId?: string): Promise<Address> {
    const signer = await this.getTransactionSigner(walletId);
    return signer.address;
  }
}
