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
import {
  type Config,
  type FeePayerPolicy,
  KoraClient,
  type KoraClientOptions,
  type SignAndSendTransactionRequest,
  type SignTransactionRequest,
} from "@solana/kora";
import type { FeePaymentPort, SponsorshipProviderConfiguration } from "./port";
import { FeePaymentError } from "./port";

interface KoraClientTransport {
  getPayerSigner(): Promise<{
    signer_address?: string;
    payment_address?: string;
    payerSigner?: string;
  }>;
  signTransaction(request: SignTransactionRequest): Promise<{ signed_transaction: string }>;
  signAndSendTransaction(
    request: SignAndSendTransactionRequest
  ): Promise<{ signature?: string; signed_transaction: string }>;
  estimateTransactionFee(request: {
    transaction: string;
    fee_token: string;
  }): Promise<{ fee_in_lamports: number | string }>;
  getSupportedTokens(): Promise<{ tokens: string[] }>;
  getConfig(): Promise<Config>;
}

export type KoraAdapterConfig = KoraClientOptions & {
  /**
   * Per-call timeout in milliseconds. The Kora SDK offers no abort hook, so
   * the adapter races each call against this deadline; the underlying fetch
   * is abandoned rather than aborted.
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
    this.client = withCallTimeouts(this.client, config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
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
        await this.buildSignRequest(base64Tx)
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
          await this.client.signAndSendTransaction(await this.buildSendRequest(base64Tx));

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

  async getSponsorshipConfiguration(): Promise<SponsorshipProviderConfiguration> {
    try {
      const [signerAddress, config] = await Promise.all([
        this.getFeePayer(),
        this.client.getConfig(),
      ]);
      const validationConfig = config?.validation_config;
      if (!validationConfig) {
        throw new Error("Kora getConfig omitted validation_config");
      }
      const { max_allowed_lamports, fee_payer_policy } = validationConfig;
      if (max_allowed_lamports === undefined || max_allowed_lamports === null) {
        throw new Error("Kora getConfig omitted validation_config.max_allowed_lamports");
      }
      const maxAllowedLamports = BigInt(max_allowed_lamports);
      if (maxAllowedLamports < 0n) {
        throw new Error("Kora returned a negative max_allowed_lamports");
      }
      return {
        signerAddress,
        maxAllowedLamports,
        feePayerMayTransferLamports: policyMaySpendLamports(fee_payer_policy),
        feePayerPolicy: fee_payer_policy,
      };
    } catch (error) {
      if (error instanceof FeePaymentError) throw error;
      throw this.wrapError(error, "Failed to read Kora sponsorship configuration");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /** Always attach a quota identity to signing requests. */
  private async buildSignRequest(transaction: string): Promise<SignTransactionRequest> {
    return { transaction, user_id: this.userId, signer_key: await this.getFeePayer() };
  }

  /** Send requests additionally pin the earliest durable response milestone. */
  private async buildSendRequest(transaction: string): Promise<SignAndSendTransactionRequest> {
    return { ...(await this.buildSignRequest(transaction)), respond_after: "sent" };
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

// Managed sponsorship assumes zero additional lamport outflow only when every
// authority Kora reports is explicitly disabled. Checking the values rather than
// pinning the schema keeps a newly added authority meaningful: one that arrives
// disabled is still proof of zero outflow, while one that arrives enabled fails
// closed even though this code has never heard of it.
function policyMaySpendLamports(policy: FeePayerPolicy): boolean {
  return !(reportsRequiredAuthorities(policy) && everyAuthorityDisabled(policy));
}

// Kora reports its policy as JSON, so anything that is not a plain object with
// its authorities as own properties is not a policy this code can vouch for.
// Reading inherited or hidden members would let an empty-looking payload pass
// as proof of zero outflow while carrying an enabled authority out of sight.
function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const REQUIRED_DISABLED_AUTHORITIES = [
  ["system", "allow_transfer"],
  ["system", "allow_assign"],
  ["system", "allow_create_account"],
  ["system", "allow_allocate"],
  ["system", "nonce", "allow_withdraw"],
  ["spl_token", "allow_transfer"],
  ["spl_token", "allow_close_account"],
  ["token_2022", "allow_transfer"],
  ["token_2022", "allow_close_account"],
] as const;

// A policy Kora truncated, or one this code failed to parse, must not read as
// proof of zero outflow: the authorities that move lamports have to be present
// and explicitly disabled before the rest of the report is worth checking.
function reportsRequiredAuthorities(policy: FeePayerPolicy): boolean {
  return REQUIRED_DISABLED_AUTHORITIES.every((path) => {
    let current: unknown = policy;
    for (const key of path) {
      if (!isPlainRecord(current) || !Object.hasOwn(current, key)) return false;
      current = current[key];
    }
    return current === false;
  });
}

function everyAuthorityDisabled(value: unknown): boolean {
  if (typeof value === "boolean") return value === false;
  if (!isPlainRecord(value)) return false;
  const keys: PropertyKey[] = [
    ...Object.getOwnPropertyNames(value),
    ...Object.getOwnPropertySymbols(value),
  ];
  return keys.every((key) => everyAuthorityDisabled(value[key]));
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
    message.includes("service unavailable") ||
    // Connection-level failures while a Kora instance is being replaced.
    // Retrying is idempotent even when the first attempt may have reached
    // Kora: the transaction bytes are fixed, ed25519 signing is
    // deterministic, so a duplicate submit carries the same signature and
    // the cluster deduplicates it.
    message.includes("fetch failed") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("socket hang up")
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
    case -32600:
    case -32602:
      return "SIGNING_FAILED";
    case -32003:
      return "SUBMISSION_FAILED";
    default:
      return "NETWORK_ERROR";
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

// The Kora SDK performs a bare fetch with no abort hook, so a hung connection
// would otherwise hold the caller until the platform request timeout. Race
// every call against a deadline; the timeout message is classified as
// retryable by the transient-error checks above.
function withCallTimeouts(client: KoraClientTransport, timeoutMs: number): KoraClientTransport {
  return {
    getPayerSigner: () => withTimeout(client.getPayerSigner(), timeoutMs, "getPayerSigner"),
    signTransaction: (request) =>
      withTimeout(client.signTransaction(request), timeoutMs, "signTransaction"),
    signAndSendTransaction: (request) =>
      withTimeout(client.signAndSendTransaction(request), timeoutMs, "signAndSendTransaction"),
    estimateTransactionFee: (request) =>
      withTimeout(client.estimateTransactionFee(request), timeoutMs, "estimateTransactionFee"),
    getSupportedTokens: () =>
      withTimeout(client.getSupportedTokens(), timeoutMs, "getSupportedTokens"),
    getConfig: () => withTimeout(client.getConfig(), timeoutMs, "getConfig"),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Kora ${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
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

  signTransaction(request: SignTransactionRequest) {
    return this.rpcRequest<Awaited<ReturnType<KoraClientTransport["signTransaction"]>>>(
      "signTransaction",
      request
    );
  }

  signAndSendTransaction(request: SignAndSendTransactionRequest) {
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

  getConfig() {
    return this.rpcRequest<Config>("getConfig");
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
