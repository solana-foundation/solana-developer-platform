import { type Address, assertIsAddress } from "@solana/addresses";
import { getBase58Codec } from "@solana/codecs";
import { getBase64Decoder } from "@solana/codecs-strings";
import {
  SignerErrorCode,
  type SolanaSigner,
  createSignatureDictionary,
  extractSignatureFromWireTransaction,
  throwSignerError,
} from "@solana/keychain-core";
import type { SignatureBytes } from "@solana/keys";
import type { SignableMessage, SignatureDictionary } from "@solana/signers";
import {
  type Base64EncodedWireTransaction,
  type Transaction,
  type TransactionMessageBytesBase64,
  type TransactionWithLifetime,
  type TransactionWithinSizeLimit,
  getBase64EncodedWireTransaction,
} from "@solana/transactions";
import { createCoinbaseCdpBearerJwt, createCoinbaseCdpWalletJwt } from "./jwt.js";
import type {
  SignMessageRequest,
  SignMessageResponse,
  SignTransactionRequest,
  SignTransactionResponse,
  WalletResponse,
} from "./types.js";
import { getNestedProp, requiresWalletAuth, resolveRequestUrl, sortJsonKeys } from "./utils.js";

const DEFAULT_API_BASE_URL = "https://api.cdp.coinbase.com/platform";
const base58 = getBase58Codec();

export interface CoinbaseCdpSignerConfig {
  apiBaseUrl?: string;
  apiKeyId: string;
  apiKeySecret: string;
  requestDelayMs?: number;
  walletId: string;
  walletSecret: string;
}

export class CoinbaseCdpSigner<TAddress extends string = string> implements SolanaSigner<TAddress> {
  readonly address!: Address<TAddress>;

  private readonly apiKeyId: string;
  private readonly apiKeySecret: string;
  private readonly walletSecret: string;
  private readonly walletId: string;
  private readonly apiBaseUrl: string;
  private readonly requestDelayMs: number;
  private initialized = false;

  private constructor(config: CoinbaseCdpSignerConfig) {
    if (!config.apiKeyId || !config.apiKeySecret || !config.walletSecret || !config.walletId) {
      throwSignerError(SignerErrorCode.CONFIG_ERROR, {
        message:
          "Missing required configuration fields (apiKeyId, apiKeySecret, walletSecret, or walletId)",
      });
    }

    this.apiKeyId = config.apiKeyId;
    this.apiKeySecret = config.apiKeySecret;
    this.walletSecret = config.walletSecret;
    this.walletId = config.walletId;
    this.apiBaseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.requestDelayMs = config.requestDelayMs ?? 0;
    this.validateRequestDelayMs(this.requestDelayMs);
  }

  static async create<TAddress extends string = string>(
    config: CoinbaseCdpSignerConfig
  ): Promise<CoinbaseCdpSigner<TAddress>> {
    const signer = new CoinbaseCdpSigner<TAddress>(config);
    const address = await signer.fetchPublicKey();

    Object.defineProperty(signer, "address", {
      configurable: false,
      enumerable: true,
      value: address,
      writable: false,
    });

    signer.initialized = true;
    return signer;
  }

  async signMessages(
    messages: readonly SignableMessage[]
  ): Promise<readonly SignatureDictionary[]> {
    this.assertInitialized();

    return Promise.all(
      messages.map(async (message, index) => {
        await this.delay(index);
        const base64EncodedMessage = getBase64Decoder().decode(
          message.content
        ) as TransactionMessageBytesBase64;
        const signature = await this.signMessage(base64EncodedMessage);
        return createSignatureDictionary({
          signature,
          signerAddress: this.address,
        });
      })
    );
  }

  async signTransactions(
    transactions: readonly (Transaction & TransactionWithinSizeLimit & TransactionWithLifetime)[]
  ): Promise<readonly SignatureDictionary[]> {
    this.assertInitialized();

    return Promise.all(
      transactions.map(async (transaction, index) => {
        await this.delay(index);
        const wireTransaction = getBase64EncodedWireTransaction(transaction);
        const signedTransaction = await this.signTransaction(wireTransaction);

        return extractSignatureFromWireTransaction({
          base64WireTransaction: signedTransaction,
          signerAddress: this.address,
        });
      })
    );
  }

