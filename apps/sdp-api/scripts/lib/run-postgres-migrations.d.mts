export function getPostgresMigrationMode(sql: string): "transactional" | "non-transactional";

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
