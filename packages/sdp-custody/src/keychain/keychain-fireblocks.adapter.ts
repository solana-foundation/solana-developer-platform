/**
 * Keychain Fireblocks Adapter
 *
 * Wraps @solana/keychain-fireblocks to implement SigningPort.
 * Fireblocks provides enterprise-grade MPC custody with approval workflows.
 *
 * The Keychain FireblocksSigner handles:
 * - JWT authentication with Fireblocks API
 * - RAW or sign-only PROGRAM_CALL proposals
 * - Polling for transaction completion
 *
 * A Fireblocks policy block on any signing call surfaces as a `POLICY_REFUSED`
 * {@link SigningError}; every other failure passes through unchanged.
 */

import { isFireblocksPolicyRefusal } from "@sdp/types/fireblocks";
import { SignerErrorCode } from "@solana/keychain-core";
import { createFireblocksSigner } from "@solana/keychain-fireblocks";
import type { Address } from "@solana/kit";
import { z } from "zod";
import { SigningError } from "#/signing";
import { BaseKeychainAdapter } from "./base-keychain.adapter";
import type { KeychainFireblocksConfig } from "./types";

/**
 * The context keychain attaches when a Fireblocks transaction ends in a
 * terminal failure. The pinned patch
 * (`patches/@solana__keychain-fireblocks@2.0.0.patch`) keeps the status and
 * the sub-status, the latter only when it is a bare code.
 */
const fireblocksTerminalErrorSchema = z.object({
  code: z.literal(SignerErrorCode.SIGNING_FAILED),
  context: z.object({
    status: z.string(),
    subStatus: z.string().optional(),
  }),
});

type FireblocksSigner = Awaited<ReturnType<typeof createFireblocksSigner>>;

// ═══════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class KeychainFireblocksAdapter extends BaseKeychainAdapter {
  readonly providerId = "fireblocks";

  private readonly config: KeychainFireblocksConfig;
  private readonly signerByVaultAccountId = new Map<string, Promise<FireblocksSigner>>();

  constructor(config: KeychainFireblocksConfig) {
    super();
    this.config = config;
  }

  /**
   * Get the Fireblocks signer for direct use with @solana/kit. It signs with
   * keychain's configured proposal operation and never broadcasts.
   */
  async getTransactionSigner(
    walletId?: string,
    _walletPublicKey?: Address
  ): Promise<FireblocksSigner> {
    return this.getFireblocksSigner(walletId);
  }

  private getFireblocksSigner(walletId?: string): Promise<FireblocksSigner> {
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
    return createFireblocksSigner({
      apiKey: this.config.apiKey,
      privateKeyPem: this.config.apiSecretPem,
      vaultAccountId,
      assetId: this.config.assetId ?? "SOL",
      apiBaseUrl: this.config.apiBaseUrl,
      pollIntervalMs: this.config.pollIntervalMs,
      maxPollAttempts: this.config.maxPollAttempts,
      requestDelayMs: this.config.requestDelayMs,
      // Both modes return a signature; SDP owns sponsorship and broadcast.
      useProgramCall: this.config.useProgramCall,
    });
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
function refusingPolicyBlocks(signer: FireblocksSigner): FireblocksSigner {
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
  // Fireblocks uses keychain 2; the other providers still use keychain 1.
  // Parse the SDK error contract rather than comparing different class identities.
  const error = fireblocksTerminalErrorSchema.safeParse(cause);
  if (cause instanceof Error && error.success && isFireblocksPolicyRefusal(error.data.context)) {
    throw new SigningError(
      "Fireblocks blocked the signing request by policy",
      "POLICY_REFUSED",
      cause
    );
  }
  throw cause;
}
