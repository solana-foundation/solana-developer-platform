/**
 * Fixed entrypoint for the sdp-<env>-backoffice-ops Cloud Run job; the job's command is pinned to
 * `node backoffice-ops.js`. Parsing, the allowlist and the printable outcome live in
 * `src/services/backoffice-ops.ts`.
 *
 *   backoffice-ops mainnet-access status --organization-id <id>
 *   backoffice-ops mainnet-access reset --organization-id <id> --operator <who> --reason <why> --ticket <HOO-…>
 *   backoffice-ops mainnet-access set-country --organization-id <id> --country <CC> --operator … --reason … --ticket …
 */
import { closeDatabasePools } from "@/db/client";
import { runWithSystemDatabaseIdentity } from "@/db/identity";
import { getProcessEnv } from "@/lib/runtime-env";
import { closeAllRedisClients } from "@/runtime/kv-redis";
import { parseBackofficeCommand, runBackofficeCommand } from "@/services/backoffice-ops";

async function main(): Promise<void> {
  const command = parseBackofficeCommand(process.argv.slice(2));
  console.log(JSON.stringify(await runBackofficeCommand(getProcessEnv(), command), null, 2));
}

runWithSystemDatabaseIdentity("script:backoffice-ops", main)
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  // The audit ledger's checkpoint store holds a Redis client open; close it so the job exits.
  .finally(() => Promise.all([closeDatabasePools(), closeAllRedisClients()]));
