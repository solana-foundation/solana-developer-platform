import { formatDecimalAmount } from "@/lib/amount";
import { getSolanaConfig } from "@/lib/solana";
import type { createRpc } from "@/services/solana/rpc";
import type { Env } from "@/types/env";

export type SignatureStatusRow = {
  signature: string;
  slot: number | bigint;
  err: unknown;
  confirmationStatus?: string | null;
  blockTime?: number | null;
};

type SignaturesForAddressRpc = {
  getSignaturesForAddress: (
    address: string,
    options: { limit: number; before?: string; commitment: "confirmed" }
  ) => {
    send: () => Promise<SignatureStatusRow[]>;
  };
};

type TransactionBySignatureRpc = {
  getTransaction: (
    signature: string,
    options: {
      commitment: "confirmed";
      maxSupportedTransactionVersion: number;
      encoding: "jsonParsed";
    }
  ) => { send: () => Promise<unknown> };
};

export type SignatureConfirmation = {
  slot: number | bigint;
  err: unknown;
  confirmationStatus?: string | null;
};

type SignatureStatusesRpc = {
  getSignatureStatuses: (signatures: string[]) => {
    send: () => Promise<{
      value: Array<{
        slot: number | bigint;
        err: unknown;
        confirmationStatus?: string | null;
      } | null>;
    }>;
  };
};

type JsonRpcBatchItem = {
  id?: string | number;
  result?: unknown;
};

const DEFAULT_BATCH_SIZE = 25;

export async function listSignaturesForAddressPaged(
  rpc: ReturnType<typeof createRpc>,
  address: string,
  options: { limit: number; before?: string }
): Promise<SignatureStatusRow[]> {
  return (rpc as unknown as SignaturesForAddressRpc)
    .getSignaturesForAddress(address, {
      limit: options.limit,
      ...(options.before ? { before: options.before } : {}),
      commitment: "confirmed",
    })
    .send();
}

export async function getTransactionJsonParsed(
  rpc: ReturnType<typeof createRpc>,
  signature: string
): Promise<unknown> {
  return (rpc as unknown as TransactionBySignatureRpc)
    .getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
      encoding: "jsonParsed",
    })
    .send();
}

export async function getSignatureConfirmation(
  rpc: ReturnType<typeof createRpc>,
  signature: string
): Promise<SignatureConfirmation | null> {
  const result = await (rpc as unknown as SignatureStatusesRpc)
    .getSignatureStatuses([signature])
    .send();
  const row = result.value[0];
  if (!row) {
    return null;
  }

  return {
    slot: row.slot,
    err: row.err,
    confirmationStatus: row.confirmationStatus,
  };
}

