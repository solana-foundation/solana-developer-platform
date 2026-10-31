/**
 * Keychain Privy Adapter
 *
 * Wraps @solana/keychain-privy PrivySigner to implement SigningPort.
 * Privy provides hosted wallet custody via the Privy Wallet API.
 */

import { SignerError, SignerErrorCode, type SolanaSigner } from "@solana/keychain-core";
import { PrivySigner } from "@solana/keychain-privy";
import type { Address } from "@solana/kit";
import { z } from "zod";
import { SigningError } from "#/signing";
import { BaseKeychainAdapter } from "./base-keychain.adapter";
import type { KeychainPrivyConfig } from "./types";

/**
 * Keychain retains the top-level provider code before truncating the error
 * body. Only Privy's documented `policy_violation` code is a policy refusal.
 * https://docs.privy.io/basics/troubleshooting/error-handling/api-errors
 */
const privyPolicyViolationContextSchema = z.object({
  responseCode: z.literal("policy_violation"),
});

// ═══════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class KeychainPrivyAdapter extends BaseKeychainAdapter {
  readonly providerId = "privy";

  readonly appId: string;
  readonly requestDelayMs: number | undefined;

  private readonly config: KeychainPrivyConfig;
  private readonly signerByWalletId = new Map<string, Promise<SolanaSigner>>();

  constructor(config: KeychainPrivyConfig) {
    super();
    this.config = config;
    this.appId = config.appId;
    this.requestDelayMs = config.requestDelayMs;
  }

  /**
   * Get the Privy signer for direct use with @solana/kit. A Privy policy
   * violation on any signing call surfaces as a `POLICY_REFUSED`
   * {@link SigningError}; every other failure passes through unchanged.
   */
  async getTransactionSigner(walletId?: string, _walletPublicKey?: Address): Promise<SolanaSigner> {
    return this.getPrivySigner(walletId);
  }

  private async getPrivySigner(walletId?: string): Promise<SolanaSigner> {
    const normalizedWalletId = walletId ?? this.config.defaultWalletId;
    if (!normalizedWalletId) {
      throw new Error("Privy wallet ID is required");
    }

    const cacheKey = normalizedWalletId;
    const existing = this.signerByWalletId.get(cacheKey);
    if (existing) {
      return existing;
    }

    const created = PrivySigner.create({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      walletId: denormalizePrivyWalletId(normalizedWalletId),
      apiBaseUrl: this.config.apiBaseUrl,
      requestDelayMs: this.config.requestDelayMs,
    })
      .then(refusingPolicyViolations)
      .catch((error: unknown) => {
        if (this.signerByWalletId.get(cacheKey) === created) {
          this.signerByWalletId.delete(cacheKey);
        }
        throw error;
      });

    this.signerByWalletId.set(cacheKey, created);
    return created;
  }
}

function denormalizePrivyWalletId(walletId: string): string {
  return walletId.startsWith("privy_") ? walletId.slice("privy_".length) : walletId;
}

/**
 * The Privy signer with its signing calls translated at the waist: a policy
 * violation becomes a `POLICY_REFUSED` {@link SigningError}.
 *
 * @param signer - The initialized Privy signer.
 * @returns A signer with the same address and availability check.
 */
function refusingPolicyViolations(signer: PrivySigner): SolanaSigner {
  return {
    address: signer.address,
    isAvailable: () => signer.isAvailable(),
    signMessages: (...args: Parameters<PrivySigner["signMessages"]>) =>
      signer.signMessages(...args).catch(rethrowPrivySigningError),
    signTransactions: (...args: Parameters<PrivySigner["signTransactions"]>) =>
      signer.signTransactions(...args).catch(rethrowPrivySigningError),
  };
}

/**
 * Rethrows a Privy signing failure, as a `POLICY_REFUSED` {@link SigningError}
 * when Privy's answer is a policy violation and unchanged otherwise.
 *
 * @param error - What the Privy signing call rejected with.
 * @returns Never; it always throws.
 */
function rethrowPrivySigningError(error: unknown): never {
  if (
    error instanceof SignerError &&
    error.code === SignerErrorCode.REMOTE_API_ERROR &&
    privyPolicyViolationContextSchema.safeParse(error.context).success
  ) {
    throw new SigningError(
      "The custody provider's policy refused to sign this request",
      "POLICY_REFUSED",
      error
    );
  }
  throw error;
}
