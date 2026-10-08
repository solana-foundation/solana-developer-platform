import { getDb } from "@/db";
import { env } from "@/test/helpers/env";
import { required } from "@/test/helpers/required";

/** Tables a test proves a refused request left untouched, across every tenant. */
export type CountedTable = "payment_transfers" | "approval_requests" | "wallet_operations";

/**
 * Count every row in `table`, whatever its organization or project.
 *
 * @param table - The table to count.
 * @returns The table's row count.
 */
export async function countTableRows(table: CountedTable): Promise<number> {
  const row = await getDb(env)
    .prepare(`SELECT count(*) AS count FROM ${table}`)
    .first<{ count: number | string }>();
  return Number(required(row).count);
}
