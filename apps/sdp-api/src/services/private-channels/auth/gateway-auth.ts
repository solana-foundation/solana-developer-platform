/**
 * SPC JWT session layer for Private Channels.
 *
 * The same bearer token (minted by the SPC AUTH service at `instance.authUrl`)
 * gates both Auth REST (challenge/verify/delete) and Gateway JSON-RPC (balances,
 * burns, tx lookups). See `./spc-session` for KV caching per (instance, SPC user).
 *
 * An SPC instance always has an auth service (enforced at connect time), so the
 * project must have an active principal — we fail with a clear error rather
 * than letting the gateway answer an opaque 401. Callers hold
 * an `SpcAuthContext` and run work through `withGatewayRpc` or `withSpcAuth`, each
 * of which retries ONCE on a strict 401 with a re-minted token.
 */

import { createAuthClient, type SpcAuthClient } from "@sdp/private-channels/auth";
import { PrivateChannelError } from "@sdp/private-channels/errors";
import { createChannelGatewayRpc } from "@sdp/private-channels/gateway";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { isUnauthorizedRpcError } from "@sdp/rpc/transient";
import type { PrivateChannelUserRow } from "@/db/repositories/private-channel-user.repository";
import { createPrivateChannelUserRepository } from "@/db/repositories/repository-factory";
import { forbidden } from "@/lib/errors";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { logVendorCallFailure } from "@/runtime/vendor-calls";
import {
  createPrivateChannelAuthFetch,
  createPrivateChannelGatewayTransport,
} from "@/services/private-channels/egress";
import type { Env } from "@/types/env";
import { getSpcSession } from "./spc-session";

/** Cap below the auth client's default so a degraded auth service can't stall a request. */
const SPC_AUTH_TIMEOUT_MS = 8_000;

/** The instance fields needed to mint a gateway token. */
interface GatewayAuthInstance {
  /** Instance id — the SPC-session cache is scoped per (instance, SPC user). */
  id: string;
  authUrl: string;
}

/**
 * A live SPC bearer token that can re-mint itself. `current` is the token to
 * send; `refresh()` re-logins (evicting the cached entry) and updates `current`.
 *
 * `pcUserId` is the member the token was minted for. Carried on the context so a
 * write path can persist the acting member alongside the row it creates: the
 * background reconciler later needs an SPC identity to read the gateway, and
 * re-deriving one from an on-chain address is ambiguous and sometimes impossible.
 */
export interface SpcAuthContext {
  current: string;
  refresh(): Promise<string>;
  pcUserId: string;
}

export interface ResolveGatewayAuthInput {
  instance: GatewayAuthInstance;
  organizationId: string;
  projectId: string;
  /** Actor attribution only. SPC authentication is project-principal scoped. */
  userId: string | null | undefined;
}

/** Best-effort KV `cache` store; `undefined` when Redis isn't configured. */
function tryGetCache(env: Env) {
  try {
    return createKVStoreSet(env).cache;
  } catch {
    // Both server entrypoints assert REDIS_URL, so this is a guard for partially
    // configured envs (tests, scripts) rather than a path production takes: no
    // Redis → no caching, fall back to a fresh login each call.
    return undefined;
  }
}

/**
 * Mint the initial SPC token through the KV read-through cache and wrap it in a
 * self-refreshing context. `refresh()` calls only `getSpcSession(forceRefresh)` —
 * it must NOT re-run membership/identity checks, or it would re-throw
 * `forbidden` instead of re-logging in.
 */
export async function openSpcAuthContext(
  env: Env,
  organizationId: string,
  instanceId: string,
  pcUser: PrivateChannelUserRow,
  client: SpcAuthClient
): Promise<SpcAuthContext> {
  const cache = tryGetCache(env);
  const session = (forceRefresh: boolean) =>
    getSpcSession(env, organizationId, pcUser, client, { cache, instanceId, forceRefresh });
  const { token } = await session(false);
  const context: SpcAuthContext = {
    current: token,
    refresh: async () => (context.current = (await session(true)).token),
    pcUserId: pcUser.id,
  };
  return context;
}

