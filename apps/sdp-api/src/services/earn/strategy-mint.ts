import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import { address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { fetchMaybeMint, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { badRequest } from "@/lib/errors";

const facts = new Map<string, { decimals: number; expiresAt: number }>();
const reads = new Map<string, Promise<number>>();
const TTL_MS = 15 * 60_000;
const MAX_ENTRIES = 1_000;

/** Mint precision is immutable after initialization; failures are never cached. */
export async function strategyShareDecimals(mint: string): Promise<number> {
  const key = `${currentClusterScope().cluster}:${mint}`;
  const cached = facts.get(key);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.decimals;
  const pending = reads.get(key);
  if (pending !== undefined) return pending;
  const read = (async () => {
    const account = await fetchMaybeMint(createClusterRpc(), address(mint));
    if (
      !account.exists ||
      !account.data.isInitialized ||
      (account.programAddress !== TOKEN_PROGRAM_ADDRESS &&
        account.programAddress !== TOKEN_2022_PROGRAM_ADDRESS)
    ) {
      throw badRequest("Strategy share mint is unavailable");
    }
    if (facts.size >= MAX_ENTRIES) {
      const oldest = facts.keys().next().value;
      if (oldest !== undefined) facts.delete(oldest);
    }
    facts.set(key, { decimals: account.data.decimals, expiresAt: Date.now() + TTL_MS });
    return account.data.decimals;
  })();
  reads.set(key, read);
  try {
    return await read;
  } finally {
    reads.delete(key);
  }
}
