import { createClusterRpc } from "@sdp/rpc/factory";
import { runInClusterScope } from "@sdp/rpc/scope";
import type { SolanaRpc } from "@sdp/rpc/solana";
import type { ManagedRpcEnv } from "@sdp/rpc/types";
import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types/api-keys";
import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  GENESIS_HASH_BY_CLUSTER,
  SOLANA_CLUSTERS,
  type SolanaCluster,
} from "@sdp/types/well-known-tokens";
import { type Commitment, SOLANA_ERROR__JSON_RPC__METHOD_NOT_FOUND } from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { afterEach, beforeEach, vi } from "vitest";
import { z } from "zod";
import { BLANK_MANAGED_POOL_ENV } from "@/test/helpers/managed-pool-env";

/**
 * The one managed pool endpoint each cluster serves in tests. Fixed for the whole run, because
 * `createClusterRpc()` memoizes one client per cluster and URL set for the life of the module.
 */
const CLUSTER_RPC_URLS = {
  devnet: "https://devnet.cluster-rpc.sdp.test",
  "mainnet-beta": "https://mainnet-beta.cluster-rpc.sdp.test",
} as const satisfies Record<SolanaCluster, string>;

const MANAGED_POOL_ENV = {
  ...BLANK_MANAGED_POOL_ENV,
  SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL: CLUSTER_RPC_URLS.devnet,
  SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL: CLUSTER_RPC_URLS["mainnet-beta"],
} as const satisfies Required<ManagedRpcEnv>;

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

/** Each environment with the cluster its projects' chain reads and sends must land on. */
export const ENVIRONMENT_CLUSTER_CASES = [
  { environment: "sandbox", cluster: "devnet" },
  { environment: "production", cluster: "mainnet-beta" },
] as const satisfies readonly { environment: SdpEnvironment; cluster: SolanaCluster }[];

/**
 * The cluster and parsed body of a JSON-RPC fetch the stub intercepts. Like `fetch`, a request
 * whose signal is already aborted is refused before it reaches the endpoint or is recorded.
 *
 * @param input - The fetch target kit passed.
 * @param init - The fetch options kit passed.
 * @returns The cluster whose endpoint was hit and the request's parsed JSON body.
 * @throws Error when kit did not fetch a string URL with a string body.
 * @throws The signal's abort reason when the request was aborted before it was sent.
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
  init.signal?.throwIfAborted();
  return { cluster: clusterForUrl(input), body: JSON.parse(init.body) };
}

/**
 * Whether `input` targets a server on this machine, such as the local Clerk issuer serving JWKS.
 *
 * @param input - The resource a `fetch` call was made with.
 * @returns True when the request URL's host is a loopback address.
 */
