import type { Address } from "@solana/kit";
import { AppError, type ErrorCode, providerUnavailable } from "@/lib/errors";
import { getSolanaConfig } from "@/lib/solana";
import type { Env } from "@/types/env";

const MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = "https://payments.magicblock.app";
const MAGICBLOCK_PRIVATE_PAYMENTS_TIMEOUT_MS = 15_000;

export type MagicBlockBalanceLocation = "base" | "ephemeral";
export type MagicBlockTransferVisibility = "public" | "private";

export interface MagicBlockPrivateTransferOptions {
  visibility: MagicBlockTransferVisibility;
  fromBalance: MagicBlockBalanceLocation;
  toBalance: MagicBlockBalanceLocation;
  validator?: string;
  initIfMissing?: boolean;
  initAtasIfMissing?: boolean;
  initVaultIfMissing?: boolean;
  minDelayMs?: string;
  maxDelayMs?: string;
  clientRefId?: string;
  split?: number;
  gasless?: boolean;
  legacy?: boolean;
}

export interface MagicBlockPrepareTransferInput {
  from: Address;
  to: Address;
  mint: Address;
  amount: number;
  memo?: string;
  options: MagicBlockPrivateTransferOptions;
}

export interface MagicBlockUnsignedTransaction {
  kind: "deposit" | "withdraw" | "transfer" | string;
  version: "legacy" | "v0" | string;
  transactionBase64: string;
  sendTo: MagicBlockBalanceLocation;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  instructionCount: number;
  requiredSigners: string[];
  validator?: string;
}

interface MagicBlockConfig {
  apiBaseUrl: string;
  authToken?: string;
  cluster: "mainnet" | "devnet";
}

function safeParseJson(raw: string): unknown {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveMagicBlockConfig(env: Env): MagicBlockConfig {
  const apiBaseUrl =
    env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL?.trim() ||
    MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL;

  try {
    new URL(apiBaseUrl);
  } catch {
    throw new AppError("INTERNAL_ERROR", "MagicBlock private payments API URL is invalid.");
  }

  const cluster = getSolanaConfig(env).network === "mainnet-beta" ? "mainnet" : "devnet";
  const authToken = env.MAGICBLOCK_PRIVATE_PAYMENTS_AUTH_TOKEN?.trim() || undefined;

  return { apiBaseUrl, authToken, cluster };
}

function buildAuthorizationHeader(authToken: string): string {
  return authToken.toLowerCase().startsWith("bearer ") ? authToken : `Bearer ${authToken}`;
}

function buildMagicBlockTransferPayload(input: MagicBlockPrepareTransferInput, cluster: string) {
  const { options } = input;

  return {
    from: input.from,
    to: input.to,
    cluster,
    mint: input.mint,
    amount: input.amount,
    visibility: options.visibility,
    fromBalance: options.fromBalance,
    toBalance: options.toBalance,
    ...(input.memo ? { memo: input.memo } : {}),
    ...(options.validator ? { validator: options.validator } : {}),
    ...(options.initIfMissing !== undefined ? { initIfMissing: options.initIfMissing } : {}),
    ...(options.initAtasIfMissing !== undefined
      ? { initAtasIfMissing: options.initAtasIfMissing }
      : {}),
    ...(options.initVaultIfMissing !== undefined
      ? { initVaultIfMissing: options.initVaultIfMissing }
      : {}),
    ...(options.minDelayMs !== undefined ? { minDelayMs: options.minDelayMs } : {}),
    ...(options.maxDelayMs !== undefined ? { maxDelayMs: options.maxDelayMs } : {}),
    ...(options.clientRefId !== undefined ? { clientRefId: options.clientRefId } : {}),
    ...(options.split !== undefined ? { split: options.split } : {}),
    ...(options.gasless !== undefined ? { gasless: options.gasless } : {}),
    ...(options.legacy !== undefined ? { legacy: options.legacy } : {}),
  };
}

function readProviderErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null) {
    return fallback;
  }

  const record = payload as {
    error?: { message?: unknown };
    message?: unknown;
    reason?: unknown;
  };

  const message = record.error?.message ?? record.message ?? record.reason;
  return typeof message === "string" && message.trim() ? message : fallback;
}

function classifyMagicBlockErrorStatus(status: number): ErrorCode {
  if (status === 429) {
    return "RATE_LIMITED";
  }

  if (status >= 500) {
    return "PROVIDER_UNAVAILABLE";
  }

  return "BAD_REQUEST";
}

function magicBlockProviderError(status: number, payload: unknown): AppError {
  return new AppError(
    classifyMagicBlockErrorStatus(status),
    readProviderErrorMessage(payload, `MagicBlock request failed with status ${status}`),
    {
      provider: "magicblock",
      providerStatus: status,
    }
  );
}

function parseUnsignedTransaction(payload: unknown): MagicBlockUnsignedTransaction {
  if (typeof payload !== "object" || payload === null) {
    throw new AppError("BAD_REQUEST", "MagicBlock transfer response payload is invalid.");
  }

  const record = payload as Partial<MagicBlockUnsignedTransaction>;

  if (
    typeof record.kind !== "string" ||
    typeof record.version !== "string" ||
    typeof record.transactionBase64 !== "string" ||
    (record.sendTo !== "base" && record.sendTo !== "ephemeral") ||
    typeof record.recentBlockhash !== "string" ||
    typeof record.lastValidBlockHeight !== "number" ||
    !Number.isInteger(record.lastValidBlockHeight) ||
    typeof record.instructionCount !== "number" ||
    !Number.isInteger(record.instructionCount) ||
    !Array.isArray(record.requiredSigners) ||
    !record.requiredSigners.every((signer) => typeof signer === "string")
  ) {
    throw new AppError("BAD_REQUEST", "MagicBlock transfer response payload is invalid.");
  }

  return {
    kind: record.kind,
    version: record.version,
    transactionBase64: record.transactionBase64,
    sendTo: record.sendTo,
    recentBlockhash: record.recentBlockhash,
    lastValidBlockHeight: record.lastValidBlockHeight,
    instructionCount: record.instructionCount,
    requiredSigners: record.requiredSigners,
    ...(typeof record.validator === "string" ? { validator: record.validator } : {}),
  };
}

export async function prepareMagicBlockPrivateTransfer(
  env: Env,
  input: MagicBlockPrepareTransferInput
): Promise<MagicBlockUnsignedTransaction> {
  const config = resolveMagicBlockConfig(env);
  const url = new URL("/v1/spl/transfer", config.apiBaseUrl);
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  if (config.authToken) {
    headers.Authorization = buildAuthorizationHeader(config.authToken);
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(buildMagicBlockTransferPayload(input, config.cluster)),
      signal: AbortSignal.timeout(MAGICBLOCK_PRIVATE_PAYMENTS_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw providerUnavailable("MagicBlock request timed out.", {
        provider: "magicblock",
        timeoutMs: MAGICBLOCK_PRIVATE_PAYMENTS_TIMEOUT_MS,
      });
    }

    throw providerUnavailable("MagicBlock request failed before receiving a response.", {
      provider: "magicblock",
    });
  }

  const raw = await response.text();
  const parsed = safeParseJson(raw);

  if (!response.ok) {
    throw magicBlockProviderError(response.status, parsed);
  }

  return parseUnsignedTransaction(parsed);
}