  async isAvailable(): Promise<boolean> {
    if (!this.initialized) {
      return false;
    }

    try {
      await this.fetchPublicKey();
      return true;
    } catch {
      return false;
    }
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throwSignerError(SignerErrorCode.SIGNER_NOT_INITIALIZED, {
        message: "Signer must be initialized via create()",
      });
    }
  }

  private validateRequestDelayMs(requestDelayMs: number): void {
    if (!Number.isFinite(requestDelayMs) || requestDelayMs < 0) {
      throwSignerError(SignerErrorCode.CONFIG_ERROR, {
        message: "requestDelayMs must be a non-negative number",
      });
    }
    if (requestDelayMs > 3000) {
      console.warn(
        "requestDelayMs is greater than 3000ms, this may increase signing latency substantially"
      );
    }
  }

  private async delay(index: number): Promise<void> {
    if (this.requestDelayMs > 0 && index > 0) {
      await new Promise((resolve) => setTimeout(resolve, index * this.requestDelayMs));
    }
  }

  private async fetchPublicKey(): Promise<Address<TAddress>> {
    const response = await this.request<WalletResponse<TAddress>>({
      method: "GET",
      path: `/v2/solana/accounts/${this.walletId}`,
    });

    if (!response?.address) {
      throwSignerError(SignerErrorCode.REMOTE_API_ERROR, {
        message: "Missing address in Coinbase CDP account response",
      });
    }

    assertIsAddress(response.address);
    return response.address;
  }

  private async signMessage(
    base64EncodedMessage: TransactionMessageBytesBase64
  ): Promise<SignatureBytes> {
    const response = await this.request<SignMessageResponse | { data?: SignMessageResponse }>({
      method: "POST",
      path: `/v2/solana/accounts/${this.walletId}/sign/message`,
      body: {
        message: base64EncodedMessage,
      } as SignMessageRequest,
    });

    const signatureBase58 = getNestedProp<string>(response, "signature", "data.signature");
    if (!signatureBase58) {
      throwSignerError(SignerErrorCode.REMOTE_API_ERROR, {
        message: "Missing signature in Coinbase CDP sign message response",
      });
    }

    try {
      return base58.encode(signatureBase58) as SignatureBytes;
    } catch (error) {
      throwSignerError(SignerErrorCode.PARSING_ERROR, {
        cause: error,
        message: "Failed to parse base58 signature from Coinbase CDP",
      });
    }
  }

  private async signTransaction(
    transaction: Base64EncodedWireTransaction
  ): Promise<Base64EncodedWireTransaction> {
    const response = await this.request<
      SignTransactionResponse | { data?: SignTransactionResponse } | { signed_transaction?: string }
    >({
      method: "POST",
      path: `/v2/solana/accounts/${this.walletId}/sign/transaction`,
      body: {
        transaction,
      } as SignTransactionRequest,
    });

    const parsed = response as {
      data?: { signed_transaction?: string; signedTransaction?: string };
      signed_transaction?: string;
      signedTransaction?: string;
    };

    const signedTransaction = (parsed.signedTransaction ??
      parsed.data?.signedTransaction ??
      parsed.signed_transaction ??
      parsed.data?.signed_transaction) as Base64EncodedWireTransaction | undefined;

    if (!signedTransaction) {
      throwSignerError(SignerErrorCode.REMOTE_API_ERROR, {
        message: "Missing signed transaction in Coinbase CDP sign transaction response",
      });
    }

    return signedTransaction;
  }

  private async request<T>(params: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    body?: unknown;
  }): Promise<T> {
    const { requestPath, url } = resolveRequestUrl(this.apiBaseUrl, params.path);
    const normalizedBody =
      params.body && typeof params.body === "object"
        ? sortJsonKeys(params.body as Record<string, unknown>)
        : undefined;
    const bodyJson = normalizedBody ? JSON.stringify(normalizedBody) : undefined;

    const bearerToken = await createCoinbaseCdpBearerJwt({
      apiKeyId: this.apiKeyId,
      apiKeySecret: this.apiKeySecret,
      requestHost: url.host,
      requestMethod: params.method,
      requestPath,
    });

    const headers: Record<string, string> = {
      Authorization: `Bearer ${bearerToken}`,
      ...(bodyJson ? { "Content-Type": "application/json" } : {}),
    };

    if (requiresWalletAuth(params.method, requestPath)) {
      const walletAuthToken = await createCoinbaseCdpWalletJwt({
        requestData: normalizedBody ?? {},
        requestHost: url.host,
        requestMethod: params.method,
        requestPath,
        walletSecret: this.walletSecret,
      });
      headers["X-Wallet-Auth"] = walletAuthToken;
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        body: bodyJson,
        headers,
        method: params.method,
      });
    } catch (error) {
      throwSignerError(SignerErrorCode.HTTP_ERROR, {
        cause: error,
        message: "Coinbase CDP network request failed",
        url: url.toString(),
      });
    }

    if (!response.ok) {
      const responseText = await response.text().catch(() => "Failed to read error response");
      throwSignerError(SignerErrorCode.REMOTE_API_ERROR, {
        message: `Coinbase CDP API error: ${response.status}`,
        response: responseText,
        status: response.status,
      });
    }

    if (response.status === 204 || response.headers.get("content-length") === "0") {
      return undefined as T;
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      throwSignerError(SignerErrorCode.PARSING_ERROR, {
        cause: error,
        message: "Failed to parse Coinbase CDP JSON response",
      });
    }
  }
}
