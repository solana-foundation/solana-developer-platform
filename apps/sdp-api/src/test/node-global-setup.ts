import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { runPostgresMigrations } from "../../scripts/lib/run-postgres-migrations.mjs";

const POSTGRES_IMAGE = "postgres:16-alpine";
const REDIS_IMAGE = "redis:7-alpine";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../db/migrations/postgres");

let postgres: StartedPostgreSqlContainer | undefined;
let redis: StartedRedisContainer | undefined;

export async function setup(): Promise<void> {
  try {
    const [postgresResult, redisResult] = await Promise.allSettled([
      new PostgreSqlContainer(POSTGRES_IMAGE).start(),
      new RedisContainer(REDIS_IMAGE).start(),
    ]);

    if (postgresResult.status === "fulfilled") postgres = postgresResult.value;
    if (redisResult.status === "fulfilled") redis = redisResult.value;

    if (postgresResult.status === "rejected" || redisResult.status === "rejected") {
      const failed = [postgresResult, redisResult]
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
      throw new Error(`Failed to start test containers: ${failed.join("; ")}`);
    }

    const databaseUrl = postgresResult.value.getConnectionUri();
    const redisUrl = `redis://${redisResult.value.getHost()}:${redisResult.value.getMappedPort(6379)}`;
    process.env.TEST_DATABASE_URL = databaseUrl;
    process.env.REDIS_URL = redisUrl;

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
  } catch (error) {
    await teardown();
    throw error;
  }
}

export async function teardown(): Promise<void> {
  process.off("SIGINT", handleSignal);
  process.off("SIGTERM", handleSignal);
  await Promise.allSettled([postgres?.stop(), redis?.stop()]);
  postgres = undefined;
  redis = undefined;
}

function handleSignal(): void {
  void teardown().finally(() => process.exit(1));
}
