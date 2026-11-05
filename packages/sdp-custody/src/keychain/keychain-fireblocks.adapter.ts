/**
 * Keychain Fireblocks Adapter
 *
 * Wraps @solana/keychain-fireblocks FireblocksSigner to implement SigningPort.
 * Fireblocks provides enterprise-grade MPC custody with approval workflows.
 *
 * The Keychain FireblocksSigner handles:
 * - JWT authentication with Fireblocks API
 * - RAW signing operation
 * - Polling for transaction completion
 *
 * A Fireblocks policy block on any signing call surfaces as a `POLICY_REFUSED`
 * {@link SigningError}; every other failure passes through unchanged.
 */

import { isFireblocksPolicyRefusal } from "@sdp/types/fireblocks";
import { SignerError, SignerErrorCode, type SolanaSigner } from "@solana/keychain-core";
import { FireblocksSigner } from "@solana/keychain-fireblocks";
import type { Address } from "@solana/kit";
import { z } from "zod";
import { SigningError } from "#/signing";
import { BaseKeychainAdapter } from "./base-keychain.adapter";
import type { KeychainFireblocksConfig } from "./types";

/**
 * The context keychain attaches when a Fireblocks transaction ends in a
 * terminal failure. The pinned patch
 * (`patches/@solana__keychain-fireblocks@1.4.0.patch`) keeps the status and
 * the sub-status, the latter only when it is a bare code.
 */
const fireblocksTerminalContextSchema = z.object({
  status: z.string(),
  subStatus: z.string().optional(),
});

// ═══════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class KeychainFireblocksAdapter extends BaseKeychainAdapter {
  readonly providerId = "fireblocks";

  private readonly config: KeychainFireblocksConfig;
  private readonly signerByVaultAccountId = new Map<string, Promise<SolanaSigner>>();

  constructor(config: KeychainFireblocksConfig) {
    super();
    this.config = config;
  }

  /**
   * Get the Fireblocks signer for direct use with @solana/kit. It signs with
   * keychain's RAW operation and never broadcasts.
   */
  async getTransactionSigner(walletId?: string, _walletPublicKey?: Address): Promise<SolanaSigner> {
    return this.getFireblocksSigner(walletId);
  }

  private getFireblocksSigner(walletId?: string): Promise<SolanaSigner> {
    const vaultAccountId = walletId
      ? denormalizeFireblocksWalletId(walletId)
      : this.config.vaultAccountId;
    const existing = this.signerByVaultAccountId.get(vaultAccountId);
    if (existing) {
      return existing;
    }

    const created = this.createInitializedSigner(vaultAccountId)
      .then(refusingPolicyBlocks)
      .catch((cause: unknown) => {
        if (this.signerByVaultAccountId.get(vaultAccountId) === created) {
          this.signerByVaultAccountId.delete(vaultAccountId);
        }
        throw cause;
      });
    this.signerByVaultAccountId.set(vaultAccountId, created);
    return created;
  }

  private async createInitializedSigner(vaultAccountId: string): Promise<FireblocksSigner> {
    const signer = new FireblocksSigner({
      apiKey: this.config.apiKey,
      privateKeyPem: this.config.apiSecretPem,
      vaultAccountId,
      assetId: this.config.assetId ?? "SOL",
      apiBaseUrl: this.config.apiBaseUrl,
      pollIntervalMs: this.config.pollIntervalMs,
      maxPollAttempts: this.config.maxPollAttempts,
      requestDelayMs: this.config.requestDelayMs,
      // RAW returns a signature; SDP owns fee sponsorship and broadcast.
      useProgramCall: false,
    });
    await signer.init();
    return signer;
  }
}

function denormalizeFireblocksWalletId(walletId: string): string {
  return walletId.startsWith("fb_") ? walletId.slice("fb_".length) : walletId;
}

/**
 * The Fireblocks signer with its signing calls translated at the waist: a
 * confirmed policy block becomes a `POLICY_REFUSED` {@link SigningError}.
 *
 * @param signer - The initialized Fireblocks signer.
 * @returns A signer with the same address and availability check.
 */
function refusingPolicyBlocks(signer: FireblocksSigner): SolanaSigner {
  return {
    address: signer.address,
    isAvailable: () => signer.isAvailable(),
    signMessages: (...args: Parameters<FireblocksSigner["signMessages"]>) =>
      signer.signMessages(...args).catch(rethrowFireblocksSigningError),
    signTransactions: (...args: Parameters<FireblocksSigner["signTransactions"]>) =>
      signer.signTransactions(...args).catch(rethrowFireblocksSigningError),
  };
}

/**
 * Rethrows a Fireblocks signing failure, as a `POLICY_REFUSED`
 * {@link SigningError} when Fireblocks reports the transaction `BLOCKED` with
 * `BLOCKED_BY_POLICY`, and unchanged otherwise: a pending approval keeps
 * polling inside keychain, and every other terminal status is the provider's
 * own failure.
 *
 * @param cause - What the Fireblocks signing call rejected with.
 * @returns Never; it always throws.
 */
function rethrowFireblocksSigningError(cause: unknown): never {
  if (cause instanceof SignerError && cause.code === SignerErrorCode.SIGNING_FAILED) {
    const context = fireblocksTerminalContextSchema.safeParse(cause.context);
    if (context.success && isFireblocksPolicyRefusal(context.data)) {
      throw new SigningError(
        "Fireblocks blocked the signing request by policy",
        "POLICY_REFUSED",
        cause
      );
    }
  }
  throw cause;
}
