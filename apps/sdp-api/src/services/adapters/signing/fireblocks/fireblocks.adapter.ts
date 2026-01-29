/**
 * Fireblocks Signing Adapter
 *
 * Implements SigningPort for Fireblocks MPC custody.
 * Supports async approval workflows with polling.
 */

import type {
  GeneratedKeypair,
  SignRequest,
  SignResult,
  SignStatus,
  SigningPort,
} from "@/services/ports";
import { SigningError } from "@/services/ports";
import type { Address } from "@solana/kit";
import { FireblocksClient } from "./client";
import type {
  FireblocksAdapterConfig,
  FireblocksSignedMessage,
  FireblocksTransaction,
} from "./types";
import { FIREBLOCKS_PENDING_STATUSES, FIREBLOCKS_REJECTED_STATUSES } from "./types";
import { bytesToHex, normalizePublicKey, normalizeSignatureToBytes } from "./utils";

// ═══════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class FireblocksAdapter implements SigningPort {
  readonly providerId = "fireblocks";

  private client: FireblocksClient;
  private vaultAccountId: string;
  private assetId: string;
  private defaultWalletId?: string;

  constructor(config: FireblocksAdapterConfig) {
    this.client = new FireblocksClient({
      apiKey: config.apiKey,
      apiSecretPem: config.apiSecretPem,
      baseUrl: config.apiBaseUrl,
    });
    this.vaultAccountId = config.vaultAccountId;
    this.assetId = config.assetId;
    this.defaultWalletId = config.defaultWalletId;
  }

  /**
   * Fireblocks always requires async approval workflows
   */
  requiresApproval(): boolean {
    return true;
  }

  /**
   * Get the public key for a wallet in the vault
   */
  async getPublicKey(walletId?: string): Promise<Address> {
    const addressId = walletId ?? this.defaultWalletId;
    if (!addressId) {
      throw new SigningError(
        "Fireblocks requires a walletId or defaultWalletId to resolve public key",
        "WALLET_NOT_FOUND"
      );
    }

    try {
      const address = await this.client.getVaultAddress({
        vaultAccountId: this.vaultAccountId,
        assetId: this.assetId,
        addressId,
      });

      const value = address.publicKey ?? address.address;
      return normalizePublicKey(value);
    } catch (error) {
      throw new SigningError(
        `Failed to get public key for wallet ${addressId}`,
        "WALLET_NOT_FOUND",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Sign a transaction message via Fireblocks RAW signing
   */
  async sign(request: SignRequest): Promise<SignResult> {
    const messageHex = bytesToHex(request.message);
    const idempotencyKey = crypto.randomUUID();
    const externalTxId = `sig_${crypto.randomUUID()}`;

    try {
      const tx = await this.client.createRawTransaction({
        vaultAccountId: this.vaultAccountId,
        assetId: this.assetId,
        messageHex,
        externalTxId,
        idempotencyKey,
      });

      return this.mapTransactionToSignResult(tx, request.signers);
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error during signing",
      };
    }
  }

  /**
   * Poll for the status of an async signing request
   */
  async getSignStatus(requestId: string): Promise<SignStatus> {
    try {
      const tx = await this.client.getTransaction(requestId);
      return this.mapTransactionToSignStatus(tx);
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : "Failed to get signing status",
      };
    }
  }

  /**
   * Generate a new keypair in the Fireblocks vault
   */
  async generateKeypair(): Promise<GeneratedKeypair> {
    // Fireblocks keypair generation requires vault management API
    // This would need to create a new address within the vault
    throw new SigningError("Fireblocks keypair generation not yet implemented", "INVALID_REQUEST");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Map Fireblocks transaction to SignResult
   */
  private mapTransactionToSignResult(
    tx: FireblocksTransaction,
    requestedSigners: Address[]
  ): SignResult {
    if (tx.status === "COMPLETED") {
      const signatures = this.extractSignatures(tx.signedMessages, requestedSigners[0]);
      if (signatures.size === 0) {
        return { status: "failed", error: "Fireblocks completed without signatures" };
      }
      return { status: "completed", signatures };
    }

    if (FIREBLOCKS_PENDING_STATUSES.has(tx.status)) {
      return { status: "pending", requestId: tx.id };
    }

    if (FIREBLOCKS_REJECTED_STATUSES.has(tx.status)) {
      return {
        status: "rejected",
        error: tx.subStatus ?? "Fireblocks request rejected",
      };
    }

    return {
      status: "failed",
      error: tx.subStatus ?? `Fireblocks request failed (${tx.status})`,
    };
  }

  /**
   * Map Fireblocks transaction to SignStatus (for polling)
   */
  private mapTransactionToSignStatus(tx: FireblocksTransaction): SignStatus {
    if (tx.status === "COMPLETED") {
      const signatures = this.extractSignatures(tx.signedMessages);
      if (signatures.size === 0) {
        return { status: "failed", error: "Fireblocks completed without signatures" };
      }
      return { status: "completed", signatures };
    }

    if (FIREBLOCKS_REJECTED_STATUSES.has(tx.status)) {
      return { status: "rejected", reason: tx.subStatus ?? tx.status };
    }

    if (tx.status === "FAILED") {
      return { status: "failed", error: tx.subStatus ?? "Fireblocks request failed" };
    }

    // All other statuses are considered pending
    return { status: "pending" };
  }

  /**
   * Extract signatures from Fireblocks signed messages
   */
  private extractSignatures(
    signedMessages: FireblocksSignedMessage[] | undefined,
    fallbackPublicKey?: Address
  ): Map<Address, Uint8Array> {
    const signatures = new Map<Address, Uint8Array>();

    if (!signedMessages || signedMessages.length === 0) {
      return signatures;
    }

    for (const message of signedMessages) {
      const signatureBytes = normalizeSignatureToBytes(message.signature);
      const publicKeyValue = message.publicKey ?? fallbackPublicKey;

      if (!signatureBytes || !publicKeyValue) {
        continue;
      }

      const publicKey = normalizePublicKey(publicKeyValue);
      signatures.set(publicKey, signatureBytes);
    }

    return signatures;
  }
}
