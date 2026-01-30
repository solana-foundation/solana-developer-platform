import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema/sqlite";

export const createD1Drizzle = (db: D1Database) => drizzle(db, { schema });

export type D1DrizzleDb = ReturnType<typeof createD1Drizzle>;
