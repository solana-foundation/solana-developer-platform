/**
 * DFNS Signing Adapter
 *
 * Wraps @sdp/keychain-dfns DfnsSigner to implement SigningPort.
 */

import type { SignRequest, SignResult } from "@/services/ports";
import { SigningError } from "@/services/ports";
import { DfnsSigner } from "@sdp/keychain-dfns";
import type { SolanaSigner } from "@solana/keychain-core";
import type { Address } from "@solana/kit";
import { BaseKeychainAdapter } from "./base-keychain.adapter";
import type { KeychainDfnsConfig } from "./types";

export class KeychainDfnsAdapter extends BaseKeychainAdapter {
  readonly providerId = "dfns";

  protected signer!: SolanaSigner;

  private readonly config: KeychainDfnsConfig;
  private readonly signerByWalletId = new Map<string, Promise<DfnsSigner>>();

  constructor(config: KeychainDfnsConfig) {
    super();
    this.config = config;
  }

  /**
   * Get the underlying DFNS signer for direct use with @solana/kit.
   */
  async getTransactionSigner(walletId?: string): Promise<DfnsSigner> {
    return this.getDfnsSigner(walletId);
  }

  requiresApproval(): boolean {
    return false;
  }

  async getPublicKey(walletId?: string): Promise<Address> {
    const signer = await this.getDfnsSigner(walletId);
    return signer.address as Address;
  }

  async sign(request: SignRequest): Promise<SignResult> {
    const signer = await this.getDfnsSigner();
    this.signer = signer as unknown as SolanaSigner;
    return super.sign(request);
  }

  private async getDfnsSigner(walletId?: string): Promise<DfnsSigner> {
    const normalizedWalletId = walletId ?? this.config.defaultWalletId;
    if (!normalizedWalletId) {
      throw new SigningError("DFNS wallet ID is required", "PROVIDER_NOT_CONFIGURED");
    }

    const cacheKey = normalizedWalletId;
    const existing = this.signerByWalletId.get(cacheKey);
    if (existing) {
      return existing;
    }

    const created = DfnsSigner.create({
      client: this.config.client,
      walletId: normalizedWalletId,
      requestDelayMs: this.config.requestDelayMs,
    });
    this.signerByWalletId.set(cacheKey, created);
    return created;
  }
}