function isLoopbackRequest(input: Parameters<typeof fetch>[0]): boolean {
  const requestUrl = input instanceof Request ? new URL(input.url) : new URL(input);
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
          error: {
            code: SOLANA_ERROR__JSON_RPC__METHOD_NOT_FOUND,
            message: `No stubbed answer for ${method}`,
          },
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

/** One JSON-RPC request that reached a cluster's endpoint, with the params it carried. */
export interface ClusterRpcRequest extends ClusterRpcCall {
  params: readonly unknown[];
}

const jsonRpcRequestWithParamsSchema = jsonRpcRequestSchema.extend({
  params: z.array(z.unknown()),
});

const signatureStatusesParamsSchema = z.union([
  z.tuple([z.array(z.string())]),
  z.tuple([z.array(z.string()), z.object({ searchTransactionHistory: z.literal(true) })]),
]);

/** What a responder answers one request with: a `result`, or a JSON-RPC `error` body. */
export type ClusterRpcReply =
  | { result: JsonRpcResult }
  | { error: { code: number; message: string } };

/** One signature's status as a stubbed `getSignatureStatuses` serves it. */
export interface StubSignatureStatus {
  slot: number;
  confirmations: number | null;
  confirmationStatus: Commitment;
  err: JsonRpcResult;
}

/** The signatures one `getSignatureStatuses` request asked a cluster about. */
export interface SignatureStatusesRead {
  cluster: SolanaCluster;
  signatures: readonly string[];
  searchTransactionHistory: boolean;
}

export interface ClusterRpcResponder extends ClusterRpcStub {
  /** Every request of the current test with its params, in arrival order; emptied after each test. */
  readonly requests: readonly ClusterRpcRequest[];
  /**
   * Answer every `method` request of the current test with `reply(request)`, ahead of any
   * {@link ClusterRpcStub.answer} for it, so a test can answer per cluster, per params or per
   * attempt, or fail the request.
   *
   * @param method - The JSON-RPC method name.
   * @param reply - Builds the answer from the request.
   */
  respond(method: string, reply: (request: ClusterRpcRequest) => ClusterRpcReply): void;
  /**
   * Answer every `getSignatureStatuses` request of the current test signature by signature.
   *
   * @param verdict - The status of one signature in one request, or null when the cluster has none.
   */
  respondSignatureStatuses(
    verdict: (signature: string, read: SignatureStatusesRead) => StubSignatureStatus | null
  ): void;
}

/**
 * The signatures a `getSignatureStatuses` request carried and whether it searched history.
 *
 * @param request - A recorded `getSignatureStatuses` request.
 * @returns The cluster, signatures and history flag the request carried.
 * @throws ZodError when the params are not a `getSignatureStatuses` call.
 */
export function signatureStatusesRead(request: ClusterRpcRequest): SignatureStatusesRead {
  const params = signatureStatusesParamsSchema.parse(request.params);
  return {
    cluster: request.cluster,
    signatures: params[0],
    searchTransactionHistory: params.length === 2,
  };
}

/**
 * A `getSignatureStatuses` answer listing `statuses` in request order.
 *
 * @param statuses - Each requested signature's status, or null when the cluster has none.
 * @returns The reply to return from a {@link ClusterRpcResponder.respond} responder.
 */
export function signatureStatusesReply(
  statuses: readonly (StubSignatureStatus | null)[]
): ClusterRpcReply {
  return signatureStatusesReplyAt(1, statuses);
}

/**
 * A `getSignatureStatuses` answer from a node that has processed through `contextSlot`, listing
 * `statuses` in request order.
 *
 * @param contextSlot - The slot the answering node reports its view at.
 * @param statuses - Each requested signature's status, or null when the node has none.
 * @returns The reply to return from a {@link ClusterRpcResponder.respond} responder.
 */
export function signatureStatusesReplyAt(
  contextSlot: number,
  statuses: readonly (StubSignatureStatus | null)[]
): ClusterRpcReply {
  return {
    result: {
      context: { slot: contextSlot },
      value: statuses.map((status) =>
        status === null
          ? null
          : {
              slot: status.slot,
              confirmations: status.confirmations,
              confirmationStatus: status.confirmationStatus,
              err: status.err,
            }
      ),
    },
  };
}

/**
 * {@link installClusterRpcStub}, also recording every request with its params and answering the
 * methods a test registers with {@link ClusterRpcResponder.respond}; methods without a responder
 * fall through to the stub. Register at `describe` level.
 *
 * @returns The current test's calls and requests, and the answer and responder registries.
 */
export function installClusterRpcResponder(): ClusterRpcResponder {
  const stub = installClusterRpcStub();
  const calls: ClusterRpcCall[] = [];
  const requests: ClusterRpcRequest[] = [];
  const replies = new Map<string, (request: ClusterRpcRequest) => ClusterRpcReply>();

  beforeEach(() => {
    const stubbedFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (isLoopbackRequest(input)) {
        return stubbedFetch(input, init);
      }
      const { cluster, body } = readJsonRpcFetch(input, init);
      const { id, method, params } = jsonRpcRequestWithParamsSchema.parse(body);
      const request: ClusterRpcRequest = { cluster, method, params };
      calls.push({ cluster, method });
      requests.push(request);
      const reply = replies.get(method);
      if (reply === undefined) {
        return stubbedFetch(input, init);
      }
      return Response.json({ jsonrpc: "2.0", id, ...reply(request) });
    };
  });

  afterEach(() => {
    calls.length = 0;
    requests.length = 0;
    replies.clear();
  });

  return {
    calls,
    requests,
    answer: stub.answer,
    respond(method, reply) {
      replies.set(method, reply);
    },
    respondSignatureStatuses(verdict) {
      replies.set("getSignatureStatuses", (request) => {
        const read = signatureStatusesRead(request);
        return signatureStatusesReply(read.signatures.map((signature) => verdict(signature, read)));
      });
    },
  };
}

