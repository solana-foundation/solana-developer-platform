import { type Address, assertIsAddress } from "@solana/addresses";
import {
  SignerError,
  SignerErrorCode,
  type SolanaSigner,
  createSignatureDictionary,
  extractSignatureFromWireTransaction,
  throwSignerError,
} from "@solana/keychain-core";
import type { SignableMessage, SignatureDictionary } from "@solana/signers";
import {
  type Base64EncodedWireTransaction,
  type Transaction,
  type TransactionWithLifetime,
  type TransactionWithinSizeLimit,
  getBase64EncodedWireTransaction,
} from "@solana/transactions";
import type {
  ParaSignRawRequest,
  ParaSignRawResponse,
  ParaSignTransactionRequest,
  ParaSignTransactionResponse,
  ParaWalletResponse,
} from "./types.js";
import { bytesToHex, getNestedProp, hexToBytes, resolveRequestUrl } from "./utils.js";

const DEFAULT_API_BASE_URL = "https://api.getpara.com";
type SignatureBytes = Parameters<typeof createSignatureDictionary>[0]["signature"];
const SIGNED_TRANSACTION_FIELD = ["signed", "Transaction"].join("");
const SIGNED_TRANSACTION_SNAKE_FIELD = ["signed", "transaction"].join("_");
const DATA_SIGNED_TRANSACTION_FIELD = `data.${SIGNED_TRANSACTION_FIELD}`;
const DATA_SIGNED_TRANSACTION_SNAKE_FIELD = `data.${SIGNED_TRANSACTION_SNAKE_FIELD}`;

export interface ParaSignerConfig {
  apiBaseUrl?: string;
  apiKey: string;
  requestDelayMs?: number;
  walletId: string;
}

export class ParaSigner<TAddress extends string = string> implements SolanaSigner<TAddress> {
  readonly address!: Address<TAddress>;

  private readonly apiBaseUrl: string;
  private readonly apiKey: string;
  private readonly requestDelayMs: number;
  private readonly walletId: string;
  private initialized = false;

  private constructor(config: ParaSignerConfig) {
    if (!config.apiKey || !config.walletId) {
      throwSignerError(SignerErrorCode.CONFIG_ERROR, {
        message: "Missing required configuration fields (apiKey or walletId)",
      });
    }

    this.apiBaseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.apiKey = config.apiKey;
    this.requestDelayMs = config.requestDelayMs ?? 0;
    this.walletId = config.walletId;

    this.validateRequestDelayMs(this.requestDelayMs);
  }

