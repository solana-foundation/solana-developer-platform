/**
 * Fireblocks Custody Provider
 */

import type { Address } from "@solana/kit";
import type {
  CustodyConfigRecord,
  FireblocksCustodyConfig,
  SignRequest,
  SignResponse,
} from "../types";
import type { CustodyProvider, SignatureStatus } from "../types";
import { FireblocksClient } from "./client";
import type {
  FireblocksProviderConfig,
  FireblocksSignedMessage,
  FireblocksTransaction,
} from "./types";
import { base64ToBytes, bytesToHex, normalizePublicKey, normalizeSignature } from "./utils";

const PENDING_STATUSES = new Set([
  "SUBMITTED",
  "PENDING_AUTHORIZATION",
  "PENDING_SIGNATURE",
  "QUEUED",
  "PENDING_AML_SCREENING",
]);

const REJECTED_STATUSES = new Set(["BLOCKED", "CANCELLED", "REJECTED", "DENIED"]);

export class FireblocksProvider implements CustodyProvider {
  readonly providerId = "fireblocks";

  private client: FireblocksClient;
  private vaultAccountId: string;
  private assetId: string;
  private defaultWalletId?: string;

  constructor(config: FireblocksProviderConfig) {
    this.client = new FireblocksClient({
      apiKey: config.apiKey,
      apiSecretPem: config.apiSecretPem,
      baseUrl: config.apiBaseUrl,
    });
    this.vaultAccountId = config.vaultAccountId;
    this.assetId = config.assetId;
    this.defaultWalletId = config.defaultWalletId;
  }

  requiresApproval(): boolean {
    return true;
  }

  async getPublicKey(walletId?: string): Promise<Address> {
    const addressId = walletId ?? this.defaultWalletId;
    if (!addressId) {
      throw new Error("Fireblocks requires a walletId or defaultWalletId to resolve public key");
    }

    const address = await this.client.getVaultAddress({
      vaultAccountId: this.vaultAccountId,
      assetId: this.assetId,
      addressId,
    });

    const value = address.publicKey ?? address.address;
    return normalizePublicKey(value);
  }

  async sign(request: SignRequest): Promise<SignResponse> {
    const messageBytes = base64ToBytes(request.transactionMessage);
    const messageHex = bytesToHex(messageBytes);

    const idempotencyKey = crypto.randomUUID();
    const externalTxId = `sig_${crypto.randomUUID()}`;

    const tx = await this.client.createRawTransaction({
      vaultAccountId: this.vaultAccountId,
      assetId: this.assetId,
      messageHex,
      externalTxId,
      idempotencyKey,
    });

    if (tx.status === "COMPLETED") {
      const signatures = extractSignatures(tx.signedMessages, request.signers[0]?.publicKey);
      if (signatures.length === 0) {
        return { status: "failed", error: "Fireblocks completed without signatures" };
      }
      return { status: "completed", signatures };
    }

    if (PENDING_STATUSES.has(tx.status)) {
      return { status: "pending_approval", signatureRequestId: tx.id };
    }

    if (REJECTED_STATUSES.has(tx.status)) {
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

  async getSignatureStatus(requestId: string): Promise<SignatureStatus> {
    const tx = await this.client.getTransaction(requestId);
    return mapTransactionStatus(tx);
  }

  async generateKeypair(): Promise<{ walletId: string; publicKey: Address }> {
    throw new Error("Fireblocks keypair generation not implemented");
  }
}

export function parseFireblocksConfig(record: CustodyConfigRecord): FireblocksProviderConfig {
  let parsed: Partial<FireblocksCustodyConfig> = {};
  try {
    parsed = JSON.parse(record.config) as Partial<FireblocksCustodyConfig>;
  } catch {
    throw new Error("Invalid Fireblocks custody configuration JSON");
  }

  if (parsed.provider && parsed.provider !== "fireblocks") {
    throw new Error("Custody configuration provider mismatch");
  }

  if (!parsed.apiKey || !parsed.apiSecretEncrypted || !parsed.vaultAccountId || !parsed.assetId) {
    throw new Error(
      "Fireblocks config missing apiKey, apiSecretEncrypted, vaultAccountId, or assetId"
    );
  }

  return {
    apiKey: parsed.apiKey,
    apiSecretPem: parsed.apiSecretEncrypted,
    vaultAccountId: parsed.vaultAccountId,
    assetId: parsed.assetId,
    apiBaseUrl: parsed.apiBaseUrl,
    defaultWalletId: record.defaultWalletId ?? parsed.defaultWalletId,
  };
}

function mapTransactionStatus(tx: FireblocksTransaction): SignatureStatus {
  if (tx.status === "COMPLETED") {
    const signatures = extractSignatures(tx.signedMessages);
    if (signatures.length === 0) {
      return { status: "failed", error: "Fireblocks completed without signatures" };
    }
    return { status: "completed", signatures };
  }

  if (REJECTED_STATUSES.has(tx.status)) {
    return { status: "rejected", reason: tx.subStatus ?? tx.status };
  }

  if (tx.status === "FAILED") {
    return { status: "failed", error: tx.subStatus ?? "Fireblocks request failed" };
  }

  if (PENDING_STATUSES.has(tx.status)) {
    return { status: "pending" };
  }

  return { status: "pending" };
}

function extractSignatures(
  signedMessages: FireblocksSignedMessage[] | undefined,
  fallbackPublicKey?: Address
) {
  if (!signedMessages || signedMessages.length === 0) {
    return [];
  }

  const results = [] as { publicKey: Address; signature: string }[];

  for (const message of signedMessages) {
    const signature = normalizeSignature(message.signature);
    const publicKeyValue = message.publicKey ?? fallbackPublicKey;
    if (!signature || !publicKeyValue) {
      continue;
    }

    results.push({
      publicKey: normalizePublicKey(publicKeyValue),
      signature,
    });
  }

  return results;
}
