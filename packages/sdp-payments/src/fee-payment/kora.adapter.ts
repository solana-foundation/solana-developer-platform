/**
 * Kora Fee Payment Adapter
 *
 * Implements FeePaymentPort for gasless transactions using Kora.
 * The platform sponsors all transaction fees via Kora's fee payer.
 */

import {
  type Address,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type Signature,
} from "@solana/kit";
import { KoraClient, type KoraClientOptions } from "@solana/kora";
import type { FeePaymentPort } from "./port";
import { FeePaymentError } from "./port";

type SignRequest = { transaction: string; user_id: string };

interface KoraClientTransport {
  getPayerSigner(): Promise<{
    signer_address?: string;
    payment_address?: string;
    payerSigner?: string;
  }>;
  signTransaction(request: SignRequest): Promise<{ signed_transaction: string }>;
  signAndSendTransaction(
    request: SignRequest
  ): Promise<{ signature?: string; signed_transaction: string }>;
  estimateTransactionFee(request: {
    transaction: string;
    fee_token: string;
  }): Promise<{ fee_in_lamports: number | string }>;
  getSupportedTokens(): Promise<{ tokens: string[] }>;
}

export type KoraAdapterConfig = KoraClientOptions & {
  /**
   * Optional request timeout in milliseconds.
   * Note: The Kora SDK does not currently support timeouts directly.
   */
  timeoutMs?: number;

  /**
   * Per-user id forwarded to Kora as `user_id`.
   * Callers should provide an owned, server-derived scope. Missing values use
   * one shared fail-closed quota bucket instead of bypassing usage tracking.
   */
  userId?: string;

  /**
   * Cloud Run audience used to fetch a service identity token from the metadata
   * server. Optional so public Kora deployments retain their current behavior.
   */
  identityTokenAudience?: string;

  /** Injectable service-identity token provider. */
  identityTokenProvider?: () => Promise<string>;

  /** Injectable client. */
  client?: KoraClientTransport;
};

