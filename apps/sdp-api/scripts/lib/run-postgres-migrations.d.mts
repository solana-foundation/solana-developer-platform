export function ensureDatabaseExists(input: { databaseUrl: string }): Promise<void>;

export function runPostgresMigrations(input: {
  databaseUrl: string;
  migrationsDir: string;
}): Promise<void>;
