import { vi } from "vitest";
import { getDb } from "@/db";
import type { Env } from "@/types/env";

/**
 * Runs `run` and returns the SQL of every statement it prepared on the shared
 * database client, in order. Statements inside a `db.transaction` callback use
 * the transaction's own executor and are not listed.
 *
 * @param env - The test environment naming the database.
 * @param run - The work to record.
 * @returns What `run` returned and the statements it issued.
 */
export async function recordStatements<T>(
  env: Env,
  run: () => Promise<T>
): Promise<{ result: T; statements: string[] }> {
  const db = getDb(env);
  const prepare = db.prepare.bind(db);
  const statements: string[] = [];
  const spy = vi.spyOn(db, "prepare").mockImplementation((query) => {
    statements.push(query);
    return prepare(query);
  });
  try {
    return { result: await run(), statements };
  } finally {
    spy.mockRestore();
  }
}
