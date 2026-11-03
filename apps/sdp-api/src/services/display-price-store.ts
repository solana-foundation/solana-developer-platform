import { createHmac, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { z } from "zod";
import { getDisplayPriceRedisClient } from "@/runtime/kv-redis";
import {
  type DisplayPriceAnswer,
  displayPriceAnswerSchema,
  PRICE_CACHE_TTL_MS,
} from "@/services/tokens-xyz-price-client";
import type { Env } from "@/types/env";

// The provider allows 400/10s and 1,000/60s per key. Keep 20% headroom.
// Exact rolling windows use Redis time, so replicas cannot split the budget
// or bypass it with clock skew or a fixed-window boundary.
const ADMIT_REQUEST = `
local nowParts = redis.call('TIME')
local now = tonumber(nowParts[1]) * 1000 + math.floor(tonumber(nowParts[2]) / 1000)
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - 60000)
if redis.call('ZCARD', KEYS[1]) >= 800 then return 0 end
if redis.call('ZCOUNT', KEYS[1], '(' .. (now - 10000), '+inf') >= 320 then return 0 end
redis.call('ZADD', KEYS[1], now, ARGV[1])
redis.call('PEXPIRE', KEYS[1], 61000)
return 1
`;

// A cache read and ownership claim share one atomic operation. Confirmed
// absences are cached too; failures only release the short lease.
const LOOKUP = `
local out = {}
for i = 1, #KEYS, 2 do
  local cached = redis.call('GET', KEYS[i])
  if cached then
    table.insert(out, {'cached', cached})
  elseif ARGV[1] ~= '' and redis.call('SET', KEYS[i + 1], ARGV[1], 'NX', 'PX', 7000) then
    table.insert(out, {'claimed', ''})
  elseif redis.call('EXISTS', KEYS[i + 1]) == 1 then
    table.insert(out, {'pending', ''})
  else
    table.insert(out, {'missing', ''})
  end
end
return out
`;

// An expired owner cannot overwrite a newer result or delete its successor's
// lease. Publication and lease release are atomic for each completed batch.
const COMPLETE = `
for i = 1, #KEYS, 2 do
  if redis.call('GET', KEYS[i + 1]) == ARGV[1] then
    local raw = ARGV[2 + (i + 1) / 2]
    if raw ~= '' then redis.call('SET', KEYS[i], raw, 'PX', ARGV[2]) end
    redis.call('DEL', KEYS[i + 1])
  end
end
return 1
`;

const lookupResultSchema = z.array(
  z.tuple([z.enum(["cached", "claimed", "pending", "missing"]), z.string()])
);

/** Cached values, owned misses, and misses another replica is already fetching. */
export interface DisplayPriceClaim {
  readonly prices: Map<string, DisplayPriceAnswer>;
  readonly claimed: string[];
  readonly pending: string[];
}

/** Coordination boundary shared by every replica using one Tokens key. */
export interface DisplayPriceStore {
  lookup(mints: string[], owner: string | null): Promise<DisplayPriceClaim>;
  admitRequest(): Promise<boolean>;
  backOff(): Promise<void>;
  complete(
    mints: string[],
    owner: string,
    prices: ReadonlyMap<string, DisplayPriceAnswer>
  ): Promise<void>;
}

/** Shared data cache, mint leases and quota for one Tokens key and Redis backend. */
export class RedisDisplayPriceStore implements DisplayPriceStore {
  constructor(
    private readonly client: Promise<Redis>,
    private readonly prefix: string
  ) {}

  private mintKeys(mints: string[]): string[] {
    return mints.flatMap((mint) => [
      `${this.prefix}:price:${mint}`,
      `${this.prefix}:lease:${mint}`,
    ]);
  }

  /** Reads cached prices and optionally claims misses for one bounded lookup. */
  async lookup(mints: string[], owner: string | null): Promise<DisplayPriceClaim> {
    const client = await this.client;
    const keys = this.mintKeys(mints);
    const rows = lookupResultSchema.parse(
      await client.eval(LOOKUP, keys.length, ...keys, owner ?? "")
    );
    if (rows.length !== mints.length) throw new Error("Invalid shared price lookup result");
    const result: DisplayPriceClaim = { prices: new Map(), claimed: [], pending: [] };
    for (const [index, row] of rows.entries()) {
      const mint = mints[index];
      if (mint === undefined) throw new Error("Missing price lookup mint");
      const [state, raw] = row;
      if (state === "cached") {
        const price = displayPriceAnswerSchema.parse(JSON.parse(raw));
        if (price.expiresAt > Date.now()) result.prices.set(mint, price);
      } else if (state === "claimed") {
        result.claimed.push(mint);
      } else if (state === "pending") {
        result.pending.push(mint);
      }
    }
    return result;
  }

  /** Atomically reserves one upstream request across every replica sharing this key. */
  async admitRequest(): Promise<boolean> {
    const client = await this.client;
    return (
      (await client.eval(
        ADMIT_REQUEST,
        2,
        `${this.prefix}:requests`,
        `${this.prefix}:cooldown`,
        randomUUID()
      )) === 1
    );
  }

  /** Pause rejected credentials and 429s for a sustained window plus jitter. */
  async backOff(): Promise<void> {
    const client = await this.client;
    await client.set(
      `${this.prefix}:cooldown`,
      "1",
      "PX",
      60_000 + Math.floor(Math.random() * 1_000)
    );
  }

  /** Publishes confirmed answers and releases only this lookup's leases. */
  async complete(
    mints: string[],
    owner: string,
    prices: ReadonlyMap<string, DisplayPriceAnswer>
  ): Promise<void> {
    const client = await this.client;
    const keys = this.mintKeys(mints);
    const values = mints.map((mint) => {
      const price = prices.get(mint);
      return price && price.expiresAt > Date.now() ? JSON.stringify(price) : "";
    });
    await client.eval(COMPLETE, keys.length, ...keys, owner, PRICE_CACHE_TTL_MS, ...values);
  }
}

/** Never puts the provider credential into a Redis key, value or log. */
export function createDisplayPriceStore(env: Env, apiKey: string): DisplayPriceStore {
  // Derive a purpose-specific identifier from the provider-issued random key.
  // Replicas must derive the same namespace to share quota and cooldown state.
  const fingerprint = createHmac("sha256", apiKey).update("sdp:display-prices:v1").digest("hex");
  const worker = process.env.VITEST_POOL_ID;
  const namespace = worker ? `vitest-${worker}:` : "";
  return new RedisDisplayPriceStore(
    getDisplayPriceRedisClient(env),
    `${namespace}sdp:display-prices:v1:{${fingerprint}}:mainnet`
  );
}
