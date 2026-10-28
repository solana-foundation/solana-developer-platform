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
 * The remote-error context keychain attaches to a non-2xx Privy answer, read
 * as a Privy policy violation: Privy's error body (`{ error, code }`, see
 * https://docs.privy.io/recipes/using-stateful-policies) with the documented
 * `policy_violation` code (https://docs.privy.io/basics/troubleshooting/error-handling/api-errors).
 * Keychain truncates the body past 256 characters; a truncated body no longer
 * parses, so it stays the provider's own error rather than a policy refusal.
 */
const privyPolicyViolationContextSchema = z.object({
  response: z
    .string()
    .transform((body, ctx): unknown => {
      try {
        return JSON.parse(body);
      } catch {
        ctx.addIssue({ code: "custom", message: "Privy error body is not JSON" });
        return z.NEVER;
      }
    })
    .pipe(z.object({ code: z.literal("policy_violation") })),
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
