/**
 * Keychain Turnkey Adapter
 *
 * Wraps @solana/keychain-turnkey TurnkeySigner to implement SigningPort.
 * Turnkey provides hosted wallet custody via the Turnkey API.
 */

import type { SolanaSigner } from "@solana/keychain-core";
import { TurnkeySigner } from "@solana/keychain-turnkey";
import type {
  Address,
  Transaction,
  TransactionWithinSizeLimit,
  TransactionWithLifetime,
} from "@solana/kit";
import { createSignableMessage, type SignatureDictionary } from "@solana/signers";
import type { SignRequest, SignResult } from "../signing";
import { BaseKeychainAdapter } from "./base-keychain.adapter";
import type { KeychainTurnkeyConfig } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════

type TurnkeyTransaction = Transaction & TransactionWithinSizeLimit & TransactionWithLifetime;

/**
 * Work around @solana/keychain-turnkey@0.3.0 extracting signature slot 0.
 *
 * Kora signer-check transactions include multiple signers (fee payer + org signer),
 * so the org signer is not guaranteed to be the first signature slot.
 */
class SdpTurnkeySigner<TAddress extends string = string> extends TurnkeySigner<TAddress> {
  async signTransactions(
    transactions: readonly TurnkeyTransaction[]
  ): Promise<readonly SignatureDictionary[]> {
    const messages = transactions.map((transaction) =>
      createSignableMessage(new Uint8Array(transaction.messageBytes))
    );
    return this.signMessages(messages);
  }
}

export class KeychainTurnkeyAdapter extends BaseKeychainAdapter {
  readonly providerId = "turnkey";

  protected signer!: SolanaSigner;

  private readonly config: KeychainTurnkeyConfig;
  private readonly signerByWalletId = new Map<string, Promise<SdpTurnkeySigner>>();

  constructor(config: KeychainTurnkeyConfig) {
    super();
    this.config = config;
  }

  /**
   * Get the underlying Turnkey signer for direct use with @solana/kit.
   */
  async getTransactionSigner(walletId?: string, walletPublicKey?: Address): Promise<TurnkeySigner> {
    return this.getTurnkeySigner(walletId, walletPublicKey);
  }

  /**
   * Turnkey signing is synchronous from the API perspective.
   */
  requiresApproval(): boolean {
    return false;
  }

  /**
   * Get the public key, ensuring initialization first.
   */
  async getPublicKey(walletId?: string, walletPublicKey?: Address): Promise<Address> {
    const signer = await this.getTurnkeySigner(walletId, walletPublicKey);
    return signer.address as Address;
  }

  /**
   * SigningPort does not specify a wallet ID; for Turnkey, we sign with the
   * configured default wallet.
   */
  async sign(request: SignRequest): Promise<SignResult> {
    const signer = await this.getTurnkeySigner();
    this.signer = signer as unknown as SolanaSigner;
    return super.sign(request);
  }

  private async getTurnkeySigner(
    walletId?: string,
    walletPublicKey?: Address
  ): Promise<SdpTurnkeySigner> {
    const normalizedWalletId = walletId ?? this.config.defaultWalletId;
    if (!normalizedWalletId) {
      throw new Error("Turnkey wallet ID is required");
    }

    const resolvedPublicKey =
      walletPublicKey ||
      (normalizedWalletId === this.config.defaultWalletId
        ? this.config.defaultWalletPublicKey
        : undefined);
    if (!resolvedPublicKey) {
      throw new Error("Turnkey wallet public key is required");
    }

    const cacheKey = normalizedWalletId;
    const existing = this.signerByWalletId.get(cacheKey);
    if (existing) {
      return existing;
    }

    const created = Promise.resolve(
      new SdpTurnkeySigner({
        apiPublicKey: this.config.apiPublicKey,
        apiPrivateKey: this.config.apiPrivateKey,
        organizationId: this.config.organizationId,
        privateKeyId: denormalizeTurnkeyWalletId(normalizedWalletId),
        publicKey: resolvedPublicKey,
        apiBaseUrl: this.config.apiBaseUrl,
        requestDelayMs: this.config.requestDelayMs,
      })
    );

    this.signerByWalletId.set(cacheKey, created);
    return created;
  }
}

function denormalizeTurnkeyWalletId(walletId: string): string {
  return walletId.startsWith("turnkey_") ? walletId.slice("turnkey_".length) : walletId;
}
