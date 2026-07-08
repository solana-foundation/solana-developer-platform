/**
 * DFNS Signing Adapter
 *
 * Wraps the internal DFNS signer to implement SigningPort.
 */

import type { SolanaSigner } from "@solana/keychain-core";
import type { Address } from "@solana/kit";
import { DFNS_PROVIDER_LABEL } from "../dfns/client";
import { DfnsSigner } from "../dfns/signer";
import type { SignRequest, SignResult } from "../signing";
import { SigningError } from "../signing";
import { BaseKeychainAdapter } from "./base-keychain.adapter";
import type { KeychainDfnsConfig } from "./types";

export class KeychainDfnsAdapter extends BaseKeychainAdapter {
  // Widened from the "dfns" literal to `string` so the KeychainIbmHavenAdapter
  // subclass can override providerId — tsc rejects the override otherwise, because
  // the immediate parent narrows this readonly field to "dfns" (base is abstract `string`).
  readonly providerId: string = "dfns";

  /** Display label interpolated into signer error messages (overridden by white-label subclasses). */
  protected readonly providerLabel: string = DFNS_PROVIDER_LABEL;

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
  async getTransactionSigner(walletId?: string, _walletPublicKey?: Address): Promise<DfnsSigner> {
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
      throw new SigningError(
        `${this.providerLabel} wallet ID is required`,
        "PROVIDER_NOT_CONFIGURED"
      );
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
      providerLabel: this.providerLabel,
    });
    this.signerByWalletId.set(cacheKey, created);
    return created;
  }
}
