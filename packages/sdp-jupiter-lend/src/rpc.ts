import { createHash } from "node:crypto";
import { lendingPda } from "@jup-ag/lend";
import {
  currentMinimumRpcSlot,
  fetchWithReadSocketRetry,
  readFloor,
  readStamp,
  withRpcReadContextFetch,
} from "@sdp/rpc/read-context";
import { JUPITER_LEND_EARN_PROGRAM_IDS, JUPITER_LEND_USDT } from "@sdp/types/jupiter-lend-programs";
import {
  type Commitment,
  Connection,
  type GetProgramAccountsConfig,
  type GetProgramAccountsResponse,
  PublicKey,
  type RpcResponseAndContext,
} from "@solana/web3.js";

/** Reads whose identical in-flight requests may share one response. */
const SHARED_READ_METHODS = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getTokenAccountBalance",
  "getTokenSupply",
]);

interface SharedResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body: string;
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function sharedReadKey(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined
): string | undefined {
  if (init?.signal || typeof init?.body !== "string") return undefined;
  let request: unknown;
  try {
    request = JSON.parse(init.body);
  } catch {
    return undefined;
  }
  if (request === null || typeof request !== "object" || Array.isArray(request)) return undefined;
  const { method, params } = request as { method?: unknown; params?: unknown };
  if (typeof method !== "string" || !SHARED_READ_METHODS.has(method)) return undefined;
  // The endpoint by hash: RPC URLs carry API keys.
  return JSON.stringify([
    createHash("sha256").update(requestUrl(input)).digest("hex").slice(0, 16),
    method,
    params ?? null,
    currentMinimumRpcSlot() ?? null,
  ]);
}

/**
 * Identical JSON-RPC reads in flight together share one request and response.
 *
 * Sits BELOW the read context (`withRpcReadContextFetch`) and keys on the
 * caller's minimum slot, so a scoped read never shares with an unscoped one or
 * with another floor, and every consumer still validates the returned context
 * itself. Nothing is kept once a request settles, and requests carrying a
 * signal are never shared. A caller under a read floor (`withReadFloor`) joins
 * only a request sent after the floor was stamped; an older entry is replaced,
 * and its joiners keep their response.
 */
export function withJupiterLendReadSharing(send: typeof fetch): typeof fetch {
  const inFlight = new Map<string, { stamp: number; response: Promise<SharedResponse> }>();
  return async (input, init) => {
    const key = sharedReadKey(input, init);
    if (key === undefined) return send(input, init);
    const floor = readFloor();
    let shared = inFlight.get(key);
    if (shared && floor !== undefined && shared.stamp <= floor) shared = undefined;
    if (!shared) {
      const stamp = readStamp();
      const response = send(input, init).then(async (answer) => ({
        status: answer.status,
        statusText: answer.statusText,
        headers: answer.headers,
        body: await answer.text(),
      }));
      const entry = { stamp, response };
      const forget = () => {
        if (inFlight.get(key) === entry) inFlight.delete(key);
      };
      response.then(forget, forget);
      inFlight.set(key, entry);
      shared = entry;
    }
    const { status, statusText, headers, body } = await shared.response;
    const copied = new Headers(headers);
    copied.delete("content-length");
    copied.delete("content-encoding");
    return new Response(body, { status, statusText, headers: copied });
  };
}

const LENDING_PROGRAM = new PublicKey(JUPITER_LEND_EARN_PROGRAM_IDS["mainnet-beta"]);
const ASSET_MINT = new PublicKey(JUPITER_LEND_USDT.assetMint);
const SHARE_MINT = new PublicKey(JUPITER_LEND_USDT.shareMint);
const LENDING_ACCOUNT = lendingPda.getLending(ASSET_MINT, "main");
const LENDING_DISCRIMINATOR_BASE58 = "PiDuNSLmEPr";
const LENDING_DISCRIMINATOR = Buffer.from([135, 199, 82, 16, 249, 131, 182, 241]);
const LENDING_SHARE_MINT_OFFSET = 40;

