import { getDb } from "@/db/client";
import { env } from "@/test/helpers/env";
import { required } from "@/test/helpers/required";

/** How many stored answers the key holds; 0 means the request was refused before claiming it. */
export async function countStoredIdempotencyKeys(idempotencyKey: string): Promise<number> {
  const row = await getDb(env)
    .prepare("SELECT COUNT(*)::int AS count FROM idempotency_keys WHERE idempotency_key = ?")
    .bind(idempotencyKey)
    .first<{ count: number }>();
  return required(row).count;
}

/** Drops the key's stored answer, as its expiry does, so a same-key retry reaches the domain row. */
export async function expireIdempotencyKey(idempotencyKey: string): Promise<void> {
  await getDb(env).execute("DELETE FROM idempotency_keys WHERE idempotency_key = ?", [
    idempotencyKey,
  ]);
}
