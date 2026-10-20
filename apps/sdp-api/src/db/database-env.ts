import { z } from "zod";
import type { Env } from "@/types/env";

const databaseEnvSchema = z.object({
  /**
   * `off` sends every statement unnamed, so PostgreSQL plans each one again
   * (see prepared-statements.ts). Unset leaves prepared statements on.
   */
  DATABASE_PREPARED_STATEMENTS: z.enum(["on", "off"]).optional(),
});

export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;

/**
 * Parse the database settings of the process environment. The server calls it
 * at startup, so a typo fails the boot instead of leaving the default in place.
 */
export function parseDatabaseEnv(env: Pick<Env, "DATABASE_PREPARED_STATEMENTS">): DatabaseEnv {
  return databaseEnvSchema.parse({
    DATABASE_PREPARED_STATEMENTS: env.DATABASE_PREPARED_STATEMENTS,
  });
}
