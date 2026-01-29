/**
 * Fireblocks API Client
 *
 * HTTP client for Fireblocks API with JWT authentication.
 * Compatible with Cloudflare Workers (uses Web Crypto API).
 */

import { createJwt, importPrivateKey } from "./jwt";
import type { FireblocksAddress, FireblocksTransaction } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Client Configuration
// ═══════════════════════════════════════════════════════════════════════════

export interface FireblocksClientConfig {
  apiKey: string;
  apiSecretPem: string;
  baseUrl?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Client Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class FireblocksClient {
  private apiKey: string;
  private baseUrl: string;
  private privateKeyPromise: Promise<CryptoKey>;

  constructor(config: FireblocksClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.fireblocks.io";
    this.privateKeyPromise = importPrivateKey(normalizePem(config.apiSecretPem));
  }

  /**
   * Create a raw signing transaction (RAW operation)
   */
  async createRawTransaction(params: {
    vaultAccountId: string;
    assetId: string;
    messageHex: string;
    externalTxId: string;
    idempotencyKey: string;
  }): Promise<FireblocksTransaction> {
    const payload = {
      assetId: params.assetId,
      source: { type: "VAULT_ACCOUNT", id: params.vaultAccountId },
      destination: { type: "VAULT_ACCOUNT", id: params.vaultAccountId },
      amount: "0",
      operation: "RAW",
      externalTxId: params.externalTxId,
      extraParameters: {
        rawMessageData: {
          messages: [{ content: params.messageHex }],
        },
      },
    };

    return this.request<FireblocksTransaction>("POST", "/v1/transactions", {
      body: payload,
      idempotencyKey: params.idempotencyKey,
    });
  }

  /**
   * Get transaction by ID
   */
  async getTransaction(transactionId: string): Promise<FireblocksTransaction> {
    return this.request<FireblocksTransaction>("GET", `/v1/transactions/${transactionId}`);
  }

  /**
   * Get vault address for an asset
   */
  async getVaultAddress(params: {
    vaultAccountId: string;
    assetId: string;
    addressId: string;
  }): Promise<FireblocksAddress> {
    return this.request<FireblocksAddress>(
      "GET",
      `/v1/vault/accounts/${params.vaultAccountId}/${params.assetId}/addresses/${params.addressId}`
    );
  }

  /**
   * Make an authenticated request to Fireblocks API
   */
  private async request<T>(
    method: "GET" | "POST",
    pathWithQuery: string,
    options?: { body?: unknown; idempotencyKey?: string }
  ): Promise<T> {
    const body = options?.body ? JSON.stringify(options.body) : "";
    const privateKey = await this.privateKeyPromise;

    const jwt = await createJwt({
      apiKey: this.apiKey,
      pathWithQuery,
      body,
      privateKey,
    });

    const response = await fetch(`${this.baseUrl}${pathWithQuery}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.apiKey,
        Authorization: `Bearer ${jwt}`,
        ...(options?.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
      },
      body: method === "POST" ? body : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new FireblocksClientError(
        `Fireblocks ${response.status} ${response.statusText}: ${errorText}`,
        response.status
      );
    }

    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Errors
// ═══════════════════════════════════════════════════════════════════════════

export class FireblocksClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    // biome-ignore lint/nursery/noSecrets: Error class name, not a secret
    this.name = "FireblocksClientError";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Normalize PEM format (handle escaped newlines, missing headers)
 */
function normalizePem(value: string): string {
  const normalized = value.trim().replace(/\\n/g, "\n");
  if (normalized.includes("BEGIN")) {
    return normalized;
  }

  return `-----BEGIN PRIVATE KEY-----\n${normalized}\n-----END PRIVATE KEY-----`;
}
