import {
  apiPort,
  databaseUrl,
  describeEnvSource,
  exitOnStartupError,
  localEnv,
  redisUrl,
  run,
  waitForDataStores,
  watchServer,
} from "./lib/dev-env.mjs";

const shouldResetLocalState =
  (localEnv.SDP_API_RESET_LOCAL_STATE ?? process.env.SDP_API_RESET_LOCAL_STATE) === "1";
const localRedisKeysPreservedAcrossRestarts = new Set(["cache:audit-ledger:checkpoint:v1"]);

async function resetLocalRedisState(url) {
  const parsed = new URL(url);
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (!loopbackHosts.has(parsed.hostname)) {
    throw new Error(
      "SDP_API_RESET_LOCAL_STATE=1 is restricted to loopback Redis instances to protect shared data."
    );
  }

  const { default: Redis } = await import("ioredis");
  const client = new Redis(url, { maxRetriesPerRequest: 1 });
  try {
    for (const prefix of ["apiKeys", "rateLimits", "cache"]) {
      let cursor = "0";
      const keysToDelete = new Set();
      do {
        const [nextCursor, keys] = await client.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 100);
        for (const key of keys) {
          if (!localRedisKeysPreservedAcrossRestarts.has(key)) {
            keysToDelete.add(key);
          }
        }
        cursor = nextCursor;
      } while (cursor !== "0");

      // Redis SCAN does not guarantee a stable cursor while the keyspace is
      // being mutated. Collect the complete local-only namespace first so a
      // reset cannot skip keys while isolated test shards restart. The audit
      // checkpoint is deliberately preserved because its Postgres ledger is
      // append-only and survives the same restart.
      const keys = [...keysToDelete];
      for (let index = 0; index < keys.length; index += 500) {
        await client.unlink(...keys.slice(index, index + 500));
      }
    }
  } finally {
    await client.quit();
  }
}

// The API owns local setup (Redis reset, migrations) and runs without cron,
// like the deployed API service; scripts/dev-worker.mjs runs the cron.
try {
  console.log(`Environment: ${describeEnvSource()}`);
  await waitForDataStores();

  if (shouldResetLocalState) {
    await resetLocalRedisState(redisUrl);
  }

  await run("node", ["scripts/migrate-postgres.mjs"], { DATABASE_URL: databaseUrl });
  await watchServer({ port: apiPort, disableCron: "true" });
} catch (error) {
  exitOnStartupError(error);
}
