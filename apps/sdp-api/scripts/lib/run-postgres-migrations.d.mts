export function getPostgresMigrationMode(sql: string): "transactional" | "non-transactional";

/** Comment-stripped, trimmed statements of a migration file, in file order. */
export function splitSqlStatements(sql: string): string[];

export function applyPostgresMigration(input: {
  client: {
    query(query: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  };
  migrationFile: string;
  sql: string;
}): Promise<void>;

export function ensureDatabaseExists(input: { databaseUrl: string }): Promise<void>;

export function runPostgresMigrations(input: {
  databaseUrl: string;
  migrationsDir: string;
}): Promise<void>;