/**
 * A `getEpochInfo` result for a chain tip at `absoluteSlot` and `blockHeight`, in epoch 0.
 *
 * @param tip - The tip the answering node reports.
 * @param tip.absoluteSlot - Its slot.
 * @param tip.blockHeight - Its block height.
 * @returns The JSON-RPC `result` to pass to {@link ClusterRpcStub.answer}.
 */
export function epochInfoResult(tip: { absoluteSlot: number; blockHeight: number }): JsonRpcResult {
  return {
    absoluteSlot: tip.absoluteSlot,
    blockHeight: tip.blockHeight,
    epoch: 0,
    slotIndex: tip.absoluteSlot,
    slotsInEpoch: 432_000,
    transactionCount: null,
  };
}

/** A jsonParsed SPL token account a stubbed `getTokenAccountsByOwner` answers with. */
export interface StubTokenAccount {
  pubkey: string;
  mint: string;
  amount: string;
  decimals: number;
  uiAmountString: string;
  state: "initialized" | "frozen";
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
              state: tokenAccount.state,
            },
          },
        },
      },
    })),
  };
}

/**
 * A base64 `getAccountInfo` result for a data-less System account holding `lamports`.
 *
 * @param slot - The context slot the answer claims.
 * @param lamports - The account's balance, a safe integer; kit decodes it as a bigint.
 * @returns The JSON-RPC `result` to pass to {@link ClusterRpcStub.answer}.
 */
export function systemAccountInfoResult(slot: number, lamports: number): JsonRpcResult {
  return {
    context: { slot },
    value: {
      data: ["", "base64"],
      executable: false,
      lamports,
      owner: SYSTEM_PROGRAM_ADDRESS,
      rentEpoch: 0,
      space: 0,
    },
  };
}

/**
 * A `getTokenSupply` result for a mint with no supply yet, which is all a decimals read needs.
 *
 * @param slot - The context slot the answer claims.
 * @param decimals - The mint's decimals.
 * @returns The JSON-RPC `result` to pass to {@link ClusterRpcStub.answer}.
 */
export function tokenSupplyResult(slot: number, decimals: number): JsonRpcResult {
  return {
    context: { slot },
    value: { amount: "0", decimals, uiAmount: 0, uiAmountString: "0" },
  };
}

/**
 * The cluster whose `createClusterRpc()` client `client` is, so a test can tell which cluster a
 * spied chain helper was handed. The factory memoizes one client per cluster and pool, so the
 * client work received under a scope is the one this resolves; call it while the stub is installed
 * and outside any cluster scope.
 *
 * @param client - The RPC client a spied helper received.
 * @returns The cluster it serves, or undefined when it is no cluster scope's client.
 */
export function clusterOfRpcClient(client: SolanaRpc): SolanaCluster | undefined {
  const environment = SDP_ENVIRONMENTS.find(
    (candidate) =>
      runInClusterScope({ projectId: null, environment: candidate }, () => createClusterRpc()) ===
      client
  );
  return environment === undefined ? undefined : CLUSTER_BY_SDP_ENVIRONMENT[environment];
}