// ═══════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class KoraAdapter implements FeePaymentPort {
  readonly providerId = "kora";

  private client: KoraClientTransport;
  private readonly userId: string;
  private cachedFeePayer: Address | null = null;
  private cachedFeeToken: string | null = null;

  constructor(config: KoraAdapterConfig) {
    const { rpcUrl, apiKey, getRecaptchaToken, hmacSecret, userId } = config;
    const identityTokenAudience = config.identityTokenAudience?.trim();
    if (config.identityTokenProvider && !identityTokenAudience) {
      throw new Error("identityTokenAudience is required with an identityTokenProvider");
    }
    if (identityTokenAudience) {
      assertCloudRunIdentityDestination(rpcUrl, identityTokenAudience);
    }
    const identityTokenProvider =
      config.identityTokenProvider ??
      (identityTokenAudience
        ? createCloudRunIdentityTokenProvider(identityTokenAudience)
        : undefined);
    this.client =
      config.client ??
      (identityTokenProvider
        ? new AuthorizedKoraClient({
            rpcUrl,
            apiKey,
            getRecaptchaToken,
            hmacSecret,
            identityTokenProvider,
          })
        : new KoraClient({ rpcUrl, apiKey, getRecaptchaToken, hmacSecret }));
    this.userId = userId?.trim() || "sdp:unscoped";
  }

  /**
   * Get the platform's fee payer address (Kora's signer).
   * Cached after first call.
   */
  async getFeePayer(): Promise<Address> {
    if (this.cachedFeePayer) {
      return this.cachedFeePayer;
    }

    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.client.getPayerSigner();
        const feePayer =
          (response as { signer_address?: string }).signer_address ??
          (response as { payment_address?: string }).payment_address ??
          (response as { payerSigner?: string }).payerSigner;

        if (!feePayer) {
          throw new Error("Kora did not return a fee payer address");
        }

        this.cachedFeePayer = feePayer as Address;
        return this.cachedFeePayer;
      } catch (error) {
        if (attempt < maxRetries && isRetryableGetFeePayerError(error)) {
          await sleep((attempt + 1) * 300);
          continue;
        }

        throw this.wrapError(error, "Failed to get fee payer address");
      }
    }

    // Unreachable: loop always returns or throws.
    throw new FeePaymentError("Failed to get fee payer address", "NETWORK_ERROR");
  }

  /**
   * Sign a transaction with Kora's fee payer key without sending.
   * Returns the transaction bytes with the fee payer signature added.
   */
  async signAsFeePayer(transaction: Uint8Array): Promise<Uint8Array> {
    try {
      const base64Tx = encodeBase64(transaction);

      const { signed_transaction } = await this.client.signTransaction(
        this.buildSignRequest(base64Tx)
      );

      return decodeBase64(signed_transaction);
    } catch (error) {
      throw this.wrapError(error, "Failed to sign transaction as fee payer");
    }
  }

  /**
   * Sign a transaction with Kora's fee payer and submit to Solana.
   * This is the primary method for gasless transaction submission.
   */
  async signAndSend(transaction: Uint8Array): Promise<Signature> {
    const base64Tx = encodeBase64(transaction);

    // Retry on transient failures:
    //  - "Blockhash not found": Kora's RPC may lag behind on blockhash propagation.
    //  - 502/503/Bad Gateway: The underlying RPC (e.g. Helius devnet) can return transient
    //    HTTP gateway errors that resolve on the next attempt.
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const { signature: submittedSignature, signed_transaction } =
          await this.client.signAndSendTransaction(this.buildSignRequest(base64Tx));

        if (submittedSignature) {
          return submittedSignature as Signature;
        }

        // Decode the signed transaction using @solana/kit's decoder
        const signedTxBytes = decodeBase64(signed_transaction);
        const decodedTx = getTransactionDecoder().decode(signedTxBytes);

        // Extract the signature (first signer's signature = transaction ID)
        const signature = getSignatureFromTransaction(decodedTx);

        return signature;
      } catch (error) {
        if (attempt < maxRetries && isRetryableSignAndSendError(error)) {
          await sleep((attempt + 1) * 500);
          continue;
        }

        throw this.wrapError(error, "Failed to sign and send transaction");
      }
    }

    // Unreachable: loop always returns or throws.
    throw new FeePaymentError("Failed to sign and send transaction", "NETWORK_ERROR");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Optional Extended Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Estimate the fee for a transaction (optional capability)
   */
  async estimateFee(transaction: Uint8Array): Promise<bigint> {
    try {
      const base64Tx = encodeBase64(transaction);
      const feeToken = await this.resolveFeeToken();

      const { fee_in_lamports } = await this.client.estimateTransactionFee({
        transaction: base64Tx,
        fee_token: feeToken,
      });

      return BigInt(fee_in_lamports);
    } catch (error) {
      throw this.wrapError(error, "Failed to estimate transaction fee");
    }
  }

  /**
   * Get supported fee payment tokens (optional capability)
   */
  async getSupportedTokens(): Promise<Address[]> {
    try {
      const { tokens } = await this.client.getSupportedTokens();
      return tokens.map((token) => token as Address);
    } catch (error) {
      throw this.wrapError(error, "Failed to get supported tokens");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /** Always attach a quota identity to signing requests. */
  private buildSignRequest(transaction: string): { transaction: string; user_id: string } {
    return { transaction, user_id: this.userId };
  }

  private async resolveFeeToken(): Promise<string> {
    if (this.cachedFeeToken) {
      return this.cachedFeeToken;
    }

    const { tokens } = await this.client.getSupportedTokens();
    const feeToken = tokens?.[0];

    if (!feeToken) {
      throw new Error("Kora returned no supported fee tokens");
    }

    this.cachedFeeToken = feeToken;
    return feeToken;
  }

  private wrapError(error: unknown, message: string): FeePaymentError {
    const rpcCode = extractRpcErrorCode(error);
    if (rpcCode !== undefined) {
      return new FeePaymentError(
        `${message}: ${formatErrorMessage(error)}`,
        mapKoraErrorCode(rpcCode)
      );
    }

    return new FeePaymentError(
      `${message}: ${formatErrorMessage(error)}`,
      "NETWORK_ERROR",
      error instanceof Error ? error : undefined
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64(base64: string): Uint8Array {
  const normalized = base64.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(`${normalized}${padding}`);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function extractRpcErrorCode(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = /RPC Error (-?\d+):/.exec(error.message);
  if (!match) return undefined;
  return Number.parseInt(match[1], 10);
}

function isRetryableSignAndSendError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    // Kora's RPC may lag behind on blockhash propagation
    message.includes("blockhash not found") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    // Transient HTTP gateway errors from the underlying RPC (e.g. Helius devnet)
    message.includes("502") ||
    message.includes("503") ||
    message.includes("bad gateway") ||
    message.includes("service unavailable")
  );
}

function isRetryableGetFeePayerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("internal error") ||
    message.includes("reference =") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("timeout") ||
    message.includes("temporar")
  );
}

function mapKoraErrorCode(code: number): import("./port").FeePaymentErrorCode {
  switch (code) {
    case -32001:
      return "RATE_LIMITED";
    case -32002:
      return "INSUFFICIENT_BALANCE";
    case -32000:
    case -32600:
    case -32602:
      return "SIGNING_FAILED";
    case -32003:
      return "SUBMISSION_FAILED";
    default:
      return "NETWORK_ERROR";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class AuthorizedKoraClient implements KoraClientTransport {
  constructor(
    private readonly config: KoraClientOptions & {
      identityTokenProvider: () => Promise<string>;
    }
  ) {}

  getPayerSigner() {
    return this.rpcRequest<Awaited<ReturnType<KoraClientTransport["getPayerSigner"]>>>(
      "getPayerSigner"
    );
  }

  signTransaction(request: SignRequest) {
    return this.rpcRequest<Awaited<ReturnType<KoraClientTransport["signTransaction"]>>>(
      "signTransaction",
      request
    );
  }

  signAndSendTransaction(request: SignRequest) {
    return this.rpcRequest<Awaited<ReturnType<KoraClientTransport["signAndSendTransaction"]>>>(
      "signAndSendTransaction",
      request
    );
  }

  estimateTransactionFee(request: { transaction: string; fee_token: string }) {
    return this.rpcRequest<Awaited<ReturnType<KoraClientTransport["estimateTransactionFee"]>>>(
      "estimateTransactionFee",
      request
    );
  }

  getSupportedTokens() {
    return this.rpcRequest<Awaited<ReturnType<KoraClientTransport["getSupportedTokens"]>>>(
      "getSupportedTokens"
    );
  }

  private async rpcRequest<T>(method: string, params?: unknown): Promise<T> {
    const body = JSON.stringify({ id: 1, jsonrpc: "2.0", method, params });
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.config.identityTokenProvider()}`,
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["x-api-key"] = this.config.apiKey;
    }
    if (this.config.hmacSecret) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      headers["x-timestamp"] = timestamp;
      headers["x-hmac-signature"] = await createHmacSignature(
        this.config.hmacSecret,
        timestamp + body
      );
    }
    if (this.config.getRecaptchaToken) {
      headers["x-recaptcha-token"] = await this.config.getRecaptchaToken();
    }

    const response = await fetch(this.config.rpcUrl, { method: "POST", headers, body });
    if (!response.ok) {
      throw new Error(`Kora HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      result?: T;
      error?: { code: number; message: string };
    };
    if (payload.error) {
      throw new Error(`RPC Error ${payload.error.code}: ${payload.error.message}`);
    }
    if (payload.result === undefined) {
      throw new Error("Kora RPC response did not include a result");
    }
    return payload.result;
  }
}

function createCloudRunIdentityTokenProvider(audience: string): () => Promise<string> {
  const normalizedAudience = audience.trim();
  if (!normalizedAudience) {
    throw new Error("KORA_CLOUD_RUN_AUDIENCE cannot be empty");
  }

  let cachedToken: string | undefined;
  let refreshAt = 0;
  return async () => {
    if (cachedToken && Date.now() < refreshAt) {
      return cachedToken;
    }

    const endpoint = new URL(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"
    );
    endpoint.searchParams.set("audience", normalizedAudience);
    endpoint.searchParams.set("format", "full");
    const response = await fetch(endpoint, {
      headers: { "Metadata-Flavor": "Google" },
    });
    if (!response.ok) {
      throw new Error(`Cloud Run identity token request failed with HTTP ${response.status}`);
    }

    const token = (await response.text()).trim();
    if (!token) {
      throw new Error("Cloud Run identity token response was empty");
    }
    cachedToken = token;
    refreshAt = resolveTokenRefreshAt(token);
    return token;
  };
}

function assertCloudRunIdentityDestination(rpcUrl: string, audience: string): void {
  let destination: URL;
  let trustedAudience: URL;
  try {
    destination = new URL(rpcUrl);
    trustedAudience = new URL(audience);
  } catch {
    throw new Error("KORA_RPC_URL and KORA_CLOUD_RUN_AUDIENCE must be valid URLs");
  }

  const hasCredentials =
    destination.username ||
    destination.password ||
    trustedAudience.username ||
    trustedAudience.password;
  if (
    destination.protocol !== "https:" ||
    trustedAudience.protocol !== "https:" ||
    destination.origin !== trustedAudience.origin ||
    hasCredentials
  ) {
    throw new Error("KORA_RPC_URL must use HTTPS and match the KORA_CLOUD_RUN_AUDIENCE origin");
  }
}

function resolveTokenRefreshAt(token: string): number {
  try {
    const payloadSegment = token.split(".")[1];
    if (!payloadSegment) {
      throw new Error("missing payload");
    }
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64(payloadSegment))) as {
      exp?: number;
    };
    if (!payload.exp) {
      throw new Error("missing exp");
    }
    return Math.max(Date.now(), payload.exp * 1000 - 60_000);
  } catch {
    // Metadata identity tokens currently live for an hour. A short fallback
    // cache avoids per-RPC metadata calls without assuming that full lifetime.
    return Date.now() + 5 * 60_000;
  }
}

async function createHmacSignature(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}