  static async create<TAddress extends string = string>(
    config: ParaSignerConfig
  ): Promise<ParaSigner<TAddress>> {
    const signer = new ParaSigner<TAddress>(config);
    const wallet = await signer.fetchWallet();

    const address = signer.validateWallet(wallet);
    assertIsAddress(address);

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

        const signature = await this.signRaw(bytesToHex(message.content));
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

        try {
          const wireTransaction = getBase64EncodedWireTransaction(transaction);
          const signedTransaction = await this.signTransaction(wireTransaction);

          return extractSignatureFromWireTransaction({
            base64WireTransaction: signedTransaction,
            signerAddress: this.address,
          });
        } catch (error) {
          if (!this.shouldFallbackToRawTransactionSigning(error)) {
            throw error;
          }

          // Para may reject versioned wire transactions in sign-transaction.
          // Fallback to signing transaction message bytes directly for compatibility.
          const signature = await this.signRaw(
            bytesToHex(new Uint8Array(transaction.messageBytes))
          );
          return createSignatureDictionary({
            signature,
            signerAddress: this.address,
          });
        }
      })
    );
  }

  async isAvailable(): Promise<boolean> {
    if (!this.initialized) {
      return false;
    }

    try {
      await this.fetchWallet();
      return true;
    } catch {
      return false;
    }
  }

  private validateWallet(wallet: ParaWalletResponse<TAddress>): Address<TAddress> {
    if (wallet.type && wallet.type !== "SOLANA") {
      throwSignerError(SignerErrorCode.CONFIG_ERROR, {
        message: `Wallet '${this.walletId}' is not a Solana wallet`,
      });
    }

    if (wallet.scheme && wallet.scheme !== "ED25519") {
      throwSignerError(SignerErrorCode.CONFIG_ERROR, {
        message: `Wallet '${this.walletId}' is not ED25519`,
      });
    }

    if (wallet.status && wallet.status !== "ready") {
      throwSignerError(SignerErrorCode.REMOTE_API_ERROR, {
        message: `Wallet '${this.walletId}' is not ready yet (status: ${wallet.status})`,
      });
    }

    if (!wallet.address) {
      throwSignerError(SignerErrorCode.REMOTE_API_ERROR, {
        message: `Wallet '${this.walletId}' response is missing address`,
      });
    }

    return wallet.address as Address<TAddress>;
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

  private async fetchWallet(): Promise<ParaWalletResponse<TAddress>> {
    const response = await this.request<
      ParaWalletResponse<TAddress> | { data?: ParaWalletResponse<TAddress> }
    >({
      method: "GET",
      path: `/v1/wallets/${encodeURIComponent(this.walletId)}`,
    });

    const wallet = (getNestedProp<ParaWalletResponse<TAddress>>(response, "data") ??
      response) as ParaWalletResponse<TAddress>;

    if (!wallet || typeof wallet !== "object") {
      throwSignerError(SignerErrorCode.REMOTE_API_ERROR, {
        message: "Invalid Para wallet response",
      });
    }

    return wallet;
  }

  private async signRaw(payloadHex: string): Promise<SignatureBytes> {
    const response = await this.request<ParaSignRawResponse | { data?: ParaSignRawResponse }>({
      method: "POST",
      path: `/v1/wallets/${encodeURIComponent(this.walletId)}/sign-raw`,
      body: {
        data: payloadHex,
        walletType: "SOLANA",
      } as ParaSignRawRequest,
    });

    const signatureHex = getNestedProp<string>(response, "signature", "data.signature");
    if (!signatureHex) {
      throwSignerError(SignerErrorCode.REMOTE_API_ERROR, {
        message: "Missing signature in Para sign-raw response",
      });
    }

    try {
      return hexToBytes(signatureHex) as SignatureBytes;
    } catch (error) {
      throwSignerError(SignerErrorCode.PARSING_ERROR, {
        cause: error,
        message: "Failed to parse hex signature from Para",
      });
    }
  }

  private async signTransaction(
    transaction: Base64EncodedWireTransaction
  ): Promise<Base64EncodedWireTransaction> {
    const response = await this.request<
      | ParaSignTransactionResponse
      | { data?: ParaSignTransactionResponse }
      | { signed_transaction?: string }
    >({
      method: "POST",
      path: `/v1/wallets/${encodeURIComponent(this.walletId)}/sign-transaction`,
      body: {
        transaction,
      } as ParaSignTransactionRequest,
    });

    const signedTransaction = getNestedProp<Base64EncodedWireTransaction>(
      response,
      SIGNED_TRANSACTION_FIELD,
      SIGNED_TRANSACTION_SNAKE_FIELD,
      DATA_SIGNED_TRANSACTION_FIELD,
      DATA_SIGNED_TRANSACTION_SNAKE_FIELD
    );

    if (!signedTransaction) {
      throwSignerError(SignerErrorCode.REMOTE_API_ERROR, {
        message: "Missing signed transaction in Para sign-transaction response",
      });
    }

    return signedTransaction;
  }

  private shouldFallbackToRawTransactionSigning(error: unknown): error is SignerError {
    if (!(error instanceof SignerError)) {
      return false;
    }

    if (error.code !== SignerErrorCode.REMOTE_API_ERROR) {
      return false;
    }

    const status = error.context?.status;
    return typeof status === "number" && status === 400;
  }

  private async request<T>(params: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    body?: unknown;
  }): Promise<T> {
    const { url } = resolveRequestUrl(this.apiBaseUrl, params.path);
    const bodyJson = params.body ? JSON.stringify(params.body) : undefined;

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        body: bodyJson,
        headers: {
          "X-API-Key": this.apiKey,
          ...(bodyJson ? { "Content-Type": "application/json" } : {}),
        },
        method: params.method,
      });
    } catch (error) {
      throwSignerError(SignerErrorCode.HTTP_ERROR, {
        cause: error,
        message: "Para network request failed",
        url: url.toString(),
      });
    }

    if (!response.ok) {
      const responseText = await response.text().catch(() => "Failed to read error response");
      throwSignerError(SignerErrorCode.REMOTE_API_ERROR, {
        message: `Para API error: ${response.status}${responseText ? ` - ${responseText}` : ""}`,
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
        message: "Failed to parse Para JSON response",
      });
    }
  }
}