async function fetchTransactionsBatch(
  env: Env,
  signatures: string[]
): Promise<Map<string, unknown | null>> {
  const { rpcUrl } = getSolanaConfig(env);
  const payload = signatures.map((signature) => ({
    jsonrpc: "2.0",
    id: signature,
    method: "getTransaction",
    params: [
      signature,
      {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
        encoding: "jsonParsed",
      },
    ],
  }));

  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Batch getTransaction failed with status ${response.status}`);
  }

  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) {
    throw new Error("Invalid JSON-RPC batch response");
  }

  const mapped = new Map<string, unknown | null>();
  for (const signature of signatures) {
    mapped.set(signature, null);
  }

  for (const entry of body as JsonRpcBatchItem[]) {
    const id = entry?.id;
    if (typeof id !== "string") {
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(entry, "result")) {
      mapped.set(id, entry.result ?? null);
      continue;
    }

    mapped.set(id, null);
  }

  return mapped;
}

export async function getTransactionsJsonParsedBatch(input: {
  env: Env;
  rpc: ReturnType<typeof createRpc>;
  signatures: string[];
  chunkSize?: number;
}): Promise<Map<string, unknown | null>> {
  const uniqueSignatures = Array.from(new Set(input.signatures));
  const results = new Map<string, unknown | null>();
  if (uniqueSignatures.length === 0) {
    return results;
  }

  const chunkSize = Math.max(1, input.chunkSize ?? DEFAULT_BATCH_SIZE);

  for (let index = 0; index < uniqueSignatures.length; index += chunkSize) {
    const chunk = uniqueSignatures.slice(index, index + chunkSize);

    try {
      const chunkResults = await fetchTransactionsBatch(input.env, chunk);
      for (const [signature, tx] of chunkResults) {
        results.set(signature, tx);
      }
      continue;
    } catch {
      // Fall through to sequential per-signature RPC calls for compatibility.
    }

    await Promise.all(
      chunk.map(async (signature) => {
        try {
          const tx = await getTransactionJsonParsed(input.rpc, signature);
          results.set(signature, tx ?? null);
        } catch {
          results.set(signature, null);
        }
      })
    );
  }

  return results;
}

export function mapSignatureStatusToTransferStatus(input: {
  confirmationStatus?: string | null;
  err?: unknown;
}) {
  if (input.err) return "failed" as const;
  if (input.confirmationStatus === "finalized") return "finalized" as const;
  if (input.confirmationStatus === "processed") return "processing" as const;
  return "confirmed" as const;
}

function coerceInstructionInfoValue(value: unknown): string | number | null {
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function extractTransactionAddresses(tx: unknown): Set<string> {
  const addresses = new Set<string>();

  const candidate = tx as {
    transaction?: {
      message?: {
        accountKeys?: Array<string | { pubkey?: string }>;
        instructions?: Array<{ parsed?: { info?: Record<string, unknown> } }>;
      };
    };
  };

  for (const key of candidate.transaction?.message?.accountKeys ?? []) {
    if (typeof key === "string") {
      addresses.add(key);
      continue;
    }

    if (typeof key?.pubkey === "string") {
      addresses.add(key.pubkey);
    }
  }

  for (const instruction of candidate.transaction?.message?.instructions ?? []) {
    const info = instruction.parsed?.info;
    if (!info) {
      continue;
    }

    for (const field of ["source", "destination", "authority", "mint"]) {
      const value = coerceInstructionInfoValue(info[field]);
      if (typeof value === "string") {
        addresses.add(value);
      }
    }
  }

  return addresses;
}

export function touchesOwnedWallet(tx: unknown, ownedAddresses: Set<string>): boolean {
  if (ownedAddresses.size === 0) {
    return false;
  }

  const addresses = extractTransactionAddresses(tx);
  for (const address of addresses) {
    if (ownedAddresses.has(address)) {
      return true;
    }
  }

  return false;
}

export function inferTransferFromTransaction(
  tx: unknown,
  input: {
    queriedAddress?: string;
    ownedAddresses?: Set<string>;
  } = {}
): {
  type: "transfer" | "transfer_confidential";
  direction: "inbound" | "outbound";
  source?: string;
  destination?: string;
  token?: string;
  amount?: string;
  fee?: number | null;
} {
  const candidate = tx as {
    meta?: { fee?: number };
    transaction?: {
      message?: {
        instructions?: Array<{
          parsed?: { type?: string; info?: Record<string, unknown> };
        }>;
      };
    };
  };

  const ownedAddresses = input.ownedAddresses ?? new Set<string>();
  if (input.queriedAddress) {
    ownedAddresses.add(input.queriedAddress);
  }

  const instructions = candidate.transaction?.message?.instructions ?? [];
  for (const instruction of instructions) {
    const parsed = instruction.parsed;
    if (!parsed?.info) continue;

    const sourceRaw = coerceInstructionInfoValue(parsed.info.source);
    const destinationRaw = coerceInstructionInfoValue(parsed.info.destination);
    const authorityRaw = coerceInstructionInfoValue(parsed.info.authority);
    const mintRaw = coerceInstructionInfoValue(parsed.info.mint);
    const lamportsRaw = coerceInstructionInfoValue(parsed.info.lamports);
    const amountRaw = coerceInstructionInfoValue(parsed.info.amount);
    const tokenAmountUiRaw =
      typeof parsed.info.tokenAmount === "object" && parsed.info.tokenAmount !== null
        ? coerceInstructionInfoValue(
            (parsed.info.tokenAmount as Record<string, unknown>).uiAmountString
          )
        : null;

    const source = typeof sourceRaw === "string" ? sourceRaw : undefined;
    const destination = typeof destinationRaw === "string" ? destinationRaw : undefined;
    const authority = typeof authorityRaw === "string" ? authorityRaw : undefined;

    const isOutbound =
      (source ? ownedAddresses.has(source) : false) ||
      (authority ? ownedAddresses.has(authority) : false);
    const isInbound = destination ? ownedAddresses.has(destination) : false;
    const direction = isOutbound ? "outbound" : isInbound ? "inbound" : "outbound";

    if (typeof lamportsRaw === "number" || typeof lamportsRaw === "string") {
      const lamports = BigInt(lamportsRaw);
      return {
        type: "transfer",
        direction,
        source,
        destination,
        token: "SOL",
        amount: formatDecimalAmount(lamports, 9),
        fee: candidate.meta?.fee ?? null,
      };
    }

    if (source || destination || authority) {
      return {
        type: parsed.type?.toLowerCase().includes("confidential")
          ? "transfer_confidential"
          : "transfer",
        direction,
        source: source ?? authority,
        destination,
        token: typeof mintRaw === "string" ? mintRaw : undefined,
        amount:
          typeof tokenAmountUiRaw === "string"
            ? tokenAmountUiRaw
            : typeof amountRaw === "string" || typeof amountRaw === "number"
              ? String(amountRaw)
              : undefined,
        fee: candidate.meta?.fee ?? null,
      };
    }
  }

  return {
    type: "transfer",
    direction: "outbound",
    fee: candidate.meta?.fee ?? null,
  };
}

export function unixSecondsToIso(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number") return null;
  return new Date(seconds * 1000).toISOString();
}
