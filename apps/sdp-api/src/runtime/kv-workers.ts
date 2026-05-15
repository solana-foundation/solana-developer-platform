/**
 * Cloudflare Workers KV implementation of KVStore.
 *
 * This file is the SOLE allowed read site for env.SDP_API_KEYS / SDP_RATE_LIMITS
 * / SDP_CACHE / SDP_SESSIONS in production code. The AC for HOO-506 enforces
 * this via grep — keep all KVNamespace binding reads here. Sister Redis impl
 * lands in HOO-510.
 */

import type { Env } from "@/types/env";
import type { KVListResult, KVPutOptions, KVStore, KVStoreSet } from "./kv";

export class WorkersKVStore implements KVStore {
  constructor(private readonly kv: KVNamespace) {}

  get(key: string): Promise<string | null>;
  get<T>(key: string, type: "json"): Promise<T | null>;
  get<T>(key: string, type?: "json"): Promise<string | T | null> {
    if (type === "json") {
      return this.kv.get<T>(key, "json");
    }
    return this.kv.get(key);
  }

  put(key: string, value: string, options?: KVPutOptions): Promise<void> {
    return this.kv.put(key, value, options);
  }

  delete(key: string): Promise<void> {
    return this.kv.delete(key);
  }

  async list(): Promise<KVListResult> {
    const result = await this.kv.list();
    return { keys: result.keys.map(({ name }) => ({ name })) };
  }
}

/**
 * Build a KVStoreSet from Cloudflare KV bindings.
 *
 * All four bindings are required on the Cloudflare runtime. Called per-request
 * from kvStoreMiddleware, so a missing binding throws on the first request
 * rather than at worker startup — but still up-front, before any handler runs,
 * instead of deep inside one via a `!` non-null assertion.
 */
export function createWorkersKVStoreSet(env: Env): KVStoreSet {
  const apiKeys = env.SDP_API_KEYS;
  const rateLimits = env.SDP_RATE_LIMITS;
  const cache = env.SDP_CACHE;
  const sessions = env.SDP_SESSIONS;
  if (!apiKeys || !rateLimits || !cache || !sessions) {
    const missing = [
      !apiKeys && "SDP_API_KEYS",
      !rateLimits && "SDP_RATE_LIMITS",
      !cache && "SDP_CACHE",
      !sessions && "SDP_SESSIONS",
    ]
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Cloudflare KV bindings missing for runtime=cloudflare: ${missing}. Configure them in wrangler.toml.`
    );
  }
  return {
    apiKeys: new WorkersKVStore(apiKeys),
    rateLimits: new WorkersKVStore(rateLimits),
    cache: new WorkersKVStore(cache),
    sessions: new WorkersKVStore(sessions),
  };
}
