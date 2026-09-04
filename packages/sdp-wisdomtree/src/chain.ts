import type { Address } from "@solana/kit";
import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  type RpcTransport,
} from "@solana/kit";
import { SdpWisdomTreeError } from "./errors";

/**
 * The one chain-read seam the builders consume. An interface rather than a raw
 * RPC client so unit tests inject a fake and stay offline (the repo rule), and
 * so every read shares one transport deadline.
 */
export interface WisdomTreeChainReader {
  /** The account's owner program and raw data, or null when it does not exist. */
  getAccount(accountAddress: Address): Promise<{ owner: string; data: Uint8Array } | null>;
}

export const WISDOMTREE_RPC_REQUEST_TIMEOUT_MS = 30_000;

/** Same transport-boundary deadline pattern as `@sdp/kamino`'s rpc.ts. */
function withTimeout(transport: RpcTransport, timeoutMs: number): RpcTransport {
  return async <TResponse>(config: Parameters<RpcTransport>[0]) => {
    const controller = new AbortController();
    const deadlineReason = new Error("WisdomTree RPC deadline elapsed");
    const timer = setTimeout(() => controller.abort(deadlineReason), timeoutMs);
    const signal = config.signal
      ? AbortSignal.any([config.signal, controller.signal])
      : controller.signal;
    try {
      return await transport<TResponse>({ ...config, signal });
    } catch (cause) {
      if (signal.aborted && signal.reason === deadlineReason) {
        throw new Error(`WisdomTree RPC request timed out after ${timeoutMs}ms`, { cause });
      }
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createWisdomTreeChainReader(
  rpcUrl: string,
  timeoutMs = WISDOMTREE_RPC_REQUEST_TIMEOUT_MS
): WisdomTreeChainReader {
  const rpc = createSolanaRpcFromTransport(
    withTimeout(createDefaultRpcTransport({ url: rpcUrl }), timeoutMs)
  );
  return {
    async getAccount(accountAddress) {
      let value: { owner: unknown; data: unknown } | null;
      try {
        const response = await rpc.getAccountInfo(accountAddress, { encoding: "base64" }).send();
        value = response.value;
      } catch (cause) {
        throw new SdpWisdomTreeError(
          "CHAIN_UNREADABLE",
          `Failed to read account ${accountAddress}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          { cause }
        );
      }
      if (value === null) {
        return null;
      }
      const encoded = Array.isArray(value.data) ? value.data[0] : undefined;
      if (typeof encoded !== "string" || typeof value.owner !== "string") {
        throw new SdpWisdomTreeError(
          "CHAIN_UNREADABLE",
          `Account ${accountAddress} came back in an unrecognized RPC shape.`
        );
      }
      return { owner: value.owner, data: Uint8Array.from(Buffer.from(encoded, "base64")) };
    },
  };
}

/** Exact token-account balance in base units, from the raw 165-byte layout (amount is u64 LE at offset 64). */
export function tokenAccountBaseUnits(data: Uint8Array): bigint {
  if (data.length < 72) {
    throw new SdpWisdomTreeError(
      "CHAIN_UNREADABLE",
      `Token account data is ${data.length} bytes — shorter than the token-account layout.`
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(64, true);
}
