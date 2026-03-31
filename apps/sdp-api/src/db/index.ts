export {
  closeDatabasePools,
  createDatabaseClient,
  getConnectionString,
  getDb,
  type DatabaseBindings,
  type DatabaseClient,
  type DatabaseExecutor,
  type HyperdriveBinding,
  type PreparedStatement,
  type QueryManyResult,
} from "./client";

export type { DatabaseClient as AppDb, DatabaseBindings as AppDbBindings } from "./client";
