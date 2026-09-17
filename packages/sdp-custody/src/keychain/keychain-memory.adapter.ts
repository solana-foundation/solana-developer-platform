/** Local custody adapter backed by an in-memory @solana/kit keypair. */

import { getBase58Codec } from "@solana/codecs";
import { type Address, createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { SigningError } from "../signing";
import { BaseKeychainAdapter } from "./base-keychain.adapter";

const base58 = getBase58Codec();

export class KeychainMemoryAdapter extends BaseKeychainAdapter {
  readonly providerId = "local";

  private constructor(private readonly keypairSigner: KeyPairSigner) {
    super();
  }

  /** Create an adapter from a 64-byte, Base58-encoded Solana keypair. */
  static async fromBase58(privateKeyBase58: string): Promise<KeychainMemoryAdapter> {
    const secretKey = base58.encode(privateKeyBase58);
    if (secretKey.length !== 64) {
      throw new SigningError(
        `Invalid keypair length: expected 64 bytes, got ${secretKey.length}`,
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    return new KeychainMemoryAdapter(await createKeyPairSignerFromBytes(secretKey));
  }

  async getTransactionSigner(
    _walletId?: string,
    _walletPublicKey?: Address
  ): Promise<KeyPairSigner> {
    return this.keypairSigner;
  }
}
