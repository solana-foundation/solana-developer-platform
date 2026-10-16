export function getPostgresMigrationMode(sql: string): "transactional" | "non-transactional";

/** Comment-stripped, trimmed statements of a migration file, in file order. */
export function splitSqlStatements(sql: string): string[];

type MigrationClient = {
  query(query: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

/** Defaults: a 5 s lock timeout and four retries, 1 to 8 s apart, after a lock timeout. */
type LockOptions = {
  lockTimeout?: string;
  lockRetryDelaysMs?: readonly number[];
};

export function applyPostgresMigration(
  input: {
    client: MigrationClient;
    migrationFile: string;
    sql: string;
  } & LockOptions
): Promise<void>;

export function applyRepeatableMigration(
  input: {
    client: MigrationClient;
    repeatableFile: string;
    sql: string;
  } & LockOptions
): Promise<void>;

export function ensureDatabaseExists(input: { databaseUrl: string }): Promise<void>;

export function runPostgresMigrations(input: {
  databaseUrl: string;
  migrationsDir: string;
}): Promise<void>;