/**
 * Resolve an SPC auth context for a request. Auth is always required, so this
 * throws a descriptive `FORBIDDEN` when the project has no active SPC principal.
 */
export async function resolveGatewayAuth(
  env: Env,
  { instance, organizationId, projectId }: ResolveGatewayAuthInput
): Promise<SpcAuthContext> {
  const pcUser = await createPrivateChannelUserRepository(env).findDefaultPrincipal(
    { organizationId, projectId },
    instance.id
  );
  if (!pcUser) {
    throw forbidden("This project has no active Private Channels principal.");
  }

  const client = createAuthClient(instance.authUrl, {
    timeoutMs: SPC_AUTH_TIMEOUT_MS,
    fetchImpl: createPrivateChannelAuthFetch(env),
  });
  return openSpcAuthContext(env, organizationId, instance.id, pcUser, client);
}

/** Build the gateway RPC options for a bearer token. */
function gatewayAuthOptions(token: string) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

function isUnauthorizedAuthError(error: unknown): boolean {
  return error instanceof PrivateChannelError && error.code === "UNAUTHORIZED";
}

/**
 * Run a gateway RPC op with a context's token, retrying ONCE on a gateway 401 with a
 * re-minted token and a rebuilt client (the token is baked into the guarded
 * transport's headers at construction, so a rebuild is required).
 *
 * `run` must be the token-authenticated gateway sequence ONLY, never surrounding
 * business logic — on the withdrawal write path this re-runs a burn broadcast. That
 * is safe because `isUnauthorizedRpcError` is strict (status 401 only): a 401 is an
 * auth-middleware rejection BEFORE the gateway forwards the tx, so nothing reached
 * the channel chain and re-running (with a fresh blockhash) cannot double-burn.
 *
 * A refreshed-but-still-401 propagates (no loop). If `refresh()` itself throws (login
 * 401 / auth unavailable), that error surfaces — it is more actionable than the 401.
 */
export async function withGatewayRpc<T>(
  env: Env,
  gatewayUrl: string,
  context: SpcAuthContext,
  run: (rpc: SolanaRpc) => Promise<T>
): Promise<T> {
  const attempt = (token: string) =>
    run(
      createChannelGatewayRpc(env, gatewayUrl, {
        ...gatewayAuthOptions(token),
        // Egress-guarded transport: the factory receives the bearer-token headers
        // above, so the guarded transport dials with the same credentials kit
        // would have sent.
        transportFactory: (headers) =>
          createPrivateChannelGatewayTransport(env, gatewayUrl, headers),
      })
    );
  const startedAt = Date.now();
  try {
    return await attempt(context.current);
  } catch (error) {
    if (!isUnauthorizedRpcError(error)) {
      logVendorCallFailure("spc-gateway", "gateway-rpc", error, startedAt);
      throw error;
    }
    try {
      return await attempt(await context.refresh());
    } catch (retryError) {
      logVendorCallFailure("spc-gateway", "gateway-rpc", retryError, startedAt);
      throw retryError;
    }
  }
}

/**
 * Run an Auth REST op with a context's token, retrying ONCE on
 * `PrivateChannelError` code `UNAUTHORIZED` (HTTP 401) with a re-minted token.
 *
 * `run` must be the token-authenticated Auth sequence ONLY. For wallet verify the
 * unit is challenge → sign → verify (restarted from challenge on 401) because the
 * nonce is challenge-scoped. A still-401 second attempt propagates; a `refresh()`
 * failure surfaces instead of the original 401.
 */
export async function withSpcAuth<T>(
  context: SpcAuthContext,
  run: (token: string) => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await run(context.current);
  } catch (error) {
    if (!isUnauthorizedAuthError(error)) {
      logVendorCallFailure("spc-gateway", "auth-rest", error, startedAt);
      throw error;
    }
    try {
      return await run(await context.refresh());
    } catch (retryError) {
      logVendorCallFailure("spc-gateway", "auth-rest", retryError, startedAt);
      throw retryError;
    }
  }
}
