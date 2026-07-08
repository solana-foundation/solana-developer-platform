/**
 * Keychain Utila Adapter
 *
 * Wraps @solana/keychain-utila to implement SigningPort.
 * Utila provides transaction signing for existing Solana wallets in Utila vaults.
 */

import type { SolanaSigner } from "@solana/keychain-core";
import { createUtilaSigner } from "@solana/keychain-utila";
import type { Address, TransactionSigner } from "@solana/kit";
import type { SignatureDictionary } from "@solana/signers";
import {
  getTransactionDecoder,
  type Transaction,
  type TransactionWithinSizeLimit,
  type TransactionWithLifetime,
} from "@solana/transactions";
import { denormalizeUtilaWalletId } from "../provider-wallet-ids";
import type { SignRequest, SignResult } from "../signing";
import { SigningError } from "../signing";
import { BaseKeychainAdapter } from "./base-keychain.adapter";
import type { KeychainUtilaConfig } from "./types";

type UtilaTransaction = Transaction & TransactionWithinSizeLimit & TransactionWithLifetime;

export class KeychainUtilaAdapter extends BaseKeychainAdapter {
  readonly providerId = "utila";

  private readonly config: KeychainUtilaConfig;
  private readonly signerByWalletId = new Map<string, Promise<SolanaSigner>>();

  constructor(config: KeychainUtilaConfig) {
    super();
    this.config = config;
  }

  protected get signer(): SolanaSigner {
    throw new SigningError("Utila signer must be resolved with a wallet ID", "INVALID_REQUEST");
  }

  /**
   * Get the underlying Utila signer for direct use with @solana/kit.
   */
  async getTransactionSigner(
    walletId?: string,
    _walletPublicKey?: Address
  ): Promise<TransactionSigner> {
    return this.getUtilaSigner(walletId);
  }

  /**
   * Utila is configured for automated service-account signing in SDP.
   * Human approval/co-signer flows would need async status persistence.
   */
  requiresApproval(): boolean {
    return false;
  }

  /**
   * Get the public key, ensuring initialization first.
   */
  async getPublicKey(walletId?: string): Promise<Address> {
    const signer = await this.getUtilaSigner(walletId);
    return signer.address as Address;
  }

  /**
   * Utila does not expose Solana message signing. Decode the wire transaction
   * from SigningPort.sign() and use the transaction signing API instead.
   */
  async sign(request: SignRequest): Promise<SignResult> {
    try {
      const signer = await this.getUtilaSigner();
      const isAvailable = await signer.isAvailable();
      if (!isAvailable) {
        return {
          status: "failed",
          error: "Utila signer not available",
        };
      }

      const transaction = getTransactionDecoder().decode(request.message) as UtilaTransaction;
      const [signatureDict] = await signer.signTransactions([transaction]);

      return {
        status: "completed",
        signatures: toSignatureMap(signatureDict),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown signing error";
      return {
        status: "failed",
        error: `utila: ${message}`,
      };
    }
  }

  private getUtilaSigner(walletId?: string): Promise<SolanaSigner> {
    const normalizedWalletId = walletId ?? this.config.defaultWalletId;
    if (!normalizedWalletId) {
      throw new SigningError("Utila wallet ID is required", "PROVIDER_NOT_CONFIGURED");
    }

    const cacheKey = normalizedWalletId;
    const existing = this.signerByWalletId.get(cacheKey);
    if (existing) {
      return existing;
    }

    const created = createUtilaSigner({
      serviceAccountEmail: this.config.serviceAccountEmail,
      serviceAccountPrivateKeyPem: this.config.serviceAccountPrivateKeyPem,
      vaultId: this.config.vaultId,
      walletId: denormalizeUtilaWalletId(normalizedWalletId),
      network: this.config.network,
      apiBaseUrl: this.config.apiBaseUrl,
      pollIntervalMs: this.config.pollIntervalMs,
      maxPollAttempts: this.config.maxPollAttempts,
      designatedSigners: this.config.designatedSigners,
    }).catch((error: unknown) => {
      if (this.signerByWalletId.get(cacheKey) === created) {
        this.signerByWalletId.delete(cacheKey);
      }
      throw error;
    });

    this.signerByWalletId.set(cacheKey, created);
    return created;
  }
}

function toSignatureMap(signatureDict: SignatureDictionary | undefined): Map<Address, Uint8Array> {
  const signatures = new Map<Address, Uint8Array>();
  for (const [addr, sig] of Object.entries(signatureDict ?? {})) {
    signatures.set(addr as Address, sig as Uint8Array);
  }
  return signatures;
}