function isMemcmp(filter: unknown, offset: number, bytes: string): boolean {
  if (filter === null || typeof filter !== "object") return false;
  const { memcmp, ...rest } = filter as { memcmp?: unknown };
  if (Object.keys(rest).length > 0 || memcmp === null || typeof memcmp !== "object") return false;
  const fields = memcmp as Record<string, unknown>;
  return Object.keys(fields).length === 2 && fields.offset === offset && fields.bytes === bytes;
}

/** The SDK's `getLendingData` scan for the admitted USDT market, and nothing else. */
function isUsdtLendingLookup(programId: PublicKey, config: GetProgramAccountsConfig): boolean {
  const { commitment: _commitment, filters, ...rest } = config;
  return (
    programId.equals(LENDING_PROGRAM) &&
    Object.keys(rest).length === 0 &&
    Array.isArray(filters) &&
    filters.length === 2 &&
    isMemcmp(filters[0], 0, LENDING_DISCRIMINATOR_BASE58) &&
    isMemcmp(filters[1], LENDING_SHARE_MINT_OFFSET, JUPITER_LEND_USDT.shareMint)
  );
}

/**
 * The read Connection handed to the SDK.
 *
 * `getLendingTokenDetails` finds the USDT lending account with a filtered
 * `getProgramAccounts`. Only the PDA [lending, USDT, jlUSDT] can match it:
 * `init_lending` creates every lending account at that seed, and jlUSDT is
 * itself the PDA [f_token_mint, USDT]. That exact query is therefore answered
 * by one read of the PDA, checked against the same filters; any other query,
 * or a PDA that does not match, runs the real scan.
 */
class JupiterLendConnection extends Connection {
  override getProgramAccounts(
    programId: PublicKey,
    configOrCommitment: GetProgramAccountsConfig & Readonly<{ withContext: true }>
  ): Promise<RpcResponseAndContext<GetProgramAccountsResponse>>;
  override getProgramAccounts(
    programId: PublicKey,
    configOrCommitment?: GetProgramAccountsConfig | Commitment
  ): Promise<GetProgramAccountsResponse>;
  override async getProgramAccounts(
    programId: PublicKey,
    configOrCommitment?: GetProgramAccountsConfig | Commitment
  ): Promise<GetProgramAccountsResponse | RpcResponseAndContext<GetProgramAccountsResponse>> {
    if (
      typeof configOrCommitment === "object" &&
      isUsdtLendingLookup(programId, configOrCommitment)
    ) {
      const account = await this.getAccountInfo(LENDING_ACCOUNT, configOrCommitment.commitment);
      if (
        account?.owner.equals(LENDING_PROGRAM) &&
        account.data.subarray(0, LENDING_DISCRIMINATOR.length).equals(LENDING_DISCRIMINATOR) &&
        account.data
          .subarray(LENDING_SHARE_MINT_OFFSET, LENDING_SHARE_MINT_OFFSET + 32)
          .equals(SHARE_MINT.toBuffer())
      ) {
        return [{ pubkey: LENDING_ACCOUNT, account }];
      }
    }
    return super.getProgramAccounts(programId, configOrCommitment);
  }
}

const CONNECTION_CAPACITY = 32;
const connections = new Map<string, Connection>();

/**
 * One Connection per RPC URL (the 32 most recently used), shared by every
 * Jupiter Lend operation so that concurrent owners share identical in-flight
 * reads. web3.js keeps no answers between calls and keeps its default 429
 * retries. The socket retry sits under the sharing layer, so one re-send
 * serves every joiner. Node's fetch has no use for web3.js's keep-alive agent.
 */
export function jupiterLendConnection(rpcUrl: string): Connection {
  const known = connections.get(rpcUrl);
  if (known) {
    connections.delete(rpcUrl);
    connections.set(rpcUrl, known);
    return known;
  }
  const connection = new JupiterLendConnection(rpcUrl, {
    commitment: "confirmed",
    fetch: withRpcReadContextFetch(withJupiterLendReadSharing(fetchWithReadSocketRetry)),
    httpAgent: false,
  });
  connections.set(rpcUrl, connection);
  if (connections.size > CONNECTION_CAPACITY) {
    const oldest = connections.keys().next().value;
    if (oldest !== undefined) connections.delete(oldest);
  }
  return connection;
}
