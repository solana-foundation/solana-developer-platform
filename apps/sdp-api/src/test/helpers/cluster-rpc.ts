import type { ManagedRpcEnv } from "@sdp/rpc";
import { GENESIS_HASH_BY_CLUSTER, SOLANA_CLUSTERS, type SolanaCluster } from "@sdp/types";
import { afterEach, beforeEach, vi } from "vitest";
import { z } from "zod";
import { BLANK_MANAGED_POOL_ENV } from "@/test/helpers/managed-pool-env";

/**
 * The one managed pool endpoint each cluster serves in tests. Fixed for the whole run, because
 * `createClusterRpc()` memoizes one client per cluster and URL set for the life of the module.
 */
export const CLUSTER_RPC_URLS = {
  devnet: "https://devnet.cluster-rpc.sdp.test",
  "mainnet-beta": "https://mainnet-beta.cluster-rpc.sdp.test",
} as const satisfies Record<SolanaCluster, string>;

const MANAGED_POOL_ENV = {
  ...BLANK_MANAGED_POOL_ENV,
  SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL: CLUSTER_RPC_URLS.devnet,
  SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL: CLUSTER_RPC_URLS["mainnet-beta"],
} as const satisfies Required<ManagedRpcEnv>;

const JSON_RPC_METHOD_NOT_FOUND = -32601;

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

const jsonRpcRequestSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.string(),
});

/** A JSON value a stubbed endpoint answers with; kit decodes integers as bigints. */
export type JsonRpcResult =
  | null
  | boolean
  | number
  | string
  | readonly JsonRpcResult[]
  | { readonly [field: string]: JsonRpcResult };

/** One JSON-RPC request that reached a cluster's endpoint, genesis probes included. */
export interface ClusterRpcCall {
  cluster: SolanaCluster;
  method: string;
}

export interface ClusterRpcStub {
  /** Every request of the current test, in arrival order; emptied after each test. */
  readonly calls: readonly ClusterRpcCall[];
  /**
   * Answer `method` with `result` on both clusters for the rest of the current test; a method
   * without an answer gets a JSON-RPC `-32601` error.
   *
   * @param method - The JSON-RPC method name.
   * @param result - The `result` the endpoint returns.
   */
  answer(method: string, result: JsonRpcResult): void;
}

/**
 * The cluster whose test endpoint `endpointUrl` is.
 *
 * @param endpointUrl - The URL a request was sent to.
 * @returns The cluster serving it.
 * @throws Error when the URL is not a cluster test endpoint.
 */
function clusterForUrl(endpointUrl: string): SolanaCluster {
  const cluster = SOLANA_CLUSTERS.find((candidate) => CLUSTER_RPC_URLS[candidate] === endpointUrl);
  if (cluster === undefined) {
    throw new Error(`Unexpected fetch to ${endpointUrl} under the cluster RPC stub`);
  }
  return cluster;
}

/**
 * The cluster and parsed body of a JSON-RPC fetch the stub intercepts.
 *
 * @param input - The fetch target kit passed.
 * @param init - The fetch options kit passed.
 * @returns The cluster whose endpoint was hit and the request's parsed JSON body.
 * @throws Error when kit did not fetch a string URL with a string body.
 */
function readJsonRpcFetch(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1]
): { cluster: SolanaCluster; body: unknown } {
  if (typeof input !== "string") {
    throw new Error("The cluster RPC stub expects kit to fetch a string URL");
  }
  if (init === undefined || typeof init.body !== "string") {
    throw new Error(`Expected a JSON-RPC body on the fetch to ${input}`);
  }
  return { cluster: clusterForUrl(input), body: JSON.parse(init.body) };
}

/**
 * Whether `input` targets a server on this machine, such as the local Clerk issuer serving JWKS.
 *
 * @param input - The resource a `fetch` call was made with.
 * @returns True when the request URL's host is a loopback address.
 */
function isLoopbackRequest(input: Parameters<typeof fetch>[0]): boolean {
  const requestUrl =
    typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
  return LOOPBACK_HOSTNAMES.has(requestUrl.hostname);
}

