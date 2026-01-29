/**
 * Kora JSON-RPC Client
 *
 * HTTP client for Kora fee payment API.
 * Implements JSON-RPC 2.0 protocol for gasless transaction sponsorship.
 */

import type {
  JsonRpcResponse,
  KoraAdapterConfig,
  KoraBlockhashResponse,
  KoraConfig,
  KoraEstimateFeeParams,
  KoraEstimateFeeResponse,
  KoraPayerSignerResponse,
  KoraPaymentInstructionParams,
  KoraPaymentInstructionResponse,
  KoraSignAndSendTransactionParams,
  KoraSignAndSendTransactionResponse,
  KoraSignTransactionParams,
  KoraSignTransactionResponse,
  KoraSupportedTokensResponse,
} from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Client Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class KoraClient {
  private rpcUrl: string;
  private apiKey?: string;
  private timeoutMs: number;
  private requestId = 0;

  constructor(config: KoraAdapterConfig) {
    this.rpcUrl = config.rpcUrl;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 30000;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Public API Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get current Kora server configuration
   */
  async getConfig(): Promise<KoraConfig> {
    return this.rpc<KoraConfig>("getConfig", {});
  }

  /**
   * Get the payer signer address (Kora's fee payer)
   */
  async getPayerSigner(): Promise<KoraPayerSignerResponse> {
    return this.rpc<KoraPayerSignerResponse>("getPayerSigner", {});
  }

  /**
   * Get list of supported tokens for fee payment
   */
  async getSupportedTokens(): Promise<KoraSupportedTokensResponse> {
    // biome-ignore lint/nursery/noSecrets: RPC method name, not a secret
    return this.rpc<KoraSupportedTokensResponse>("getSupportedTokens", {});
  }

  /**
   * Get latest blockhash from Kora's connected RPC
   */
  async getBlockhash(): Promise<KoraBlockhashResponse> {
    return this.rpc<KoraBlockhashResponse>("getBlockhash", {});
  }

  /**
   * Estimate transaction fee
   */
  async estimateTransactionFee(params: KoraEstimateFeeParams): Promise<KoraEstimateFeeResponse> {
    // biome-ignore lint/nursery/noSecrets: RPC method name, not a secret
    return this.rpc<KoraEstimateFeeResponse>("estimateTransactionFee", params);
  }

  /**
   * Get a payment instruction to include in the transaction
   * (for paying fees in SPL tokens)
   */
  async getPaymentInstruction(
    params: KoraPaymentInstructionParams
  ): Promise<KoraPaymentInstructionResponse> {
    // biome-ignore lint/nursery/noSecrets: RPC method name, not a secret
    return this.rpc<KoraPaymentInstructionResponse>("getPaymentInstruction", params);
  }

  /**
   * Sign a transaction with Kora's fee payer key (without sending)
   */
  async signTransaction(params: KoraSignTransactionParams): Promise<KoraSignTransactionResponse> {
    return this.rpc<KoraSignTransactionResponse>("signTransaction", params);
  }

  /**
   * Sign a transaction with Kora's fee payer and send to Solana
   */
  async signAndSendTransaction(
    params: KoraSignAndSendTransactionParams
  ): Promise<KoraSignAndSendTransactionResponse> {
    // biome-ignore lint/nursery/noSecrets: RPC method name, not a secret
    return this.rpc<KoraSignAndSendTransactionResponse>("signAndSendTransaction", params);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Make a JSON-RPC 2.0 request
   */
  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const id = ++this.requestId;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey && { "X-API-Key": this.apiKey }),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new KoraClientError(
          `Kora HTTP error ${response.status}: ${errorText}`,
          "NETWORK_ERROR",
          response.status
        );
      }

      const json = (await response.json()) as JsonRpcResponse<T>;

      if ("error" in json) {
        throw new KoraClientError(
          json.error.message,
          mapErrorCode(json.error.code),
          json.error.code,
          json.error.data
        );
      }

      return json.result;
    } catch (error) {
      if (error instanceof KoraClientError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new KoraClientError(`Kora request timed out after ${this.timeoutMs}ms`, "TIMEOUT");
      }

      throw new KoraClientError(
        error instanceof Error ? error.message : "Unknown error",
        "NETWORK_ERROR"
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Error Handling
// ═══════════════════════════════════════════════════════════════════════════

export type KoraErrorCode =
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "INVALID_REQUEST"
  | "VALIDATION_FAILED"
  | "RATE_LIMITED"
  | "INSUFFICIENT_BALANCE"
  | "TRANSACTION_FAILED"
  | "INTERNAL_ERROR";

export class KoraClientError extends Error {
  constructor(
    message: string,
    public readonly code: KoraErrorCode,
    public readonly rpcCode?: number,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = "KoraClientError";
  }
}

function mapErrorCode(rpcCode: number): KoraErrorCode {
  switch (rpcCode) {
    case -32600:
    case -32602:
      return "INVALID_REQUEST";
    case -32000:
      return "VALIDATION_FAILED";
    case -32001:
      return "RATE_LIMITED";
    case -32002:
      return "INSUFFICIENT_BALANCE";
    case -32003:
      return "TRANSACTION_FAILED";
    default:
      return "INTERNAL_ERROR";
  }
}
