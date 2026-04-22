/**
 * Keychain Memory Adapter
 *
 * Wraps a KeyPairSigner from @solana/kit in a SolanaSigner-compatible wrapper.
 * This allows the local/development signing to use the same BaseKeychainAdapter
 * infrastructure as Fireblocks, enabling easy provider swapping via env vars.
 *
 * The MemorySigner class implements SolanaSigner by delegating to KeyPairSigner.
 * Both interfaces are compatible since KeyPairSigner implements TransactionPartialSigner
 * and SolanaSigner extends TransactionPartialSigner.
 */

import { getBase58Codec } from "@solana/codecs";
import type { SolanaSigner } from "@solana/keychain-core";
import {
  type Address,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  type KeyPairSigner,
  type SignableMessage,
  type SignatureDictionary,
  type Transaction,
  type TransactionWithinSizeLimit,
  type TransactionWithLifetime,
} from "@solana/kit";
import type { GeneratedKeypair } from "@/services/ports";
import { SigningError } from "@/services/ports";
import { BaseKeychainAdapter } from "./base-keychain.adapter";

const base58 = getBase58Codec();

// ═══════════════════════════════════════════════════════════════════════════
// MemorySigner - SolanaSigner wrapper for KeyPairSigner
// ═══════════════════════════════════════════════════════════════════════════

/**
 * MemorySigner wraps a KeyPairSigner to implement the SolanaSigner interface.
 *
 * This allows KeyPairSigner (from @solana/kit) to be used anywhere a SolanaSigner
 * (from @solana/keychain-core) is expected, enabling unified adapter architecture.
 */
class MemorySigner implements SolanaSigner {
  readonly address: Address;
  private keypairSigner: KeyPairSigner;

  constructor(keypairSigner: KeyPairSigner) {
    this.keypairSigner = keypairSigner;
    this.address = keypairSigner.address;
  }

  /**
   * Memory signer is always available - it's just an in-memory keypair.
   */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  /**
   * Sign messages using the underlying KeyPairSigner.
   * KeyPairSigner.signMessages returns ReadonlySignatureDictionary[].
   */
  async signMessages(
    messages: readonly SignableMessage[]
  ): Promise<readonly SignatureDictionary[]> {
    return this.keypairSigner.signMessages(messages);
  }

  /**
   * Sign transactions using the underlying KeyPairSigner.
   *
   * KeyPairSigner implements TransactionPartialSigner which returns
   * SignatureDictionary[] directly - the same format SolanaSigner expects.
   */
  async signTransactions(
    transactions: readonly (Transaction & TransactionWithinSizeLimit & TransactionWithLifetime)[]
  ): Promise<readonly SignatureDictionary[]> {
    return this.keypairSigner.signTransactions(transactions);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// KeychainMemoryAdapter
// ═══════════════════════════════════════════════════════════════════════════

/**
 * KeychainMemoryAdapter uses an in-memory keypair for signing.
 *
 * This adapter:
 * - Extends BaseKeychainAdapter for unified SigningPort interface
 * - Wraps KeyPairSigner in MemorySigner for SolanaSigner compatibility
 * - Exposes getTransactionSigner() for direct use with @solana/kit utilities
 * - Supports ephemeral keypair generation for mint accounts
 *
 * Use this for:
 * - Local development
 * - Testing
 * - Situations where custody isn't needed
 */
export class KeychainMemoryAdapter extends BaseKeychainAdapter {
  readonly providerId = "local";

  protected signer: SolanaSigner;
  private keypairSigner: KeyPairSigner;

  private constructor(keypairSigner: KeyPairSigner) {
    super();
    this.keypairSigner = keypairSigner;
    this.signer = new MemorySigner(keypairSigner);
  }

  /**
   * Create adapter from a Base58-encoded Solana keypair.
   * The keypair should be 64 bytes: 32 byte private + 32 byte public.
   */
  static async fromBase58(privateKeyBase58: string): Promise<KeychainMemoryAdapter> {
    // codec.encode converts base58 string → bytes
    const secretKey = base58.encode(privateKeyBase58);

    // Solana keypair format: 64 bytes = 32 byte private + 32 byte public
    if (secretKey.length !== 64) {
      throw new SigningError(
        `Invalid keypair length: expected 64 bytes, got ${secretKey.length}`,
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    const keypairSigner = await createKeyPairSignerFromBytes(secretKey);
    return new KeychainMemoryAdapter(keypairSigner);
  }

  /**
   * Get the underlying KeyPairSigner for direct use with @solana/kit.
   *
   * This allows integration with:
   * - signTransactionMessageWithSigners()
   * - partiallySignTransactionMessageWithSigners()
   * - addSignersToTransactionMessage()
   */
  async getTransactionSigner(
    _walletId?: string,
    _walletPublicKey?: Address
  ): Promise<KeyPairSigner> {
    return this.keypairSigner;
  }

  getKeypairSigner(): KeyPairSigner {
    return this.keypairSigner;
  }

  /**
   * Generate a new ephemeral keypair.
   *
   * Used for mint account creation where the keypair is only needed during
   * transaction building. The mint account itself becomes the permanent address.
   *
   * Note: This overrides BaseKeychainAdapter which throws by default.
   */
  async generateKeypair(): Promise<GeneratedKeypair> {
    const keypair = await generateKeyPairSigner();
    return {
      walletId: keypair.address, // Use address as ID for memory provider
      publicKey: keypair.address,
    };
  }
}
