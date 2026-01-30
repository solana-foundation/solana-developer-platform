import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/pg";

export const createPgDrizzle = (connectionString: string) => {
  const pool = new Pool({ connectionString });
  return drizzle(pool, { schema });
};

export type PgDrizzleDb = ReturnType<typeof createPgDrizzle>;
