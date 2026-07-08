import { Buffer } from "node:buffer";
import { type Address, assertIsAddress } from "@solana/addresses";
import {
  createSignatureDictionary,
  extractSignatureFromWireTransaction,
  SignerErrorCode,
  type SolanaSigner,
  throwSignerError,
} from "@solana/keychain-core";
import type {
  Base64EncodedWireTransaction,
  Transaction,
  TransactionWithinSizeLimit,
  TransactionWithLifetime,
} from "@solana/kit";
import { getBase64EncodedWireTransaction } from "@solana/kit";
import type { SignableMessage, SignatureDictionary } from "@solana/signers";
import type {
  DfnsApiClient,
  DfnsCreateSignatureBody,
  DfnsSignatureRequest,
  DfnsSignatureStatus,
  DfnsWallet,
} from "./client";
import { DFNS_PROVIDER_LABEL } from "./client";

const SIGNATURE_POLL_INTERVAL_MS = 600;
const SIGNATURE_MAX_POLL_ATTEMPTS = 50;
const SOLANA_BLOCKCHAIN_KIND = "Solana";
const TERMINAL_SUCCESS_STATUSES = new Set<DfnsSignatureStatus>(["Signed", "Confirmed"]);
const TERMINAL_FAILURE_STATUSES = new Set<DfnsSignatureStatus>(["Failed", "Rejected"]);
type SignatureBytes = Parameters<typeof createSignatureDictionary>[0]["signature"];

export interface DfnsSignerConfig {
  /** DFNS API client configured with org credentials */
  client: DfnsApiClient;
  /** Wallet identifier (`dfns_<walletId>` or raw DFNS wallet ID) */
  walletId: string;
  /** Reserved for future parity with other signers */
  requestDelayMs?: number;
  /** Provider display label for error messages; defaults to "DFNS" */
  providerLabel?: string;
}

export class DfnsSigner<TAddress extends string = string> implements SolanaSigner<TAddress> {
  readonly address!: Address<TAddress>;

  private readonly client: DfnsApiClient;
  private readonly walletId: string;
  private readonly requestDelayMs: number;
  private readonly providerLabel: string;
  private signingKeyId?: string;
  private walletNetwork?: string;
  private initialized = false;

  private constructor(config: DfnsSignerConfig) {
    if (!config.client || !config.walletId) {
      throwSignerError(SignerErrorCode.CONFIG_ERROR, {
        message: "Missing required configuration fields (client or walletId)",
      });
    }

    this.client = config.client;
    this.walletId = config.walletId;
    this.requestDelayMs = config.requestDelayMs ?? 0;
    this.providerLabel = config.providerLabel ?? DFNS_PROVIDER_LABEL;
    this.validateRequestDelayMs(this.requestDelayMs);
  }