/**
 * Point the managed pool of each cluster at its one test endpoint (every other provider blanked)
 * and stub global `fetch` so each endpoint proves its own cluster's genesis hash and answers the
 * results a test registers. Requests to a loopback host (`127.0.0.1`, `localhost`, `[::1]`), such
 * as local test servers, pass through to the original `fetch` unchanged and are not recorded; any
 * other URL that is not a cluster test endpoint throws, so no test reaches the network. Opens no
 * cluster scope: requests do, through the real middleware or `runInClusterScope`. Register at
 * `describe` level; env and `fetch` are restored after each test.
 *
 * @returns The current test's recorded calls and the answer registry.
 */
export function installClusterRpcStub(): ClusterRpcStub {
  const originalFetch = globalThis.fetch;
  const calls: ClusterRpcCall[] = [];
  const results = new Map<string, JsonRpcResult>();

  beforeEach(() => {
    for (const [envKey, endpointUrl] of Object.entries(MANAGED_POOL_ENV)) {
      vi.stubEnv(envKey, endpointUrl);
    }
    globalThis.fetch = async (input, init) => {
      if (isLoopbackRequest(input)) {
        return originalFetch(input, init);
      }
      const { cluster, body } = readJsonRpcFetch(input, init);
      const { id, method } = jsonRpcRequestSchema.parse(body);
      calls.push({ cluster, method });
      if (method === "getGenesisHash") {
        return Response.json({ jsonrpc: "2.0", id, result: GENESIS_HASH_BY_CLUSTER[cluster] });
      }
      const result = results.get(method);
      if (result === undefined) {
        return Response.json({
          jsonrpc: "2.0",
          id,
          error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `No stubbed answer for ${method}` },
        });
      }
      return Response.json({ jsonrpc: "2.0", id, result });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    calls.length = 0;
    results.clear();
  });

  return {
    calls,
    answer(method, result) {
      results.set(method, result);
    },
  };
}

const jsonRpcParamsSchema = z.object({
  method: z.string(),
  params: z.array(z.unknown()),
});

/** One JSON-RPC request that reached a cluster's endpoint, with the params it carried. */
export interface ClusterRpcRequest extends ClusterRpcCall {
  params: readonly unknown[];
}

export interface ClusterRpcRequestLog extends ClusterRpcStub {
  /** Every request of the current test with its params, in arrival order; emptied after each test. */
  readonly requests: readonly ClusterRpcRequest[];
}

/**
 * {@link installClusterRpcStub}, also recording the params of every request, for tests that
 * assert what a read asked the cluster for. Register at `describe` level.
 *
 * @returns The stub plus the current test's requests with their params.
 */
export function installClusterRpcRequestLog(): ClusterRpcRequestLog {
  const stub = installClusterRpcStub();
  const requests: ClusterRpcRequest[] = [];

  beforeEach(() => {
    const stubbedFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (isLoopbackRequest(input)) {
        return stubbedFetch(input, init);
      }
      const { cluster, body } = readJsonRpcFetch(input, init);
      const { method, params } = jsonRpcParamsSchema.parse(body);
      requests.push({ cluster, method, params });
      return stubbedFetch(input, init);
    };
  });

  afterEach(() => {
    requests.length = 0;
  });

  return { ...stub, requests };
}

/** A jsonParsed SPL token account a stubbed `getTokenAccountsByOwner` answers with. */
interface StubTokenAccount {
  pubkey: string;
  mint: string;
  amount: string;
  decimals: number;
  uiAmountString: string;
}

/**
 * A `getTokenAccountsByOwner` result served from the bank at `slot`.
 *
 * @param slot - The context slot the answer claims.
 * @param tokenAccounts - The owner's token accounts.
 * @returns The JSON-RPC `result` to pass to {@link ClusterRpcStub.answer}.
 */
export function tokenAccountsByOwnerResult(
  slot: number,
  tokenAccounts: readonly StubTokenAccount[]
): JsonRpcResult {
  return {
    context: { slot },
    value: tokenAccounts.map((tokenAccount) => ({
      pubkey: tokenAccount.pubkey,
      account: {
        data: {
          parsed: {
            info: {
              mint: tokenAccount.mint,
              tokenAmount: {
                amount: tokenAccount.amount,
                decimals: tokenAccount.decimals,
                uiAmountString: tokenAccount.uiAmountString,
              },
            },
          },
        },
      },
    })),
  };
}
