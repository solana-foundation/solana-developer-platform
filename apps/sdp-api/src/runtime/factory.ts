/**
 * Runtime factory — single dispatch point for runtime-specific implementations.
 *
 * HOO-506 lands only the Cloudflare branch. HOO-510 (#9) adds the Node/Redis
 * branch and switches on SDP_RUNTIME via getRuntime().
 */

import type { Env } from "@/types/env";
import type { KVStoreSet } from "./kv";
import { createWorkersKVStoreSet } from "./kv-workers";

export function createKVStoreSet(env: Env): KVStoreSet {
  return createWorkersKVStoreSet(env);
}
