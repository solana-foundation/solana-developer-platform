// biome-ignore-all lint/security/noSecrets: Solana JSON-RPC method names, not credentials.
import type { RpcTransport } from "@solana/kit";

/**
 * Solana JSON-RPC methods that only read, so sending one twice is harmless.
 * Absent on purpose: `sendTransaction`, `requestAirdrop` and
 * `simulateTransaction`, the blockhash and fee reads a transaction is built on
 * (`getLatestBlockhash`, `isBlockhashValid`, `getRecentBlockhash`,
 * `getFeeForMessage`, `getRecentPrioritizationFees`), and every method a
 * provider adds on top.
 */
const READ_METHODS: ReadonlySet<string> = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlock",
  "getBlockCommitment",
  "getBlockHeight",
  "getBlockProduction",
  "getBlocks",
  "getBlocksWithLimit",
  "getBlockTime",
  "getClusterNodes",
  "getEpochInfo",
  "getEpochSchedule",
  "getFirstAvailableBlock",
  "getGenesisHash",
  "getHealth",
  "getHighestSnapshotSlot",
  "getIdentity",
  "getInflationGovernor",
  "getInflationRate",
  "getInflationReward",
  "getLargestAccounts",
  "getLeaderSchedule",
  "getMaxRetransmitSlot",
  "getMaxShredInsertSlot",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getRecentPerformanceSamples",
  "getSignaturesForAddress",
  "getSignatureStatuses",
  "getSlot",
  "getSlotLeader",
  "getSlotLeaders",
  "getStakeMinimumDelegation",
  "getSupply",
  "getTokenAccountBalance",
  "getTokenAccountsByDelegate",
  "getTokenAccountsByOwner",
  "getTokenLargestAccounts",
  "getTokenSupply",
  "getTransaction",
  "getTransactionCount",
  "getVersion",
  "getVoteAccounts",
  "minimumLedgerSlot",
]);

/** One JSON-RPC request (never a batch) whose method only reads. */
function isJsonRpcRead(payload: unknown): boolean {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const method = (payload as { method?: unknown }).method;
  return typeof method === "string" && READ_METHODS.has(method);
}

/**
 * `fetch` rejected because its socket closed or reset before any response
 * arrived. A body that dies after the headers rejects as "terminated" instead
 * and is not this case.
 */
function isSocketDeathBeforeResponse(error: unknown): boolean {
  if (!(error instanceof TypeError) || error.message !== "fetch failed") return false;
  const cause: unknown = error.cause;
  if (cause === null || typeof cause !== "object") return false;
  const { code, message } = cause as { code?: unknown; message?: unknown };
  return (
    code === "UND_ERR_SOCKET" ||
    code === "ECONNRESET" ||
    (typeof message === "string" && message.includes("other side closed"))
  );
}

/**
 * Sends a JSON-RPC read once more, at once and to the same URL, when its socket
 * died before any response: a pooled keep-alive socket the server closed just
 * as it was reused. Every other failure, and every non-read method, surfaces
 * unchanged.
 */
export function withReadSocketRetry(transport: RpcTransport): RpcTransport {
  return async <TResponse>(config: Parameters<RpcTransport>[0]) => {
    try {
      return await transport<TResponse>(config);
    } catch (error) {
      if (
        config.signal?.aborted ||
        !isSocketDeathBeforeResponse(error) ||
        !isJsonRpcRead(config.payload)
      ) {
        throw error;
      }
      return await transport<TResponse>(config);
    }
  };
}

/** `fetch` with the same one retry, for a JSON-RPC body sent as a string. */
export async function fetchWithReadSocketRetry(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (
      init?.signal?.aborted ||
      !isSocketDeathBeforeResponse(error) ||
      !(typeof input === "string" || input instanceof URL) ||
      typeof init?.body !== "string" ||
      !isJsonRpcRead(parseJson(init.body))
    ) {
      throw error;
    }
    return await fetch(input, init);
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