  static async create<TAddress extends string = string>(
    config: DfnsSignerConfig
  ): Promise<DfnsSigner<TAddress>> {
    const signer = new DfnsSigner<TAddress>(config);
    const wallet = await signer.fetchWallet();
    const address = signer.getWalletAddress(wallet);

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
        const signature = await this.signMessage(message.content);
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
        const signedWireTransaction = await this.signTransaction(wireTransaction);

        return extractSignatureFromWireTransaction({
          base64WireTransaction: signedWireTransaction,
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
      await this.fetchWallet();
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
      await sleep(index * this.requestDelayMs);
    }
  }

  private async fetchWallet(): Promise<DfnsWallet> {
    let wallet: Awaited<ReturnType<DfnsApiClient["wallets"]["getWallet"]>>;
    try {
      wallet = await this.client.wallets.getWallet({
        walletId: denormalizeDfnsWalletId(this.walletId),
      });
    } catch (error) {
      throwSignerError(SignerErrorCode.HTTP_ERROR, {
        cause: error,
        message: `Failed to fetch ${this.providerLabel} wallet '${this.walletId}'`,
      });
    }

    this.cacheWalletMetadata(wallet);
    return wallet;
  }

  private cacheWalletMetadata(wallet: DfnsWallet): void {
    if (!this.walletNetwork && typeof wallet.network === "string" && wallet.network.length > 0) {
      this.walletNetwork = wallet.network;
    }

    const signingKeyId = wallet.signingKey?.id;
    if (!this.signingKeyId && typeof signingKeyId === "string" && signingKeyId.length > 0) {
      this.signingKeyId = signingKeyId;
    }
  }

  private getWalletAddress(wallet: DfnsWallet): Address<TAddress> {
    if (!wallet?.address) {
      throwSignerError(SignerErrorCode.REMOTE_API_ERROR, {
        message: `${this.providerLabel} wallet '${this.walletId}' response is missing address`,
      });
    }

    assertIsAddress(wallet.address);
    return wallet.address as Address<TAddress>;
  }

  private async signMessage(message: Uint8Array): Promise<SignatureBytes> {
    const { keyId, network } = await this.getSigningContext();
    const response = await this.createSignatureRequest(keyId, {
      kind: "Message",
      message: toHex(message),
      ...buildSignatureTarget(network),
    });
    const finalized = await this.waitForSignatureResult(keyId, response);
    return extractSignatureBytes(finalized, this.providerLabel);
  }

  private async signTransaction(
    transaction: Base64EncodedWireTransaction
  ): Promise<Base64EncodedWireTransaction> {
    const { keyId, network } = await this.getSigningContext();
    const response = await this.createSignatureRequest(keyId, {
      kind: "Transaction",
      transaction: toHex(base64ToBytes(transaction)),
      ...buildSignatureTarget(network),
    });
    const finalized = await this.waitForSignatureResult(keyId, response);
    const signedTxBytes = extractSignedTransactionBytes(finalized, this.providerLabel);
    return bytesToBase64(signedTxBytes) as Base64EncodedWireTransaction;
  }

  private async getSigningContext(): Promise<{ keyId: string; network?: string }> {
    if (!this.signingKeyId) {
      await this.fetchWallet();
    }

    if (!this.signingKeyId) {
      throwSignerError(SignerErrorCode.REMOTE_API_ERROR, {
        message: `${this.providerLabel} wallet '${this.walletId}' response is missing signing key`,
      });
    }

    return {
      keyId: this.signingKeyId,
      network: this.walletNetwork,
    };
  }

  private async createSignatureRequest(
    keyId: string,
    body: DfnsCreateSignatureBody
  ): Promise<DfnsSignatureRequest> {
    try {
      return await this.client.keySignatures.createSignature({
        keyId,
        body,
      });
    } catch (error) {
      throwSignerError(SignerErrorCode.HTTP_ERROR, {
        cause: error,
        message: `Failed to create ${this.providerLabel} signature request with key '${keyId}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  private async getSignatureRequest(
    keyId: string,
    signatureId: string
  ): Promise<DfnsSignatureRequest> {
    try {
      return await this.client.keySignatures.getSignature({
        keyId,
        signatureId,
      });
    } catch (error) {
      throwSignerError(SignerErrorCode.HTTP_ERROR, {
        cause: error,
        message: `Failed to fetch ${this.providerLabel} signature request '${signatureId}'`,
      });
    }
  }

  private async waitForSignatureResult(
    keyId: string,
    initial: DfnsSignatureRequest
  ): Promise<DfnsSignatureRequest> {
    let current = initial;

    for (let attempt = 0; attempt <= SIGNATURE_MAX_POLL_ATTEMPTS; attempt += 1) {
      const status = current.status;

      if (!status || TERMINAL_SUCCESS_STATUSES.has(status)) {
        return current;
      }

      if (TERMINAL_FAILURE_STATUSES.has(status)) {
        throwSignerError(SignerErrorCode.REMOTE_API_ERROR, {
          message: `${this.providerLabel} signature request failed (${status})${
            current.reason ? `: ${current.reason}` : ""
          }`,
        });
      }

      const signatureId = current.id;
      if (!signatureId) {
        throwSignerError(SignerErrorCode.REMOTE_API_ERROR, {
          message: `${this.providerLabel} signature request is '${status}' but missing request ID`,
        });
      }

      if (attempt === SIGNATURE_MAX_POLL_ATTEMPTS) {
        break;
      }

      await sleep(SIGNATURE_POLL_INTERVAL_MS);
      current = await this.getSignatureRequest(keyId, signatureId);
    }

    throwSignerError(SignerErrorCode.REMOTE_API_ERROR, {
      message: `Timed out while waiting for ${this.providerLabel} signature request to complete`,
    });
  }
}

function denormalizeDfnsWalletId(walletId: string): string {
  return walletId.startsWith("dfns_") ? walletId.slice("dfns_".length) : walletId;
}

function toHex(value: Uint8Array): string {
  return `0x${Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function fromHex(value: string): Uint8Array {
  const hex = normalizeHex(value);

  if (hex.length === 0 || hex.length % 2 !== 0) {
    throw new Error("Invalid hex-encoded value");
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    const byte = Number.parseInt(hex.slice(index, index + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error("Invalid hex-encoded value");
    }
    bytes[index / 2] = byte;
  }

  return bytes;
}

function normalizeHex(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
}

function isHexEncoded(value: string): boolean {
  const normalized = normalizeHex(value);
  return normalized.length > 0 && normalized.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(normalized);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function bytesToBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function tryParseEncodedBytes(value?: string): Uint8Array | null {
  if (!value || typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (isHexEncoded(trimmed)) {
    try {
      return fromHex(trimmed);
    } catch {
      // Fall through and try alternate encodings.
    }
  }

  if (!isLikelyBase64(trimmed)) {
    return null;
  }

  try {
    const decoded = base64ToBytes(trimmed);
    if (decoded.byteLength > 0) {
      return decoded;
    }
  } catch {
    // Ignore parse failures and return null below.
  }

  return null;
}

function isLikelyBase64(value: string): boolean {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").trim();
  if (!normalized) {
    return false;
  }

  if (normalized.length % 4 !== 0) {
    return false;
  }

  return /^[A-Za-z0-9+/]+={0,2}$/.test(normalized);
}

function extractSignatureBytes(
  request: DfnsSignatureRequest,
  providerLabel: string
): SignatureBytes {
  const compoundSignature =
    request.signature?.r && request.signature?.s
      ? `0x${normalizeHex(request.signature.r)}${normalizeHex(request.signature.s)}`
      : undefined;
  const candidates = [
    request.signature?.encoded,
    request.signatures?.[0]?.encoded,
    request.signedData,
    compoundSignature,
  ];

  for (const candidate of candidates) {
    const parsed = tryParseEncodedBytes(candidate);
    if (parsed) {
      return parsed as SignatureBytes;
    }
  }

  throwSignerError(SignerErrorCode.REMOTE_API_ERROR, {
    message: `${providerLabel} response does not contain a parsable signature payload`,
  });
}

function extractSignedTransactionBytes(
  request: DfnsSignatureRequest,
  providerLabel: string
): Uint8Array {
  const candidates = [
    request.signedData,
    request.signature?.encoded,
    request.signatures?.[0]?.encoded,
  ];

  for (const candidate of candidates) {
    const parsed = tryParseEncodedBytes(candidate);
    if (parsed) {
      return parsed;
    }
  }

  throwSignerError(SignerErrorCode.REMOTE_API_ERROR, {
    message: `${providerLabel} response does not contain a parsable signed transaction payload`,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSignatureTarget(
  network?: string
): { network: string } | { blockchainKind: typeof SOLANA_BLOCKCHAIN_KIND } {
  if (network && network.trim().length > 0) {
    return { network };
  }

  return { blockchainKind: SOLANA_BLOCKCHAIN_KIND };
}
